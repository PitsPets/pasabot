/**
 * Wave 5 gap (W22/W34), the onboarding's local model: found on loopback, added only by the owner (an agent
 * never can). It boots the templates module beside this one, so it lives here and not in modules/templates
 * (templates must not depend on this provider: the workspace build would form a cycle). Port 0 on 127.0.0.1,
 * temp homes, no network, no real CLI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemplatesModule, type TemplatesModuleOptions } from '@pasabot/mod-templates/server';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createLocalModule } from './server.js';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-local-onboarding-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let s: TestServer | null = null;
const servers: Server[] = [];
afterEach(async () => {
  await s?.cleanup();
  s = null;
  await Promise.all(servers.splice(0).map((x) => new Promise<void>((r) => x.close(() => r()))));
});

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

/** the templates installer is never reached here; a stub keeps the test off the network */
const stubInstaller: NonNullable<TemplatesModuleOptions['installer']> = (_app, binDir) => ({
  describe: () => ({
    what: 'OpenCode CLI',
    where: join(binDir, 'opencode'),
    from: 'https://example.invalid/r',
  }),
  async install() {
    throw new Error('not used in this test');
  },
});

/** just enough of Ollama on 127.0.0.1 port 0 for detection: one model */
async function tinyOllama() {
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'chatty:latest' }] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe('onboarding: the local model option', () => {
  it('a loopback endpoint that answers is offered; only the owner can add it; an agent never can', async () => {
    const url = await tinyOllama();
    s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-l'),
          installer: stubInstaller,
        } as TemplatesModuleOptions),
        createLocalModule({ candidates: [{ api: 'ollama', url, name: 'Ollama' }], timeoutMs: 3000 }),
      ],
    });
    const call = api(seedUser(s.db).token);
    const found = (await call('GET', '/api/m/local/detect')).json.found;
    expect(found).toEqual([{ name: 'Ollama', api: 'ollama', url, models: 1 }]);
    // the agent cannot add a local URL: its run bearer is refused and no tool takes one
    const agent = seedAgent(s.db);
    const asAgent = api(seedRunToken(s.db, agent).token);
    const sneaky = { name: 'sneaky', api: 'ollama', url, tools: 'auto' };
    expect([401, 403]).toContain((await asAgent('POST', '/api/m/local/endpoints', sneaky)).status);
    expect([401, 403]).toContain((await asAgent('GET', '/api/m/local/detect')).status);
    const tools = s.tools.list().map((t: { name: string }) => t.name);
    expect(tools.filter((n: string) => /local|endpoint/i.test(n))).toEqual([]);
    expect((await call('GET', '/api/m/local/endpoints')).json.endpoints).toEqual([]);
    // the owner's click (what the onboarding card sends) adds it; the Brain picker then lists it by its name
    const add = await call('POST', '/api/m/local/endpoints', {
      name: 'Ollama',
      api: 'ollama',
      url,
      tools: 'auto',
    });
    expect(add.status, JSON.stringify(add.json)).toBe(200);
    const brains = (await call('GET', '/api/v1/providers')).json.providers as {
      id: string;
      displayName: string;
    }[];
    expect(brains.find((p) => p.id === add.json.endpoint.providerId)?.displayName).toBe('Ollama');
    // once added it is no longer offered again
    expect((await call('GET', '/api/m/local/detect')).json.found).toEqual([]);
  });
});
