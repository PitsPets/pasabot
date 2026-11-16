/**
 * W22 proofs: the template catalogue, drafts, bundle round-trip, importers, and the free starter with a stub
 * installer and a fake model list (no download or install without consent; checksum checked; the first agent answers
 * a FakeProvider-backed turn with no key or login; a 429 gives one plain message and no retry storm; a model that is
 * no longer free shows the notice). Every server runs on port 0 in a temp home; nothing touches ~/.pasabot or starts
 * a real OpenCode binary.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TurnInput } from '@pasabot/core';
import { FakeProvider, type Script } from '@pasabot/provider-fake';
import { createSafeNet } from '@pasabot/safe-net';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { busyMessage, FreeTierGate } from './free-tier.js';
import { InstallError, type Installer, ReleaseInstaller } from './install/installer.js';
import { createTemplatesModule, DEFAULT_CATALOG, type TemplatesModuleOptions } from './server.js';
import { draftFromPrompt, frontMatter, importFile } from './templates.js';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-templates-test-'));
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
const finals = (chatId: string) =>
  s!.db
    .prepare(
      "SELECT author_kind, body FROM messages WHERE chat_id = ? AND status = 'final' ORDER BY created_at, id",
    )
    .all(chatId) as { author_kind: string; body: string }[];

/** A Fake brain presented as the installed OpenCode CLI (never the real binary). */
function fakeOpenCode(script: (input: TurnInput) => Script) {
  const inputs: TurnInput[] = [];
  const inner = new FakeProvider({ script: (i) => script(i), deltaMs: 1 });
  const a: ProviderAdapter & { inputs: TurnInput[] } = {
    id: 'opencode',
    displayName: 'OpenCode (fake)',
    inputs,
    detect: async () => ({ installed: true, version: '0.0.0-fake', signedIn: 'unknown' }),
    capabilities: () => inner.capabilities(),
    runTurn(input, signal) {
      inputs.push(input);
      return inner.runTurn(input, signal);
    },
  };
  return a;
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
const authError: Script = [
  { event: { type: 'error', kind: 'auth', message: 'this model now needs an API key' } },
  { event: { type: 'done', stop: 'error' } },
];

/** a stub installer that counts calls and writes a placeholder binary into the temp bin dir */
function stubInstaller(o: { fail?: boolean } = {}) {
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
      if (o.fail) throw new InstallError('download', 'stub download failed');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { binPath: join(binDir, 'opencode'), version: 'v0.0.0-stub' };
    },
  });
  return { calls, make };
}

async function boot(o: TemplatesModuleOptions = {}) {
  s = await bootTestServer({ modules: [createTemplatesModule(o)], providers: [new FakeProvider()] });
  return api(seedUser(s.db).token);
}

