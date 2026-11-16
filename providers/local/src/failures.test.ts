/**
 * W34 review fixes: how a local endpoint's failures are classified (offline only before the endpoint answered, a
 * connect timeout is offline, an idle socket is a timeout), the Settings probe's short timeout, and native session
 * histories that survive a restart and a failed turn. Stub servers on 127.0.0.1 port 0; no network, no binaries.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvent, TurnInput } from '@pasabot/core';
import { fetchLocalModel } from '@pasabot/safe-net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { deadUrl, ollamaStub, type Stub } from './__fixtures__/stub.js';
import { isUnreachable, type LocalEndpoint, LocalModelAdapter, trimHistory } from './adapter.js';
import { createLocalModule } from './server.js';

const servers: Server[] = [];
const netServers: NetServer[] = [];
const sockets: Socket[] = [];
const stubs: Stub[] = [];
const homes: string[] = [];
let s: TestServer | null = null;
afterEach(async () => {
  for (const x of servers.splice(0))
    await new Promise<void>((r) => {
      x.closeAllConnections?.();
      x.close(() => r());
    });
  for (const x of sockets.splice(0)) x.destroy();
  for (const x of netServers.splice(0)) await new Promise<void>((r) => x.close(() => r()));
  for (const x of stubs.splice(0)) await x.close();
  await s?.close();
  s = null;
  for (const h of homes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
    rmSync(`${h}-accounts`, { recursive: true, force: true });
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : undefined));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const endpoint = (url: string): LocalEndpoint => ({
  id: 'x',
  name: 'Stub',
  api: 'ollama',
  baseUrl: url,
  origin: url,
  scope: 'loopback',
  tools: 'auto',
});
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

async function turn(a: LocalModelAdapter, text: string, o: Partial<TurnInput> = {}) {
  const out: ProviderEvent[] = [];
  const input = {
    runId: `r${Math.random().toString(36).slice(2)}`,
    agent: { id: 'a', trustLevel: 'standard' } as TurnInput['agent'],
    workspaceDir: '/tmp',
    systemPrompt: 'You are a test.',
    user: { text, attachments: [], from: { kind: 'owner', id: 'u', name: 'Owner', trust: 'trusted' } },
    mcp: { url: '', bearer: '' },
    tools: 'none',
    env: {},
    model: 'm',
    ...o,
  } as TurnInput;
  for await (const e of a.runTurn(input, new AbortController().signal)) out.push(e);
  return out;
}
const errorOf = (ev: ProviderEvent[]) => ev.find((e) => e.type === 'error') as { kind: string } | undefined;

async function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('offline only before the endpoint answered (no rerun over side effects)', () => {
  it('a connection dropped in round 2, after a tool already ran through the gateway, is a crash', async () => {
    let chats = 0;
    const url = await serve((req, res) => {
      if (req.url !== '/api/chat') return res.end('{}');
      chats++;
      if (chats === 1) {
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(
          line({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'echo', arguments: { t: 1 } } }],
            },
          }),
        );
        return res.end(line({ message: { role: 'assistant', content: '' }, done: true }));
      }
      req.socket.destroy(); // the model server ran out of memory
    });
    const toolCalls: string[] = [];
    const gateway = await serve((_req, res, body) => {
      res.setHeader('content-type', 'application/json');
      if (body.method === 'tools/list')
        return res.end(JSON.stringify({ result: { tools: [{ name: 'echo' }] } }));
      toolCalls.push(body.params.name);
      res.end(JSON.stringify({ result: { content: [{ text: 'done' }] } }));
    });
    const a = new LocalModelAdapter(endpoint(url));
    const ev = await turn(a, 'post it', { tools: 'gateway', mcp: { url: `${gateway}/mcp`, bearer: 'b' } });
    expect(toolCalls).toEqual(['echo']);
    expect(ev.some((e) => e.type === 'tool.result')).toBe(true);
    expect(errorOf(ev)?.kind).toBe('crash');
    expect(ev.some((e) => e.type === 'session')).toBe(false);
  });

  it('a stream dropped after the first text is a crash; a refused first request is offline', async () => {
    const url = await serve((req, res) => {
      if (req.url !== '/api/chat') return res.end('{}');
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(line({ message: { role: 'assistant', content: 'half an ans' }, done: false }), () =>
        setTimeout(() => res.socket?.destroy(), 20),
      );
    });
    const dropped = await turn(new LocalModelAdapter(endpoint(url)), 'hi');
    expect(dropped.some((e) => e.type === 'text.delta')).toBe(true);
    expect(errorOf(dropped)?.kind).toBe('crash');
    const refused = await turn(new LocalModelAdapter(endpoint(await deadUrl())), 'hi');
    expect(errorOf(refused)?.kind).toBe('offline');
  });
});

describe('timeouts', () => {
  it('a connect that does not finish in time is ETIMEDOUT, which reads as unreachable', async () => {
    // a TCP listener that never speaks TLS: the https connect phase (handshake included) never completes
    const silent = createNetServer((sock) => sockets.push(sock));
    netServers.push(silent);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const t0 = Date.now();
    const err = await fetchLocalModel(`${url}/api/tags`, { allowed: [url], connectTimeoutMs: 200 }).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(isUnreachable(err)).toBe(true);
    expect(isUnreachable({ code: 'ESOCKETTIMEDOUT' })).toBe(false);
  });

  it('a socket that connected and then went quiet is a timeout, not a crash and not offline', async () => {
    const url = await serve(() => {
      /* never answers */
    });
    const ev = await turn(new LocalModelAdapter(endpoint(url), { timeoutMs: 200 }), 'hi');
    expect(errorOf(ev)?.kind).toBe('timeout');
  });

  it('Settings → models answers within the short probe timeout even though turns may wait 120 s', async () => {
    const url = await serve(() => {
      /* never answers */
    });
    const home = mkdtempSync(join(tmpdir(), 'pasabot-w34-'));
    homes.push(home);
    s = await bootTestServer({ home, modules: [createLocalModule({ candidates: [] })] });
    const owner = seedUser(s.db);
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${s!.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${owner.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
    const ep = await call('POST', '/api/m/local/endpoints', { name: 'Hung', api: 'ollama', url });
    expect(ep.status).toBe(200);
    const t0 = Date.now();
    const models = await call('GET', `/api/m/local/endpoints/${ep.json.endpoint.id}/models`);
    expect(Date.now() - t0).toBeLessThan(9000);
    expect(models.json.reachable).toBe(false);
  }, 20_000);
});

