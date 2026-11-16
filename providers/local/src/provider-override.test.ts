/**
 * `providerOverride` is server-only (collab's silent-lead backup): a payload that carries one from any other module,
 * or from a person's message, has it dropped at the boundary, so it can neither route a routine around the free-model
 * gate nor send a turn to a brain the agent is not configured for. Port 0 on 127.0.0.1, a temp home, Fake brains.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModule, type ModuleHost, type ProviderAdapter, type TurnInput } from '@pasabot/core';
import { createTemplatesModule } from '@pasabot/mod-templates/server';
import { FakeProvider, type Script } from '@pasabot/provider-fake';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-override-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let s: TestServer | null = null;
afterEach(async () => {
  await s?.cleanup();
  s = null;
});

async function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}
function api(token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s!.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
}
const reply = (text: string): Script => [
  { event: { type: 'session', nativeRef: `s-${Math.random().toString(36).slice(2, 8)}` } },
  { event: { type: 'text.final', text } },
  { event: { type: 'done', stop: 'end' } },
];
const limited: Script = [
  { event: { type: 'error', kind: 'rate_limit', message: '429 Too Many Requests' } },
  { event: { type: 'done', stop: 'error' } },
];
function brain(id: string, script: () => Script) {
  const inner = new FakeProvider({ script: () => script(), deltaMs: 1 });
  const a: ProviderAdapter & { inputs: TurnInput[] } = {
    id: id as ProviderAdapter['id'],
    displayName: `${id} (fake)`,
    inputs: [],
    detect: async () => ({ installed: true, version: '0.0.0-fake', signedIn: 'unknown' }),
    capabilities: () => inner.capabilities(),
    runTurn(input, signal) {
      a.inputs.push(input);
      return inner.runTurn(input, signal);
    },
  };
  return a;
}
const stubInstaller = (_app: unknown, binDir: string) => ({
  describe: () => ({
    what: 'OpenCode CLI',
    where: join(binDir, 'opencode'),
    from: 'https://example.invalid/r',
  }),
  async install({ consent }: { consent: boolean }) {
    if (!consent) throw new Error('no consent');
    const bin = join(tmp, `opencode-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { binPath: bin, version: 'v0.0.0-stub' };
  },
});
/** a module that is not collab and tries to pick the brain itself */
let sneakyHost: ModuleHost | null = null;
const sneaky = (id: string) =>
  defineModule({
    id,
    async register(app) {
      sneakyHost = app;
    },
  });
const payloadOf = (id: string) =>
  JSON.parse(
    (s!.db.prepare('SELECT payload FROM queue_items WHERE id = ?').get(id) as { payload: string }).payload,
  );

describe('providerOverride is server-only', () => {
  it('a module other than collab cannot route a routine around the free-model gate onto another brain', async () => {
    const free = brain('opencode', () => limited);
    const paid = brain('fake', () => reply('paid answer'));
    s = await bootTestServer({
      providers: [paid],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-a'),
          installer: stubInstaller,
          makeOpenCode: () => free,
        }),
        sneaky('sneaky'),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const a = await call('POST', '/api/v1/agents', {
      name: 'Free',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });
    // close the free model's gate with one real 429
    await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, { text: 'close the gate' });
    await until(
      () => (s!.db.prepare("SELECT 1 FROM queue_items WHERE state = 'held'").get() as unknown) ?? false,
    );
    const { item } = sneakyHost!.queue.enqueue({
      agentId: a.json.agent.id,
      chatId: a.json.chatId,
      kind: 'routine',
      payload: {
        text: 'run me on the paid brain',
        providerOverride: { providerId: 'fake', model: 'fake-large' },
      },
      source: { sender: { kind: 'system', id: null, name: 'sneaky', trust: 'guarded' } },
    });
    expect(payloadOf(item.id)).toEqual({ text: 'run me on the paid brain' });
    const done = await until(() => {
      const st = s!.queue.get(item.id)?.state;
      return st && !['queued', 'running', 'held'].includes(st) ? st : null;
    });
    expect(done).toBe('cancelled'); // refused by the free-model gate
    expect(paid.inputs).toHaveLength(0);
  }, 30_000);

  it('a module other than collab cannot send a turn to a brain the agent is not configured for', async () => {
    const own = brain('fake', () => reply('own brain'));
    const other = brain('other', () => reply('other brain'));
    s = await bootTestServer({ providers: [own, other], modules: [sneaky('sneaky')] });
    const call = api(seedUser(s.db).token);
    const a = await call('POST', '/api/v1/agents', { name: 'Tala', providerId: 'fake' });
    const { item } = sneakyHost!.queue.enqueue({
      agentId: a.json.agent.id,
      chatId: a.json.chatId,
      kind: 'message',
      payload: { text: 'hi', providerOverride: { providerId: 'other' } },
      source: { sender: { kind: 'system', id: null, name: 'sneaky', trust: 'guarded' } },
    });
    await until(() => s!.queue.get(item.id)?.state === 'done');
    expect(own.inputs).toHaveLength(1);
    expect(other.inputs).toHaveLength(0);
  }, 30_000);

  it('collab (the one allowed module) keeps it; a person posting it in a message body never does', async () => {
    const own = brain('fake', () => reply('own brain'));
    const other = brain('other', () => reply('other brain'));
    s = await bootTestServer({ providers: [own, other], modules: [sneaky('collab')] });
    const owner = seedUser(s.db);
    const call = api(owner.token);
    const a = await call('POST', '/api/v1/agents', { name: 'Tala', providerId: 'fake' });
    const { item } = sneakyHost!.queue.enqueue({
      agentId: a.json.agent.id,
      chatId: a.json.chatId,
      kind: 'message',
      payload: { text: 'backup answer', providerOverride: { providerId: 'other' } },
      source: { sender: { kind: 'system', id: null, name: 'collab', trust: 'guarded' } },
    });
    expect(payloadOf(item.id).providerOverride).toEqual({ providerId: 'other' });
    await until(() => s!.queue.get(item.id)?.state === 'done');
    expect(other.inputs).toHaveLength(1);
    // the owner's own message route builds its payload from known fields only
    const m = await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, {
      text: 'use the other one',
      providerOverride: { providerId: 'other' },
    });
    expect(m.status, JSON.stringify(m.json)).toBeLessThan(300);
    const rows = s.db
      .prepare("SELECT payload FROM queue_items WHERE agent_id = ? AND payload LIKE '%use the other one%'")
      .all(a.json.agent.id) as { payload: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).providerOverride).toBeUndefined();
  }, 30_000);
});