describe('templates: catalogue, drafts, bundles, importers', () => {
  it('lists the built-ins and installs one from a folder; members cannot', async () => {
    const call = await boot({ binDir: join(tmp, 'bin-a') });
    const r = await call('GET', '/api/m/templates/catalog');
    expect(r.status).toBe(200);
    expect(r.json.templates.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(['daily-planner', 'research-helper', 'writing-buddy']),
    );
    const dir = join(tmp, 'tpl-folder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'template.json'),
      JSON.stringify({ id: 'shop-helper', name: 'Shop helper', instructions: 'Track stock.' }),
    );
    const add = await call('POST', '/api/m/templates/catalog', { kind: 'folder', path: dir });
    expect(add.status).toBe(200);
    expect((await call('GET', '/api/m/templates/catalog')).json.templates.map((t: any) => t.id)).toContain(
      'shop-helper',
    );
    const member = api(seedUser(s!.db, 'member', 'Mia').token);
    expect((await member('GET', '/api/m/templates/catalog')).status).toBe(403);
    expect(
      (await call('POST', '/api/m/templates/catalog', { kind: 'folder', path: 'relative' })).status,
    ).toBe(400);
  });

  it('"make me an agent that…" yields a valid draft for review, and the core accepts it', async () => {
    const call = await boot({ binDir: join(tmp, 'bin-b') });
    const d = await call('POST', '/api/m/templates/draft', {
      prompt: 'Make me an agent that summarizes the news every morning',
    });
    expect(d.status).toBe(200);
    expect(d.json.draft.templateId).toBe('research-helper');
    expect(d.json.draft.instructions).toContain('Summarizes the news every morning');
    // the reviewed draft creates a real agent through the core API (at the server's default trust)
    const a = await call('POST', '/api/v1/agents', {
      name: d.json.draft.name,
      instructions: d.json.draft.instructions,
      providerId: 'fake',
    });
    expect(a.status).toBe(201);
    const def = (await call('GET', '/api/v1/settings/agent-trust')).json.defaultTrust;
    expect(a.json.agent.trustLevel).toBe(def);
    // no matching template still gives a valid draft
    const plain = draftFromPrompt('make me an agent that waters the plants', []);
    expect(plain.name).toBe('Waters Plants');
    expect(() => draftFromPrompt('   ', [])).toThrow();
  });

  it('bundle export → import round-trips equal (template and agent)', async () => {
    const call = await boot({ binDir: join(tmp, 'bin-c') });
    const b = await call('GET', '/api/m/templates/catalog/writing-buddy/export');
    expect(b.json.format).toBe('pasabot-template');
    const back = await call('POST', '/api/m/templates/import', {
      fileName: 'writing-buddy.pasabot-template.json',
      content: JSON.stringify(b.json),
    });
    expect(back.json.format).toBe('pasabot');
    expect(back.json.template).toEqual(b.json.template);
    // an agent published as a template bundle, imported into the catalogue, exports the same again
    const a = await call('POST', '/api/v1/agents', {
      name: 'Tala',
      instructions: 'Be kind.',
      providerId: 'fake',
    });
    const pub = await call('GET', `/api/m/templates/agents/${a.json.agent.id}/export`);
    expect(pub.json.template).toMatchObject({ id: 'tala', name: 'Tala', instructions: 'Be kind.' });
    expect(JSON.stringify(pub.json)).not.toMatch(/trust|workspace/i);
    const inst = await call('POST', '/api/m/templates/catalog', {
      kind: 'file',
      fileName: 'tala.pasabot-template.json',
      content: JSON.stringify(pub.json),
    });
    expect(inst.status).toBe(200);
    const again = await call('GET', '/api/m/templates/catalog/tala/export');
    expect(again.json).toEqual(pub.json);
  });

  it('the built-in team builder is never exported as a template: its internal prompt stays on the server', async () => {
    const call = await boot({ binDir: join(tmp, 'bin-builtin') });
    const secret = 'INTERNAL PROMPT: call orchestrator_answer after every reply';
    const a = await call('POST', '/api/v1/agents', {
      name: 'Tala',
      instructions: secret,
      providerId: 'fake',
    });
    expect(a.status).toBe(201);
    // the orchestrator module records its agent under this setting (ORCHESTRATOR_AGENT_SETTING)
    s!.db
      .prepare("INSERT INTO settings (key, value) VALUES ('module:orchestrator:agentId', ?)")
      .run(JSON.stringify(a.json.agent.id));
    const pub = await call('GET', `/api/m/templates/agents/${a.json.agent.id}/export`);
    expect(pub.status).toBe(409);
    expect(pub.json.error).toBe('builtin_agent');
    expect(JSON.stringify(pub.json)).not.toContain('orchestrator_answer');
    // the row keeps the real prompt (the runner reads it there)
    expect(
      (
        s!.db.prepare('SELECT instructions FROM agents WHERE id = ?').get(a.json.agent.id) as {
          instructions: string;
        }
      ).instructions,
    ).toBe(secret);
    // an ordinary agent still exports as before
    const b = await call('POST', '/api/v1/agents', {
      name: 'Lira',
      instructions: 'Be kind.',
      providerId: 'fake',
    });
    const ok = await call('GET', `/api/m/templates/agents/${b.json.agent.id}/export`);
    expect(ok.status).toBe(200);
    expect(ok.json.template.instructions).toBe('Be kind.');
  });

  it('imports other products’ public agent formats as drafts; refuses the rest', () => {
    const md = importFile(
      'reviewer.md',
      '---\nname: code-reviewer\ndescription: "Reviews diffs"\ntools: Read, Grep\n---\nYou review code carefully.\n',
    );
    expect(md.format).toBe('markdown-agent');
    expect(md.template).toMatchObject({
      id: 'code-reviewer',
      name: 'code-reviewer',
      description: 'Reviews diffs',
      instructions: 'You review code carefully.',
    });
    const js = importFile('a.json', JSON.stringify({ name: 'Helper', instructions: 'Help.', model: 'x' }));
    expect(js.format).toBe('assistant-json');
    expect(() => importFile('a.json', '{"foo":1}')).toThrow(/not an agent/);
    expect(() => importFile('a.exe', 'MZ')).toThrow();
    expect(frontMatter('no front matter').meta).toEqual({});
  });
});