describe('native session history', () => {
  it('a failed turn never hands out a ref; the next turn still has the earlier conversation', async () => {
    let fail = false;
    const seen: any[] = [];
    const url = await serve((req, res, body) => {
      if (req.url !== '/api/chat') return res.end('{}');
      seen.push(body.messages);
      if (fail) return req.socket.destroy();
      res.setHeader('content-type', 'application/x-ndjson');
      const last = body.messages.at(-1).content;
      res.end(line({ message: { role: 'assistant', content: `ok: ${last}` }, done: true }));
    });
    const a = new LocalModelAdapter(endpoint(url));
    const first = await turn(a, 'my name is Ana');
    const ref = (first.find((e) => e.type === 'session') as { nativeRef: string }).nativeRef;
    fail = true;
    const second = await turn(a, 'lost turn', { nativeRef: ref });
    expect(second.some((e) => e.type === 'session')).toBe(false);
    fail = false;
    const third = await turn(a, 'what is my name?', { nativeRef: ref });
    expect(third.find((e) => e.type === 'session')).toEqual({ type: 'session', nativeRef: ref });
    expect(seen.at(-1).map((m: any) => m.content)).toContain('my name is Ana');
  });

  it('a PasaBot restart keeps the conversation of a resumed local-model session', async () => {
    const stub = await ollamaStub();
    stubs.push(stub);
    const home = mkdtempSync(join(tmpdir(), 'pasabot-w34-'));
    homes.push(home);
    const start = async () => {
      s = await bootTestServer({ home, modules: [createLocalModule({ candidates: [], timeoutMs: 3000 })] });
      const owner = seedUser(s.db);
      return (method: string, path: string, body?: unknown) =>
        fetch(`${s!.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${owner.token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as any }));
    };
    const finals = (chat: string) =>
      s!.db
        .prepare("SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'agent' AND status = 'final'")
        .all(chat) as { body: string }[];
    let call = await start();
    const ep = await call('POST', '/api/m/local/endpoints', { name: 'Ollama', api: 'ollama', url: stub.url });
    const providerId = ep.json.endpoint.providerId as string;
    const agent = seedAgent(s!.db, { providerId, trust: 'trusted' });
    s!.db.prepare('UPDATE agents SET model = ? WHERE id = ?').run('chatty:latest', agent);
    const owner = s!.db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string };
    const chat = seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
    expect(
      (await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'remember the word kalabasa' })).status,
    ).toBeLessThan(300);
    await until(() => finals(chat).length === 1);
    await s!.close();
    s = null;

    call = await start();
    expect(
      (await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'which word?' })).status,
    ).toBeLessThan(300);
    await until(() => finals(chat).length === 2);
    const last = stub.requests.filter((r) => r.path === '/api/chat').at(-1)!;
    const texts = last.body.messages.map((m: any) => String(m.content));
    expect(texts.some((t: string) => t.includes('remember the word kalabasa'))).toBe(true);
    expect(texts.at(-1)).toContain('which word?');
  }, 20_000);

  it('history is trimmed at a user message, never leaving an orphaned tool result first', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 't', arguments: {} } }] },
      { role: 'tool', content: 'r' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ] as Parameters<typeof trimHistory>[0];
    expect(trimHistory(msgs, 4).map((m) => m.content)).toEqual(['c', 'd']);
    expect(trimHistory(msgs, 2).map((m) => m.content)).toEqual(['c', 'd']);
    expect(trimHistory(msgs.slice(0, 4), 2).map((m) => m.content)).toEqual(['a', '', 'r', 'b']);
  });
});
