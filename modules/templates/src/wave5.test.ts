/**
 * Wave 5 gaps (W22/W34; the routine skip-and-report proof needs the routines module, so it lives in
 * providers/local/src/free-routines.test.ts, and the onboarding's local model proof boots the local provider, so it lives
 * in providers/local/src/onboarding.test.ts): the "no longer free" notice names the model and is notified once, and
 * `providers install` over the owner's session (checksum-verified, fake installer and fake release). Port 0 on
 * 127.0.0.1, temp homes, no network, no real CLI.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TurnInput } from '@pasabot/core';
import { FakeProvider, type Script } from '@pasabot/provider-fake';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { InstallError, type Installer, ReleaseInstaller } from './install/installer.js';
import { createTemplatesModule, DEFAULT_CATALOG, type TemplatesModuleOptions } from './server.js';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-templates-w5-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let s: TestServer | null = null;
const servers: Server[] = [];
afterEach(async () => {
  await s?.cleanup();
  s = null;
  await Promise.all(servers.splice(0).map((x) => new Promise<void>((r) => x.close(() => r()))));
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
function fakeOpenCode(script: () => Script) {
  const inner = new FakeProvider({ script: () => script(), deltaMs: 1 });
  const a: ProviderAdapter & { inputs: TurnInput[] } = {
    id: 'opencode',
    displayName: 'OpenCode (fake)',
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
function stubInstaller() {
  const calls = { n: 0 };
  const make = (_app: unknown, binDir: string): Installer => ({
    describe: () => ({
      what: 'OpenCode CLI',
      where: join(binDir, 'opencode'),
      from: 'https://example.invalid/r',
    }),
    async install({ consent }) {
      if (!consent) throw new InstallError('no_consent', 'no consent');
      calls.n++;
      writeFileSync(join(tmp, `opencode-${calls.n}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { binPath: join(tmp, `opencode-${calls.n}`), version: 'v0.0.0-stub' };
    },
  });
  return { calls, make };
}
const notifications = () =>
  (s!.db.prepare("SELECT data FROM events WHERE type = 'notification'").all() as { data: string }[]).map(
    (x) => String(JSON.parse(x.data).text ?? ''),
  );

describe('the "no longer free" notice', () => {
  it('names the model, says why in a code the page translates, and notifies the owner once', async () => {
    const cat = join(tmp, 'catalog-nf');
    cpSync(DEFAULT_CATALOG, cat, { recursive: true });
    s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [
        createTemplatesModule({
          catalog: cat,
          binDir: join(tmp, 'bin-nf'),
          installer: stubInstaller().make,
          makeOpenCode: () => fakeOpenCode(() => reply('x')),
        }),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = 'opencode/big-pickle';
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await call('POST', '/api/m/templates/starter/agents', { agentId: a.json.agent.id, model });
    const list = JSON.parse(readFileSync(join(cat, 'free-models.json'), 'utf8'));
    list.models[0].free = false;
    writeFileSync(join(cat, 'free-models.json'), JSON.stringify(list));
    for (let i = 0; i < 3; i++) {
      const n = (await call('GET', '/api/m/templates/starter')).json.notice;
      expect(n).toMatchObject({ model, name: 'Big Pickle', kind: 'not_free', agentId: a.json.agent.id });
    }
    await until(() => notifications().some((t) => t.includes('no longer free')));
    expect(notifications().filter((t) => t.includes('no longer free'))).toHaveLength(1);
  });
});

describe('providers install (the `pasabot providers install <id>` server side)', () => {
  it('lists what it installs and from where; owner only; consent required; unknown ids are refused', async () => {
    const st = stubInstaller();
    s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-p'),
          installer: st.make,
          makeOpenCode: () => fakeOpenCode(() => reply('x')),
        }),
      ],
    });
    const call = api(seedUser(s.db).token);
    const member = api(seedUser(s.db, 'member', 'M').token);
    const list = await call('GET', '/api/m/templates/providers/installable');
    expect(list.json.providers).toEqual([
      expect.objectContaining({ id: 'opencode', what: 'OpenCode CLI', checksum: 'sha256', installed: null }),
    ]);
    expect((await member('GET', '/api/m/templates/providers/installable')).status).toBe(403);
    expect(
      (await member('POST', '/api/m/templates/providers/opencode/install', { consent: true })).status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/m/templates/providers/opencode/install', { consent: false })).status,
    ).toBe(400);
    expect(st.calls.n).toBe(0);
    const bad = await call('POST', '/api/m/templates/providers/nope/install', { consent: true });
    expect(bad.status).toBe(404);
    expect(bad.json.message).toContain('installable: opencode');
    const ok = await call('POST', '/api/m/templates/providers/opencode/install', { consent: true });
    expect(ok.status).toBe(200);
    expect(ok.json.installed.version).toBe('v0.0.0-stub');
    expect(
      (await call('GET', '/api/m/templates/providers/installable')).json.providers[0].installed,
    ).toMatchObject({
      version: 'v0.0.0-stub',
    });
  });

  it('a download whose SHA-256 does not match is refused and nothing is written', async () => {
    const binDir = join(tmp, 'bin-sum');
    const data = Buffer.from('not really an archive');
    const source = {
      release: 'https://api.example.invalid/latest',
      hosts: ['api.example.invalid'],
      assets: { [`${process.platform}-${process.arch}`]: 'opencode.tar.gz' },
      binary: 'opencode',
    };
    const wrong = createHash('sha256').update('something else').digest('hex');
    const fetch = async (url: string) =>
      url === source.release
        ? new Response(
            JSON.stringify({
              tag_name: 'v1',
              assets: [
                {
                  name: 'opencode.tar.gz',
                  browser_download_url: 'https://api.example.invalid/a.tgz',
                  digest: `sha256:${wrong}`,
                },
              ],
            }),
          )
        : new Response(data);
    s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [
        createTemplatesModule({
          binDir,
          installer: (_app, dir) => new ReleaseInstaller({ source, binDir: dir, fetch }),
        }),
      ],
    });
    const call = api(seedUser(s.db).token);
    const r = await call('POST', '/api/m/templates/providers/opencode/install', { consent: true });
    expect(r.status).toBe(502);
    expect(r.json.message).toMatch(/does not match its published SHA-256/);
    expect(existsSync(join(binDir, 'opencode'))).toBe(false);
  });
});