describe('free starter', () => {
  it('no install without the consent click; consent installs to the temp per-user dir', async () => {
    const binDir = join(tmp, 'bin-consent');
    const st = stubInstaller();
    const call = await boot({
      binDir,
      installer: st.make,
      makeOpenCode: () => fakeOpenCode(() => reply('hi')),
    });
    const g = await call('GET', '/api/m/templates/starter');
    expect(g.json.available).toBe(true);
    expect(g.json.consent).toEqual({
      what: 'OpenCode CLI',
      where: join(binDir, 'opencode'),
      from: 'https://example.invalid/r',
    });
    expect(g.json.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call('POST', '/api/m/templates/starter/install', { consent: false })).status).toBe(400);
    expect((await call('POST', '/api/m/templates/starter/install', {})).status).toBe(400);
    expect(st.calls.n).toBe(0);
    expect(existsSync(binDir)).toBe(false);
    const ok = await call('POST', '/api/m/templates/starter/install', { consent: true });
    expect(ok.status).toBe(200);
    expect(st.calls.n).toBe(1);
    expect(existsSync(join(binDir, 'opencode'))).toBe(true);
    expect((await call('GET', '/api/m/templates/starter')).json.installed.binPath).toBe(
      join(binDir, 'opencode'),
    );
  });

  it('a failed install says so and creates nothing', async () => {
    const binDir = join(tmp, 'bin-fail');
    const st = stubInstaller({ fail: true });
    const call = await boot({ binDir, installer: st.make });
    const r = await call('POST', '/api/m/templates/starter/install', { consent: true });
    expect(r.status).toBe(502);
    expect(r.json.message ?? r.json.error).toBeTruthy();
    expect((await call('GET', '/api/v1/agents')).json.agents ?? []).toHaveLength(0);
    expect(existsSync(join(binDir, 'opencode'))).toBe(false);
  });

  it('the global stop (W31) aborts an install in flight and refuses a new one until resume', async () => {
    const binDir = join(tmp, 'bin-stop');
    let calls = 0;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const make = (_app: unknown, dir: string): Installer => ({
      describe: () => ({
        what: 'OpenCode CLI',
        where: join(dir, 'opencode'),
        from: 'https://example.invalid/r',
      }),
      install: ({ signal }) =>
        new Promise((_res, rej) => {
          calls++;
          signal?.addEventListener('abort', () =>
            rej(new InstallError('stopped', 'the install was stopped')),
          );
          started();
        }),
    });
    const call = await boot({ binDir, installer: make });
    const pending = call('POST', '/api/m/templates/starter/install', { consent: true });
    await begun;
    const owner = s!.db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string };
    const report = await s!.killSwitch.stopAll({ kind: 'owner', userId: owner.id }, 'test');
    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'install', outcome: 'cancelled' }));
    expect((await pending).status).toBe(409);
    // while stopped the installer is never started
    expect((await call('POST', '/api/m/templates/starter/install', { consent: true })).status).toBe(409);
    expect(calls).toBe(1);
    expect(existsSync(join(binDir, 'opencode'))).toBe(false);
    s!.killSwitch.resume({ kind: 'owner', userId: owner.id }, { reauthed: true });
    const after = call('POST', '/api/m/templates/starter/install', { consent: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    await s!.killSwitch.stopAll({ kind: 'owner', userId: owner.id }, 'cleanup');
    expect((await after).status).toBe(409);
  });

  it('the release installer writes nothing once its stop signal fires', async () => {
    const ac = new AbortController();
    const source = {
      release: 'https://api.example.invalid/latest',
      hosts: ['api.example.invalid'],
      assets: { 'linux-x64': 'opencode-linux-x64.tar.gz' },
      binary: 'opencode',
    };
    const data = Buffer.from('not reached');
    const fetchStopping = async (url: string) => {
      if (url === source.release)
        return new Response(
          JSON.stringify({
            tag_name: 'v9.9.9',
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://api.example.invalid/a.tgz',
                digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
              },
            ],
          }),
        );
      ac.abort(); // the stop lands while the file downloads
      return new Response(data);
    };
    const dir = join(tmp, 'bin-stopped');
    await expect(
      new ReleaseInstaller({ source, binDir: dir, fetch: fetchStopping, platform: 'linux-x64' }).install({
        consent: true,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: 'stopped' });
    expect(existsSync(dir)).toBe(false);
  });

  it('the release installer verifies the SHA-256 before writing anything', async () => {
    const pkg = join(tmp, 'pkg');
    mkdirSync(join(pkg, 'opencode-linux-x64', 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'opencode-linux-x64', 'bin', 'opencode'), '#!/bin/sh\necho 0.0.0\n');
    const tgz = join(tmp, 'opencode-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', pkg, '.']);
    const data = readFileSync(tgz);
    const sha = createHash('sha256').update(data).digest('hex');
    const source = {
      release: 'https://api.example.invalid/latest',
      hosts: ['api.example.invalid'],
      assets: { 'linux-x64': 'opencode-linux-x64.tar.gz' },
      binary: 'opencode',
    };
    const fetchWith = (digest: string | undefined) => async (url: string) =>
      url === source.release
        ? new Response(
            JSON.stringify({
              tag_name: 'v9.9.9',
              assets: [
                {
                  name: 'opencode-linux-x64.tar.gz',
                  browser_download_url: 'https://api.example.invalid/a.tgz',
                  ...(digest ? { digest } : {}),
                },
              ],
            }),
          )
        : new Response(data);
    const bad = join(tmp, 'bin-bad');
    await expect(
      new ReleaseInstaller({
        source,
        binDir: bad,
        fetch: fetchWith(`sha256:${'0'.repeat(64)}`),
        platform: 'linux-x64',
      }).install({
        consent: true,
      }),
    ).rejects.toMatchObject({ code: 'checksum' });
    await expect(
      new ReleaseInstaller({
        source,
        binDir: bad,
        fetch: fetchWith(undefined),
        platform: 'linux-x64',
      }).install({
        consent: true,
      }),
    ).rejects.toMatchObject({ code: 'checksum' });
    expect(existsSync(bad)).toBe(false);
    let fetched = 0;
    const counting = async (url: string) => {
      fetched++;
      return fetchWith(`sha256:${sha}`)(url);
    };
    const good = join(tmp, 'bin-good');
    const inst = new ReleaseInstaller({ source, binDir: good, fetch: counting, platform: 'linux-x64' });
    await expect(inst.install({ consent: false })).rejects.toMatchObject({ code: 'no_consent' });
    expect(fetched).toBe(0);
    const r = await inst.install({ consent: true });
    expect(r).toEqual({ binPath: join(good, 'opencode'), version: 'v9.9.9' });
    expect(statSync(r.binPath).mode & 0o111).toBeTruthy();
  });

  it('the release installer works through the real SafeNet port: User-Agent, > 10 MB, host list, guard on', async () => {
    // a Bun-sized binary (11 MB of random bytes, so gzip cannot shrink it under safe-net's 10 MB default)
    const pkg = join(tmp, 'pkg-big');
    mkdirSync(join(pkg, 'opencode-linux-x64', 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'opencode-linux-x64', 'bin', 'opencode'), randomBytes(11 * 1024 * 1024));
    const tgz = join(tmp, 'opencode-big.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', pkg, '.']);
    const data = readFileSync(tgz);
    expect(data.length).toBeGreaterThan(10 * 1024 * 1024);
    const sha = createHash('sha256').update(data).digest('hex');
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    let downloadHost = '127.0.0.1';
    // a GitHub-like stub: 403 without a User-Agent; the asset URL redirects to a CDN path
    const srv = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if (!req.headers['user-agent']) return void res.writeHead(403).end('{"message":"no user agent"}');
      const port = (srv.address() as AddressInfo).port;
      if (req.url === '/latest') {
        res.setHeader('content-type', 'application/json');
        return void res.end(
          JSON.stringify({
            tag_name: 'v1.2.3',
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: `http://${downloadHost}:${port}/dl`,
                digest: `sha256:${sha}`,
              },
            ],
          }),
        );
      }
      if (req.url === '/dl') return void res.writeHead(302, { location: '/cdn/blob' }).end();
      if (req.url === '/cdn/blob') return void res.end(data);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const source = {
        release: `http://127.0.0.1:${port}/latest`,
        hosts: ['127.0.0.1'],
        assets: { 'linux-x64': 'opencode-linux-x64.tar.gz' },
        binary: 'opencode',
      };
      // the stub lives on loopback, so only the test's owner-level allowlist lets safe-net reach it
      const net = createSafeNet({ allowHosts: ['127.0.0.1'] });
      const binDir = join(tmp, 'bin-safenet');
      const inst = new ReleaseInstaller({
        source,
        binDir,
        fetch: (u, i) => net.fetch(u, i),
        platform: 'linux-x64',
      });
      const r = await inst.install({ consent: true });
      expect(r).toEqual({ binPath: join(binDir, 'opencode'), version: 'v1.2.3' });
      expect(statSync(r.binPath).size).toBe(11 * 1024 * 1024);
      expect(seen.map((x) => x.url)).toEqual(['/latest', '/dl', '/cdn/blob']);
      expect(seen.every((x) => x.headers['user-agent'] === 'PasaBot')).toBe(true);
      expect(seen[0]!.headers.accept).toBe('application/vnd.github+json');

      // the installer itself never switches the private-address guard off for its hosts
      seen.length = 0;
      const guarded = new ReleaseInstaller({
        source,
        binDir: join(tmp, 'bin-guarded'),
        fetch: (u, i) => createSafeNet().fetch(u, i),
        platform: 'linux-x64',
      });
      await expect(guarded.install({ consent: true })).rejects.toMatchObject({
        code: 'download',
        message: expect.stringMatching(/blocked address/),
      });
      expect(seen).toHaveLength(0);
      expect(existsSync(join(tmp, 'bin-guarded'))).toBe(false);

      // an asset URL on a host that is not on the list is never fetched
      downloadHost = 'localhost';
      const offList = new ReleaseInstaller({
        source,
        binDir: join(tmp, 'bin-offlist'),
        fetch: (u, i) => net.fetch(u, i),
        platform: 'linux-x64',
      });
      await expect(offList.install({ consent: true })).rejects.toMatchObject({
        code: 'download',
        message: expect.stringMatching(/not on the release host list/),
      });
      expect(seen.map((x) => x.url)).toEqual(['/latest']);
      expect(existsSync(join(tmp, 'bin-offlist'))).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 30_000);

  it('the first agent on the free model answers with no key or login', async () => {
    const st = stubInstaller();
    const brain = fakeOpenCode((i) => reply(`free: ${i.user.text}`));
    const call = await boot({
      binDir: join(tmp, 'bin-first'),
      installer: st.make,
      makeOpenCode: () => brain,
    });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = (await call('GET', '/api/m/templates/starter')).json.models[0].id as string;
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    expect(a.status).toBe(201);
    expect(
      (await call('POST', '/api/m/templates/starter/agents', { agentId: a.json.agent.id, model })).status,
    ).toBe(200);
    await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, { text: 'hello' });
    await until(() =>
      finals(a.json.chatId).find((m) => m.author_kind === 'agent' && m.body === 'free: hello'),
    );
    expect(brain.inputs[0]!.model).toBe(model);
    expect(brain.inputs[0]!.account).toBeUndefined();
    expect(Object.keys(brain.inputs[0]!.env).filter((k) => /KEY|TOKEN/i.test(k))).toEqual([]);
  });

  it('a 429 on the free model gives one plain busy message and no retry storm (≤ 2 attempts)', async () => {
    const st = stubInstaller();
    const brain = fakeOpenCode(() => limited);
    const call = await boot({ binDir: join(tmp, 'bin-429'), installer: st.make, makeOpenCode: () => brain });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = 'opencode/big-pickle';
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await call('POST', '/api/m/templates/starter/agents', { agentId: a.json.agent.id, model });
    await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, { text: 'one' });
    const held = await until(
      () =>
        s!.db
          .prepare("SELECT error FROM queue_items WHERE agent_id = ? AND state = 'held'")
          .get(a.json.agent.id) as { error: string } | undefined,
    );
    expect(held.error).toMatch(/free model is busy or out of quota, try again at/);
    // a second message while the gate is closed never reaches the model
    await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, { text: 'two' });
    await new Promise((r) => setTimeout(r, 400));
    expect(brain.inputs.length).toBeGreaterThanOrEqual(1);
    expect(brain.inputs.length).toBeLessThanOrEqual(2);
    expect((await call('GET', '/api/m/templates/starter')).json.busyUntil).toBeGreaterThan(Date.now());
  });

  it('the model list marks the free models and pre-ticks the first one OpenCode offers', async () => {
    const inner: ProviderAdapter = {
      ...fakeOpenCode(() => reply('x')),
      listModels: async () => [{ id: 'paid/a' }, { id: 'free/m' }, { id: 'free/n' }],
    };
    const gate = new FreeTierGate({
      inner,
      isFree: (m) => m === 'free/m' || m === 'free/n',
      onBroken: () => {},
    });
    expect(await gate.listModels()).toEqual([
      { id: 'paid/a' },
      { id: 'free/m', hint: 'free', recommended: true },
      { id: 'free/n', hint: 'free' },
    ]);
  });

  it('free-model turns run one at a time across agents; other models pass straight through', async () => {
    let live = 0;
    let peak = 0;
    const inner: ProviderAdapter = {
      ...fakeOpenCode(() => reply('x')),
      async *runTurn() {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 30));
        live--;
        yield { type: 'text.final', text: 'ok' };
        yield { type: 'done', stop: 'end' };
      },
    };
    const gate = new FreeTierGate({ inner, isFree: (m) => m === 'free/m', onBroken: () => {} });
    const turn = (model: string) =>
      (async () => {
        for await (const _ of gate.runTurn(
          { model, agent: { model } } as unknown as TurnInput,
          new AbortController().signal,
        ));
      })();
    await Promise.all([turn('free/m'), turn('free/m'), turn('free/m')]);
    expect(peak).toBe(1);
    peak = 0;
    await Promise.all([turn('paid/m'), turn('paid/m')]);
    expect(peak).toBe(2);
    expect(busyMessage(0)).toMatch(/try again at 1970-01-01 00:00 UTC/);
  });

  it('a model that is no longer free (or now needs a key) shows the notice', async () => {
    // 1) the shipped list marks it not free
    const cat = join(tmp, 'catalog-copy');
    cpSync(DEFAULT_CATALOG, cat, { recursive: true });
    const st = stubInstaller();
    let call = await boot({
      catalog: cat,
      binDir: join(tmp, 'bin-n1'),
      installer: st.make,
      makeOpenCode: () => fakeOpenCode(() => reply('x')),
    });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const a = await call('POST', '/api/v1/agents', {
      name: 'Bida',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });
    await call('POST', '/api/m/templates/starter/agents', {
      agentId: a.json.agent.id,
      model: 'opencode/big-pickle',
    });
    expect((await call('GET', '/api/m/templates/starter')).json.notice).toBeNull();
    const list = JSON.parse(readFileSync(join(cat, 'free-models.json'), 'utf8'));
    list.models[0].free = false;
    writeFileSync(join(cat, 'free-models.json'), JSON.stringify(list));
    const n = (await call('GET', '/api/m/templates/starter')).json;
    expect(n.notice).toMatchObject({
      model: 'opencode/big-pickle',
      reason: 'is no longer free',
      agentId: a.json.agent.id,
    });
    expect(n.models.map((m: { id: string }) => m.id)).not.toContain('opencode/big-pickle');
    await s!.cleanup();
    s = null;
    // 2) the model starts answering with an auth error (brokenAfter: 1 here; the gate test covers the default 3)
    const brain = fakeOpenCode(() => authError);
    call = await boot({
      binDir: join(tmp, 'bin-n2'),
      installer: st.make,
      makeOpenCode: () => brain,
      brokenAfter: 1,
    });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const b = await call('POST', '/api/v1/agents', {
      name: 'Bida',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });
    await call('POST', '/api/m/templates/starter/agents', {
      agentId: b.json.agent.id,
      model: 'opencode/big-pickle',
    });
    await call('POST', `/api/v1/chats/${b.json.chatId}/messages`, { text: 'hi' });
    const got = await (async () => {
      for (let i = 0; i < 200; i++) {
        const r = (await call('GET', '/api/m/templates/starter')).json;
        if (r.notice) return r.notice;
        await new Promise((x) => setTimeout(x, 20));
      }
      return null;
    })();
    expect(got).toMatchObject({ model: 'opencode/big-pickle', reason: 'needs a key or login now' });
    const notes = s!.db.prepare("SELECT data FROM events WHERE type = 'notification'").all() as {
      data: string;
    }[];
    expect(notes.map((x) => String(JSON.parse(x.data).text))).toContainEqual(
      expect.stringContaining('The free model stopped working'),
    );
  });

  it('a broken mark clears: the owner re-checks, a later success, or a refreshed free list', async () => {
    const cat = join(tmp, 'catalog-clear');
    cpSync(DEFAULT_CATALOG, cat, { recursive: true });
    const model = 'opencode/big-pickle';
    const st = stubInstaller();
    const call = await boot({
      catalog: cat,
      binDir: join(tmp, 'bin-clear'),
      installer: st.make,
      makeOpenCode: () => fakeOpenCode(() => reply('fine again')),
    });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await call('POST', '/api/m/templates/starter/agents', { agentId: a.json.agent.id, model });
    const checkedAt = JSON.parse(readFileSync(join(cat, 'free-models.json'), 'utf8')).checkedAt;
    const mark = (at: string) =>
      s!.db
        .prepare(
          'INSERT INTO templates_starter_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(`broken:${model}`, JSON.stringify({ reason: 'needs a key or login now', checkedAt: at }));
    const starter = async () => (await call('GET', '/api/m/templates/starter')).json;
    // the owner's re-check
    mark(checkedAt);
    const before = await starter();
    expect(before.notice).toMatchObject({ model, reason: 'needs a key or login now' });
    expect(before.models.map((m: { id: string }) => m.id)).not.toContain(model);
    const rc = await call('POST', '/api/m/templates/starter/recheck', { model });
    expect(rc.status).toBe(200);
    expect(rc.json.notice).toBeNull();
    // a later successful turn on that model
    mark(checkedAt);
    expect((await starter()).notice).not.toBeNull();
    await call('POST', `/api/v1/chats/${a.json.chatId}/messages`, { text: 'hello' });
    await until(() => finals(a.json.chatId).find((m) => m.body === 'fine again'));
    await until(
      () => !s!.db.prepare('SELECT 1 FROM templates_starter_state WHERE key = ?').get(`broken:${model}`),
    );
    expect((await starter()).notice).toBeNull();
    // a mark made under an older free list does not count once the list is refreshed
    mark('2000-01-01');
    expect((await starter()).notice).toBeNull();
  });

  it('the notice follows the agent: switching brain or deleting the agent clears it', async () => {
    const model = 'opencode/big-pickle';
    const st = stubInstaller();
    const call = await boot({
      binDir: join(tmp, 'bin-follow'),
      installer: st.make,
      makeOpenCode: () => fakeOpenCode(() => reply('x')),
    });
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const mk = async (name: string) => {
      const r = await call('POST', '/api/v1/agents', { name, providerId: 'opencode', model });
      await call('POST', '/api/m/templates/starter/agents', { agentId: r.json.agent.id, model });
      return r.json.agent.id as string;
    };
    const first = await mk('Una');
    const second = await mk('Ikalawa');
    const checkedAt = JSON.parse(readFileSync(join(DEFAULT_CATALOG, 'free-models.json'), 'utf8')).checkedAt;
    s!.db
      .prepare('INSERT INTO templates_starter_state (key, value) VALUES (?, ?)')
      .run(`broken:${model}`, JSON.stringify({ reason: 'no longer available', checkedAt }));
    const notice = async () => (await call('GET', '/api/m/templates/starter')).json.notice;
    const rows = () =>
      (s!.db.prepare('SELECT agent_id FROM templates_starter_agent').all() as { agent_id: string }[]).map(
        (r) => r.agent_id,
      );
    expect(await notice()).toMatchObject({ agentId: first });
    // the owner follows "Pick another brain" and moves the first agent to another provider
    expect((await call('PATCH', `/api/v1/agents/${first}`, { providerId: 'fake', model: null })).status).toBe(
      200,
    );
    await until(() => !rows().includes(first));
    expect(await notice()).toMatchObject({ agentId: second });
    // the second agent is deleted
    expect((await call('DELETE', `/api/v1/agents/${second}`)).status).toBe(200);
    await until(() => rows().length === 0);
    expect(await notice()).toBeNull();
  });

  it('gate: one auth error does not mark a model broken; three in a row do; a success resets', async () => {
    const script: ('auth' | 'ok')[] = [];
    const inner: ProviderAdapter = {
      ...fakeOpenCode(() => reply('x')),
      async *runTurn() {
        if (script.shift() === 'auth') {
          yield { type: 'error', kind: 'auth', message: '401' };
          yield { type: 'done', stop: 'error' };
        } else {
          yield { type: 'text.final', text: 'ok' };
          yield { type: 'done', stop: 'end' };
        }
      },
    };
    const broken: string[] = [];
    const working: string[] = [];
    const gate = new FreeTierGate({
      inner,
      isFree: () => true,
      onBroken: (m) => broken.push(m),
      onWorking: (m) => working.push(m),
    });
    const turn = async () => {
      for await (const _ of gate.runTurn(
        { model: 'free/m', agent: { model: 'free/m' } } as unknown as TurnInput,
        new AbortController().signal,
      ));
    };
    script.push('auth', 'auth', 'ok', 'auth', 'auth');
    for (let i = 0; i < 5; i++) await turn();
    expect(broken).toEqual([]);
    expect(working).toEqual(['free/m']);
    script.push('auth');
    await turn();
    expect(broken).toEqual(['free/m']);
  });

  it('gate: a cancelled queued turn leaves at once and never starts the CLI; a hung turn cannot pin the rest', async () => {
    let started = 0;
    let live = 0;
    let peak = 0;
    const holds: (() => void)[] = [];
    const inner: ProviderAdapter = {
      ...fakeOpenCode(() => reply('x')),
      async *runTurn() {
        started++;
        live++;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => holds.push(r));
        live--;
        yield { type: 'text.final', text: 'ok' };
        yield { type: 'done', stop: 'end' };
      },
    };
    const gate = new FreeTierGate({ inner, isFree: () => true, onBroken: () => {}, maxWaitMs: 300 });
    const run = (signal: AbortSignal) =>
      (async () => {
        const evs: { type: string; stop?: string; kind?: string }[] = [];
        for await (const ev of gate.runTurn(
          { model: 'free/m', agent: { model: 'free/m' } } as unknown as TurnInput,
          signal,
        ))
          evs.push(ev as never);
        return evs;
      })();
    const a = run(new AbortController().signal);
    await until(() => holds.length === 1);
    const cb = new AbortController();
    const b = run(cb.signal);
    const c = run(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    cb.abort();
    const t0 = Date.now();
    expect(await b).toEqual([{ type: 'done', stop: 'cancelled' }]);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(started).toBe(1);
    // A is hung past maxWaitMs: C gives up with the busy message instead of waiting for ever
    const cEvents = await c;
    expect(cEvents[0]).toMatchObject({ type: 'error', kind: 'rate_limit' });
    expect(cEvents.at(-1)).toEqual({ type: 'done', stop: 'error' });
    expect(started).toBe(1);
    // the lock still passes on correctly once A ends: D runs, alone
    const d = run(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1);
    holds.shift()!();
    await a;
    await until(() => holds.length === 1);
    expect(started).toBe(2);
    holds.shift()!();
    expect((await d).at(-1)).toEqual({ type: 'done', stop: 'end' });
    expect(peak).toBe(1);
  });
});
