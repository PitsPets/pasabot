import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  seedAgent,
  seedAutomationToken,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');

describe('test:sdk (server)', () => {
  let s: TestServer;
  let session: string;
  let automation: string;
  let run: string;
  const get = (path: string, token?: string) =>
    fetch(`${s.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    s = await bootTestServer({ root });
    session = seedUser(s.db).token;
    const agent = seedAgent(s.db);
    automation = seedAutomationToken(s.db, agent);
    run = seedRunToken(s.db, agent).token;
  });
  afterAll(() => s.cleanup());

  it('discovers the example module and the fake provider', () => {
    expect(s.modules).toContain('_example');
    expect(s.providers.get('fake')).toBeDefined();
    expect(s.packages.map((p) => p.pasabot.kind)).toEqual(expect.arrayContaining(['module', 'provider']));
  });

  it('the Fake brain is test-only: a normal server never loads it, tests and PASABOT_TEST_BRAINS=1 do', async () => {
    const { testPackagesAllowed } = await import('./server.js');
    expect(s.packages.find((p) => p.id === 'fake')?.pasabot.testOnly).toBe(true);
    expect(testPackagesAllowed({})).toBe(false);
    expect(testPackagesAllowed({ PASABOT_TEST_BRAINS: '0' })).toBe(false);
    expect(testPackagesAllowed({ VITEST: 'true' })).toBe(true);
    expect(testPackagesAllowed({ PASABOT_TEST_BRAINS: '1' })).toBe(true);
    // only the Fake brain is marked: every real brain still loads on a normal server
    expect(s.packages.filter((p) => p.pasabot.testOnly).map((p) => p.id)).toEqual(['fake']);
  });

  it('discovery root comes from the server location, not the cwd', async () => {
    const { findServerRoot } = await import('./discovery.js');
    expect(findServerRoot(import.meta.dirname)).toBe(root);
    const prefix = mkdtempSync(join(tmpdir(), 'pasabot-prefix-'));
    try {
      const self = join(prefix, 'node_modules', '@pasabot', 'server', 'dist', 'host');
      mkdirSync(self, { recursive: true });
      expect(findServerRoot(self)).toBe(prefix);
      expect(findServerRoot(join(prefix, 'elsewhere'))).toBeNull();
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("discovers 'channel' packages and registers them in the ChannelRegistry", async () => {
    const c = await bootTestServer({ root: join(import.meta.dirname, '__fixtures__', 'channel-root') });
    try {
      expect(c.packages.map((p) => p.pasabot.kind)).toEqual(['channel']);
      expect(c.channels.get('fakechan')?.kind).toBe('fakechan');
    } finally {
      await c.cleanup();
    }
  });

  it('a route per auth kind accepts only that kind', async () => {
    const tokens = { session, automation, run } as const;
    for (const route of ['session', 'automation', 'run'] as const) {
      for (const [kind, token] of Object.entries(tokens)) {
        const r = await get(`/api/m/_example/whoami/${route}`, token);
        expect(r.status, `${kind} on ${route}`).toBe(kind === route ? 200 : 401);
        if (kind === route) expect(await r.json()).toEqual({ kind });
      }
      expect((await get(`/api/m/_example/whoami/${route}`)).status).toBe(401);
      expect((await get(`/api/m/_example/whoami/${route}`, 'not-a-token')).status).toBe(401);
    }
  });

  it('module table: migration applied with prefix, route writes and reads it', async () => {
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_example\\_%' ESCAPE '\\'")
      .all();
    expect(tables).toEqual([{ name: '_example_note' }]);
    const post = await fetch(`${s.url}/api/m/_example/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'kumusta' }),
    });
    expect(post.status).toBe(201);
    const bad = await fetch(`${s.url}/api/m/_example/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(bad.status).toBe(400);
    const list = (await (await get('/api/m/_example/notes', automation)).json()) as {
      notes: { text: string }[];
    };
    expect(list.notes.map((n) => n.text)).toEqual(['kumusta']);
  });

  it('public hook: no auth, body limit 413, rate limit 429 with Retry-After', async () => {
    const hook = (body: string) =>
      fetch(`${s.url}/hooks/_example/ping`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain' },
      });
    expect((await hook('x'.repeat(2048))).status).toBe(413); // 1/3
    const ok = await hook('hello'); // 2/3
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ received: 5 });
    expect((await hook('again')).status).toBe(202); // 3/3
    const limited = await hook('flood');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('sites file is served only on the other origin, with the sandbox CSP', async () => {
    expect(new URL(s.sitesUrl).port).not.toBe(new URL(s.url).port);
    const r = await fetch(`${s.sitesUrl}/_example/hello.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(await r.text()).toContain('hello from _example');
    expect((await fetch(`${s.url}/_example/hello.html`)).status).toBe(404);
    const missing = await fetch(`${s.sitesUrl}/_example/nope.html`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect((await fetch(`${s.sitesUrl}/_example/..%2F..%2Fpasabot.db`)).status).toBe(404);
  });

  it('sites origin never serves files outside sites/<module>/ (raw socket, no URL normalisation)', async () => {
    // fetch/inject normalise `..`, so speak raw HTTP like `curl --path-as-is`
    const raw = (path: string) =>
      new Promise<string>((done, fail) => {
        const u = new URL(s.sitesUrl);
        const sock = connect(Number(u.port), u.hostname, () => {
          sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        let out = '';
        sock.on('data', (d) => {
          out += d.toString('latin1');
        });
        sock.on('end', () => done(out));
        sock.on('error', fail);
      });
    writeFileSync(join(s.home, 'sites', 'secret.txt'), 'TOP-SECRET');
    for (const path of [
      '/%2e%2e/pasabot.db',
      '/../pasabot.db',
      '/%2E%2E/pasabot.db',
      '/./../pasabot.db',
      '/%2e%2e%2fpasabot.db',
      '/_example/%2e%2e/%2e%2e/pasabot.db',
      '/_example/..%5c..%5cpasabot.db',
      '/./secret.txt',
      '/%2e/secret.txt',
      '/_example/../secret.txt',
      '/_example/%2e%2e/secret.txt',
      '/%00/secret.txt',
      '/%zz/secret.txt',
    ]) {
      const res = await raw(path);
      expect(res.split('\r\n')[0], path).not.toMatch(/ 200 /);
      expect(res, path).not.toContain('SQLite format');
      expect(res, path).not.toContain('TOP-SECRET');
    }
    expect((await raw('/_example/hello.html')).split('\r\n')[0]).toMatch(/ 200 /);
  });

  it('tool is registered and validates input/output', async () => {
    expect(s.tools.get('example_echo')?.tier).toBe(0);
    const ctx = {} as never;
    expect(await s.tools.invoke('example_echo', { text: 'hi' }, ctx)).toEqual({ echo: 'hi' });
    await expect(s.tools.invoke('example_echo', { text: 1 }, ctx)).rejects.toThrow();
  });

  it('block kind validates its data; unknown kinds fall back', () => {
    expect(s.blocks.validate({ kind: '_example.note', v: 1, data: { text: 'hi' } })).toEqual({ ok: true });
    expect(s.blocks.validate({ kind: '_example.note', v: 1, data: { text: 3 } })).toEqual({
      ok: false,
      reason: 'invalid_data',
    });
    expect(s.blocks.validate({ kind: 'nobody.thing', v: 1, data: {} })).toEqual({
      ok: false,
      reason: 'unknown_kind',
    });
  });

  it('event published by the module reaches a WS subscriber of its topic', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: session });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['module:_example'] });
    ws.send({ t: 'ping', n: 1 });
    await ws.next((f) => f.t === 'pong');
    const r = await fetch(`${s.url}/api/m/_example/ping`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}` },
    });
    const { seq } = (await r.json()) as { seq: number };
    const ev = await ws.next((f) => f.t === 'ev');
    expect(ev).toMatchObject({ t: 'ev', seq, topic: 'module:_example', type: 'example.pinged' });
    ws.close();
  });

  it('locale files are discovered and merged under the module namespace', () => {
    expect((s.locales.en as any)._example.nav).toBe('Example');
    expect((s.locales.fil as any)._example.nav).toBe('Halimbawa');
    expect((s.locales.fil as any).core.common.retry).toBe('Subukan ulit');
  });

  it('registration rules: public routes need limits, tools need the module prefix, auth must be declared', async () => {
    const { createModuleHost } = await import('./module-host.js');
    const svc = {
      tools: s.tools,
      blocks: s.blocks,
      sites: { mount: () => ({}) },
      log: { child: () => ({}) },
      config: () => ({}),
      cards: () => ({}),
      home: s.home,
    } as any;
    const { host } = createModuleHost('demo', svc);
    expect(() =>
      host.publicHttp.route({ method: 'POST', url: '/x', bodyLimit: 10, handler: () => null } as any),
    ).toThrow(/rateLimit/);
    expect(() =>
      host.publicHttp.route({
        method: 'POST',
        url: '/x',
        rateLimit: { max: 1, windowMs: 1 },
        handler: () => null,
      } as any),
    ).toThrow(/bodyLimit/);
    expect(() =>
      host.http.route({ method: 'GET', url: '/x', auth: 'public', handler: () => null } as any),
    ).toThrow(/auth/);
    expect(() => host.tools.add({ name: 'other_tool' } as any)).toThrow(/demo_/);
    // the gateway meta-tools keep their bare names, and only the mcp module may register them
    expect(() => host.tools.add({ name: 'tools_find' } as any)).toThrow(/demo_/);
    const { mayRegisterTool } = await import('@pasabot/core');
    expect(mayRegisterTool('mcp', 'tools_invoke')).toBe(true);
    expect(mayRegisterTool('mcp', 'tools_other')).toBe(false);
    expect(mayRegisterTool('demo', 'tools_describe')).toBe(false);
    expect(() => host.blocks.register('other.kind', {} as any)).toThrow(/demo\./);
    expect(() => host.vault.list()).toThrow(); // unavailable until W0b; never silently a no-op
  });
});
