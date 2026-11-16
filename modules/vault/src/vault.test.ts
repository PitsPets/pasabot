/**
 * W14 proofs, all local (stub CLIs written by this test, FakeProvider, FakeChannel; no network, no accounts):
 * the `bw` / `op` backends, the agent key-request flow, rotation re-wrapping every secret, and a secret echoed by
 * the Fake agent never leaving the server (channel, REST, WS, run events, logs, any table).
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger, PasaBotModule, ProviderAdapter } from '@pasabot/core';
import { FakeProvider, type Script, type ScriptEvent } from '@pasabot/provider-fake';
import {
  bootTestServer,
  connectWs,
  FakeChannel,
  FakeChannelPlatform,
  seedAgent,
  seedRunToken,
  seedUser,
  type TestServer,
  tempHome,
} from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BitwardenBackend, OnePasswordBackend, pinCli } from './backends.js';
import { createVaultModule } from './server.js';

// fixture values built at runtime so secret scanners do not flag them
const BW_PASSWORD = ['bw', 'fixture', 'Pw9', 'only-for-tests'].join('-');
const BW_API = ['bw', 'custom', 'field', '4471'].join('_');
const OP_VALUE = ['op', 'fixture', 'Tk', '0042-tests'].join('.');
const BW_SESSION = ['bw', 'session', 'fixture'].join('-');
const OP_TOKEN = ['op', 'token', 'fixture'].join('-');

const dir = mkdtempSync(join(tmpdir(), 'pasabot-vault-stubs-'));
const argLog = join(dir, 'calls.log');
function stub(file: string, body: string) {
  const p = join(dir, file);
  writeFileSync(
    p,
    // the child's PATH is only the binary's folder + /usr/bin:/bin, so the stub names its node by absolute path
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ bin: ${JSON.stringify(file)}, a, env: Object.keys(process.env).sort(), path: process.env.PATH }) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const err = (s) => { process.stderr.write(s); process.exit(1); };
${body}
`,
  );
  chmodSync(p, 0o755);
  return p;
}
const BW = stub(
  'bw.cjs',
  `if (process.env.BW_SESSION !== ${JSON.stringify(BW_SESSION)}) err('You are not logged in.');
if (a[0] === 'status') out(JSON.stringify({ status: 'unlocked' }));
if (a[0] === 'get' && a[1] === 'item' && a[2] === 'item-1')
  out(JSON.stringify({ login: { username: 'diwa', password: ${JSON.stringify(BW_PASSWORD)} }, notes: null, fields: [{ name: 'api', value: ${JSON.stringify(BW_API)} }] }));
if (a[0] === 'get' && a[1] === 'totp' && a[2] === 'item-1') out('123456\\n');
err('Not found.');`,
);
const OP = stub(
  'op.cjs',
  `if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== ${JSON.stringify(OP_TOKEN)}) err('[ERROR] You are not currently signed in.');
if (a[0] === 'whoami') out('{"user_type":"SERVICE_ACCOUNT"}');
if (a[0] === 'read' && a[1] === '--no-newline' && a[2] === 'op://Dev/GitHub/token') out(${JSON.stringify(OP_VALUE)});
err('[ERROR] could not find item GitHub in vault Dev');`,
);
const calls = () =>
  readFileSync(argLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { bin: string; a: string[]; env: string[]; path: string });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('bw / op backends with stub CLIs', () => {
  it('Bitwarden: password, username, custom field and TOTP by reference; locked without a session', async () => {
    let session = '';
    const bw = new BitwardenBackend({ bin: BW, session: async () => session, allowWritableBin: true });
    expect(await bw.check()).toEqual({ state: 'locked' });
    await expect(bw.resolve('item-1')).rejects.toMatchObject({ code: 'locked' });
    session = BW_SESSION;
    expect(await bw.check()).toEqual({ state: 'ready' });
    expect(await bw.resolve('item-1')).toBe(BW_PASSWORD);
    expect(await bw.resolve('item-1/username')).toBe('diwa');
    expect(await bw.resolve('item-1/api')).toBe(BW_API);
    expect(await bw.resolve('item-1/totp')).toBe('123456');
    await expect(bw.resolve('item-1/notes')).rejects.toMatchObject({ code: 'not_found' });
    await expect(bw.resolve('item-2')).rejects.toMatchObject({ code: 'not_found' });
    // a reference is checked before it reaches argv: nothing that reads as a flag is ever passed
    const before = calls().length;
    await expect(bw.resolve('--raw')).rejects.toThrow(/not a Bitwarden reference/);
    expect(calls().length).toBe(before);
    const last = calls().filter((c) => c.bin === 'bw.cjs');
    expect(last.at(-1)!.a).toEqual(['get', 'item', 'item-2', '--nointeraction']);
    // scrubbed environment: no server variables reach the CLI, only the basics and its session
    process.env.PASABOT_SHOULD_NOT_LEAK = '1';
    await bw.resolve('item-1');
    delete process.env.PASABOT_SHOULD_NOT_LEAK;
    const env = calls().at(-1)!.env;
    expect(env).toContain('BW_SESSION');
    expect(env).not.toContain('PASABOT_SHOULD_NOT_LEAK');
    // never the server's PATH: the pinned binary's own folder, then /usr/bin:/bin
    expect(calls().at(-1)!.path).toBe(`${realpathSync(dir)}:/usr/bin:/bin`);
    // an error never carries CLI output (which may hold a value)
    await bw.resolve('item-1/notes').catch((e: Error) => expect(e.message).not.toContain(BW_PASSWORD));
  });

  it('1Password: op:// references read through `op read`; not signed in; not installed', async () => {
    let token = '';
    const op = new OnePasswordBackend({ bin: OP, session: async () => token, allowWritableBin: true });
    expect(await op.check()).toEqual({ state: 'locked' });
    token = OP_TOKEN;
    expect(await op.check()).toEqual({ state: 'ready' });
    expect(await op.resolve('op://Dev/GitHub/token')).toBe(OP_VALUE);
    expect(calls().at(-1)!.a).toEqual(['read', '--no-newline', 'op://Dev/GitHub/token']);
    await expect(op.resolve('op://Dev/Nope/token')).rejects.toMatchObject({ code: 'not_found' });
    await expect(op.resolve('op://Dev/GitHub')).rejects.toThrow(/not a 1Password reference/);
    await expect(op.resolve('-o /tmp/x')).rejects.toThrow(/not a 1Password reference/);
    const missing = new OnePasswordBackend({ bin: join(dir, 'no-such-op') });
    expect(await missing.check()).toEqual({ state: 'not_installed' });
  });

  it('W14 fix: a CLI the server user can change is never run and never gets the session key', async () => {
    // the stubs live in a folder this (server) user owns: exactly what an agent in host mode could swap
    let asked = 0;
    const session = async () => {
      asked++;
      return BW_SESSION;
    };
    const before = calls().length;
    const bw = new BitwardenBackend({ bin: BW, session });
    const op = new OnePasswordBackend({ bin: OP, session });
    expect(bw.pinned).toEqual({ path: null, problem: 'unsafe_bin' });
    expect(await bw.check()).toEqual({ state: 'unsafe_bin' });
    expect(await op.check()).toEqual({ state: 'unsafe_bin' });
    await expect(bw.resolve('item-1')).rejects.toMatchObject({ code: 'unsafe_bin' });
    await expect(op.resolve('op://Dev/GitHub/token')).rejects.toMatchObject({ code: 'unsafe_bin' });
    expect(calls().length).toBe(before);
    expect(asked).toBe(0);
    // a bare name is never looked up on the server's PATH (an agent could prepend a folder it controls)
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      expect(pinCli('bw.cjs', { allowWritable: true })).toEqual({ path: null, problem: 'not_installed' });
    } finally {
      process.env.PATH = path;
    }
    // only fixed folders are searched; relative paths are refused
    expect(pinCli('bw.cjs', { dirs: [dir], allowWritable: true }).path).toBe(realpathSync(BW));
    expect(pinCli('bw.cjs', { dirs: [dir] }).problem).toBe('unsafe_bin');
    expect(pinCli('./bw.cjs', { allowWritable: true }).problem).toBe('unsafe_bin');
    // a binary the server user cannot change is accepted, by its real path (POSIX)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const sh = pinCli('/bin/sh');
      expect(sh.problem).toBeNull();
      expect(sh.path).toBe(realpathSync('/bin/sh'));
    }
  });

  it('W14 fix: Settings → Vault says a backend is turned off because its CLI is unsafe', async () => {
    const t = await bootTestServer({ modules: [createVaultModule({ bwBin: BW, opBin: OP })] });
    try {
      const o = seedUser(t.db);
      const get = (path: string, method = 'GET') =>
        fetch(`${t.url}/api/m/vault${path}`, {
          method,
          headers: { authorization: `Bearer ${o.token}` },
        }).then((r) => r.json() as Promise<any>);
      expect((await get('/overview')).backends).toEqual([
        { id: 'bitwarden', sessionSet: false, disabled: 'unsafe_bin' },
        { id: '1password', sessionSet: false, disabled: 'unsafe_bin' },
      ]);
      expect(await get('/backends/bitwarden/test', 'POST')).toEqual({ state: 'unsafe_bin' });
    } finally {
      await t.cleanup();
    }
  });
});

const rpc = async (url: string, bearer: string, name: string, args: unknown) => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = j.result.content[0]!.text;
  return j.result.isError ? { error: text } : JSON.parse(text);
};
/** a test tool that resolves a reference through ToolCtx.vault the way a connector would, and echoes it */
const keyprobe: PasaBotModule = {
  id: 'keyprobe',
  register(h) {
    h.tools.add({
      name: 'keyprobe_use',
      title: 'Use a key',
      description: 'test only',
      input: z.object({ ref: z.string() }),
      tier: 0,
      handler: async (i, ctx) => ({ used: await ctx.vault.resolve(i.ref) }),
    });
  },
};
const vaultModule = () => createVaultModule({ bwBin: BW, opBin: OP, allowWritableBin: true });

describe('vault module: Settings → Vault REST, key requests, references', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let member: { token: string };
  let tala: string;
  let ligaya: string;
  const api = (path: string, init: { method?: string; body?: unknown } = {}, token = owner.token) =>
    fetch(`${s.url}/api/m/vault${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  beforeAll(async () => {
    s = await bootTestServer({ modules: [vaultModule(), keyprobe] });
    owner = seedUser(s.db);
    member = seedUser(s.db, 'member', 'Mia');
    tala = seedAgent(s.db, { trust: 'trusted' });
    ligaya = seedAgent(s.db, { trust: 'trusted' });
  });
  afterAll(() => s.cleanup());

  it('request → owner fills → reference granted; only that agent resolves it; the agent never sees the value', async () => {
    const { token } = seedRunToken(s.db, tala);
    const asked = await rpc(s.url, token, 'vault_request_secret', {
      name: 'WEATHER_KEY',
      reason: 'to read the forecast',
    });
    expect(asked).toMatchObject({ state: 'pending', reference: '{{secret:WEATHER_KEY}}' });
    // asking again does not open a second request
    expect((await rpc(s.url, token, 'vault_request_secret', { name: 'WEATHER_KEY' })).requestId).toBe(
      asked.requestId,
    );
    expect(await rpc(s.url, token, 'keyprobe_use', { ref: '{{secret:WEATHER_KEY}}' })).toMatchObject({
      error: expect.stringMatching(/no secret named "WEATHER_KEY" is granted/),
    });
    // the vault panel is owner-only
    expect((await api('/overview', {}, member.token)).status).toBe(403);
    const ov = (await (await api('/overview')).json()) as any;
    expect(ov.requests).toHaveLength(1);
    expect(ov.requests[0]).toMatchObject({
      name: 'WEATHER_KEY',
      agentId: tala,
      reason: 'to read the forecast',
    });

    const value = ['wx', 'fixture', '88a1'].join('-');
    const filled = await api(`/requests/${asked.requestId}/fill`, { method: 'POST', body: { value } });
    expect(filled.status, await filled.clone().text()).toBe(200);
    expect(await rpc(s.url, token, 'vault_list_secrets', {})).toEqual({
      granted: [{ name: 'WEATHER_KEY', reference: '{{secret:WEATHER_KEY}}', backend: 'local' }],
      waiting: [],
    });
    // a tool resolves the reference server-side; what goes back to the agent is redacted
    expect(await rpc(s.url, token, 'keyprobe_use', { ref: '{{secret:WEATHER_KEY}}' })).toEqual({
      used: '[secret:WEATHER_KEY]',
    });
    // another agent cannot use Tala's grant
    const other = seedRunToken(s.db, ligaya).token;
    expect((await rpc(s.url, other, 'keyprobe_use', { ref: '{{secret:WEATHER_KEY}}' })).error).toMatch(
      /not granted|no secret/,
    );
    // the overview lists the grant (never a value) and no open request
    const after = (await (await api('/overview')).json()) as any;
    expect(after.requests).toEqual([]);
    expect(after.secrets).toEqual([
      expect.objectContaining({
        name: 'WEATHER_KEY',
        kind: 'agent',
        agentId: tala,
        reference: '{{secret:WEATHER_KEY}}',
      }),
    ]);
    expect(JSON.stringify(after)).not.toContain(value);
    // every read was audited
    const audit = s.db.prepare("SELECT actor_id FROM audit_log WHERE action = 'vault.read'").all() as {
      actor_id: string;
    }[];
    expect(audit.map((a) => a.actor_id)).toContain(`agent:${tala}`);
  });

  it('decline closes a request; a flood of requests is capped; a stranger-caused request is marked', async () => {
    const run = seedRunToken(s.db, ligaya);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { id: 'x', kind: 'stranger', name: 'Someone', trust: 'guarded' } }),
        run.runId,
      );
    const r = await rpc(s.url, run.token, 'vault_request_secret', { name: 'BANK_PIN', reason: 'trust me' });
    const ov = (await (await api('/overview')).json()) as any;
    expect(ov.requests.find((x: any) => x.id === r.requestId).untrusted).toBe(true);
    expect((await api(`/requests/${r.requestId}/decline`, { method: 'POST' })).status).toBe(200);
    expect((await api(`/requests/${r.requestId}/decline`, { method: 'POST' })).status).toBe(404);
    for (let i = 0; i < 10; i++) await rpc(s.url, run.token, 'vault_request_secret', { name: `K${i}` });
    expect((await rpc(s.url, run.token, 'vault_request_secret', { name: 'K10' })).error).toMatch(
      /already have 10/,
    );
  });

  it('owner links 1Password, grants a reference; its value is fetched by the stub CLI and redacted', async () => {
    expect((await api('/backends/1password/test', { method: 'POST' }).then((r) => r.json())) as any).toEqual({
      state: 'locked',
    });
    expect(
      (await api('/backends/1password/session', { method: 'PUT', body: { token: OP_TOKEN } })).status,
    ).toBe(204);
    expect(await api('/backends/1password/test', { method: 'POST' }).then((r) => r.json())).toEqual({
      state: 'ready',
    });
    const bad = await api('/secrets', {
      method: 'POST',
      body: { target: tala, name: 'GH', backend: '1password', ref: '--help' },
    });
    expect(bad.status).toBe(400);
    const ok = await api('/secrets', {
      method: 'POST',
      body: { target: tala, name: 'GH', backend: '1password', ref: 'op://Dev/GitHub/token' },
    });
    expect(ok.status).toBe(201);
    const { token } = seedRunToken(s.db, tala);
    expect(await rpc(s.url, token, 'keyprobe_use', { ref: '{{secret:GH}}' })).toEqual({
      used: '[secret:GH]',
    });
    // the 1Password token itself is a vault entry (module scope), listed by count only
    const ov = (await (await api('/overview')).json()) as any;
    expect(ov.backends).toContainEqual({ id: '1password', sessionSet: true, disabled: null });
    expect(JSON.stringify(ov)).not.toContain(OP_TOKEN);
    // remove the grant
    const gh = ov.secrets.find((x: any) => x.name === 'GH');
    expect((await api(`/secrets/${gh.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await rpc(s.url, token, 'keyprobe_use', { ref: '{{secret:GH}}' })).error).toMatch(/no secret/);
  });
});

describe('rotation re-wraps all secrets', () => {
  it('every local secret is re-encrypted under the new key and reads back after a restart', async () => {
    const home = tempHome();
    try {
      let s = await bootTestServer({ home: home.dir, modules: [vaultModule()] });
      const owner = seedUser(s.db);
      const agent = seedAgent(s.db);
      const entries: [string, string, string][] = [
        ['global', 'SHARED_A', 'value-shared-a-1'],
        [`agent:${agent}`, 'OWN_B', 'value-own-b-22'],
        ['module:channels', 'binding:x:token', 'value-module-c-333'],
        ['module:vault', 'bitwarden.session', 'value-session-d'],
      ];
      for (const [scope, n, v] of entries) await s.vault.put(scope, n, v);
      await s.vault.putRef('global', 'REF_E', '1password', 'op://Dev/GitHub/token');
      const rows = () =>
        s.db
          .prepare('SELECT id, name, ciphertext, nonce, key_version, backend FROM secrets ORDER BY name')
          .all() as {
          id: string;
          name: string;
          ciphertext: Buffer | null;
          nonce: Buffer | null;
          key_version: number;
          backend: string;
        }[];
      const before = rows();
      const wrapped = () =>
        (s.db.prepare("SELECT value FROM settings WHERE key = 'vault.dataKey'").get() as any).value;
      const wrapBefore = wrapped();
      const r = await fetch(`${s.url}/api/m/vault/rotate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ rotated: 4 });
      const after = rows();
      expect(wrapped()).not.toBe(wrapBefore);
      for (const b of before) {
        const a = after.find((x) => x.id === b.id)!;
        if (b.backend !== 'local') {
          expect(a.ciphertext).toBeNull(); // a reference holds no value to re-wrap
          continue;
        }
        expect(a.key_version).toBe(b.key_version + 1);
        expect(Buffer.compare(a.ciphertext!, b.ciphertext!)).not.toBe(0);
        expect(Buffer.compare(a.nonce!, b.nonce!)).not.toBe(0);
      }
      await s.close();
      s = await bootTestServer({ home: home.dir, modules: [vaultModule()] });
      const metas = await s.vault.list();
      for (const [scope, n, v] of entries) {
        const m = metas.find((x) => x.scope === scope && x.name === n)!;
        expect(await s.vault.get(m, { actor: 'test', purpose: 'rotation proof' })).toBe(v);
      }
      // a member cannot rotate, and rotation needs an explicit confirm
      const member = seedUser(s.db, 'member', 'Mia');
      const own = seedUser(s.db);
      const post = (token: string, body: unknown) =>
        fetch(`${s.url}/api/m/vault/rotate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await post(member.token, { confirm: true })).status).toBe(403);
      expect((await post(own.token, {})).status).toBe(400);
      await s.close();
    } finally {
      home.cleanup();
    }
  });
});

// ---------- the redaction done-criterion ----------
class Platform extends FakeChannelPlatform {}
const LOCAL = ['Tala', 'Zq9"x\\y/ä', '7781', 'leak'].join('-');
const forms = (v: string) => [
  v,
  JSON.stringify(v).slice(1, -1),
  encodeURIComponent(v),
  Buffer.from(v).toString('base64'),
  Buffer.from(v).toString('base64url'),
];
/** the Fake agent leaks both secrets every way it can think of: split deltas, final text, encodings, a tool call */
function leakScript(): Script {
  const half = Math.floor(LOCAL.length / 2);
  const text = `here: ${LOCAL} | ${OP_VALUE} | ${JSON.stringify(LOCAL)} | ${encodeURIComponent(LOCAL)} | ${Buffer.from(LOCAL).toString('base64')} | ${Buffer.from(OP_VALUE).toString('base64url')}`;
  return [
    { event: { type: 'session', nativeRef: 'leak-1' } },
    { callTool: { name: 'keyprobe_use', args: { ref: '{{secret:GH}}' } } },
    { event: { type: 'text.delta', text: `here: ${LOCAL.slice(0, half)}` } as ScriptEvent },
    { after: 5, event: { type: 'text.delta', text: LOCAL.slice(half) } as ScriptEvent },
    { after: 5, event: { type: 'text.delta', text: text.slice(`here: ${LOCAL}`.length) } as ScriptEvent },
    { event: { type: 'text.final', text } },
    { event: { type: 'done', stop: 'end' } },
  ];
}

function leakBrain(): ProviderAdapter {
  const fake = new FakeProvider({
    script: (i) => (i.user.text.includes('leak') ? leakScript() : []),
    deltaMs: 1,
  });
  return Object.assign(Object.create(fake) as ProviderAdapter, {
    id: 'acp:leak' as const,
    displayName: 'Leak',
  });
}

describe('redaction: a secret echoed by the Fake agent never leaves the server', () => {
  let s: TestServer;
  let log!: Logger;
  const lines: string[] = [];
  const platform = new Platform();
  const spies = [vi.spyOn(process.stderr, 'write'), vi.spyOn(process.stdout, 'write')];
  beforeAll(async () => {
    for (const spy of spies)
      spy.mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as never);
    const grab: PasaBotModule = {
      id: 'logprobe',
      register: (h) => {
        log = h.log;
      },
    };
    // the channels module (bindings) comes in through the server's own discovery, as in production: every
    // workspace module from source, the vault module among them
    process.env.PASABOT_SOURCE = '1';
    s = await bootTestServer({
      root: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
      modules: [keyprobe, grab],
      // discovery already brings the plain Fake brain; the leaking one is the same adapter under its own id
      providers: [leakBrain()],
      channels: [new FakeChannel(platform)],
      channelRuntime: { backoffBaseMs: 20, backoffMaxMs: 100, editMs: 5, statusPollMs: 20, previewMax: 2000 },
      dispatcher: { pollMs: 5 },
      logLevel: 'debug',
    });
    // the discovered vault module pins its CLIs at boot and refuses these test-written stubs (the server user can
    // change them); the stub 1Password backend is put in its place, with the session the owner saves below
    s.vault.addBackend(
      new OnePasswordBackend({
        bin: OP,
        allowWritableBin: true,
        session: async () => {
          const hit = (await s.vault.list('module:vault')).find((x) => x.name === '1password.token');
          return hit ? s.vault.get(hit, { actor: 'test', purpose: 'stub session' }) : '';
        },
      }),
    );
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await s.cleanup();
  });

  const until = async <T>(f: () => T | undefined | null | false, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('channel sends, REST, WS frames, run events, logs and every table carry no form of either secret', async () => {
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { trust: 'trusted', providerId: 'acp:leak' });
    const h = { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' };
    const vault = (path: string, body: unknown, method = 'POST') =>
      fetch(`${s.url}/api/m/vault${path}`, { method, headers: h, body: JSON.stringify(body) });
    expect((await vault('/secrets', { target: agent, name: 'LOCAL_KEY', value: LOCAL })).status).toBe(201);
    expect((await vault('/backends/1password/session', { token: OP_TOKEN }, 'PUT')).status).toBe(204);
    expect(
      (
        await vault('/secrets', {
          target: agent,
          name: 'GH',
          backend: '1password',
          ref: 'op://Dev/GitHub/token',
        })
      ).status,
    ).toBe(201);

    // the owner talks to the agent through a channel DM (FakeChannel plays the chat app)
    const b = await fetch(`${s.url}/api/m/channels/bindings`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ kind: 'fake', agentId: agent, secrets: { token: platform.token } }),
    });
    expect(b.status, await b.clone().text()).toBe(201);
    const binding = ((await b.json()) as { binding: { id: string } }).binding.id;
    const { code } = (await (
      await fetch(`${s.url}/api/m/channels/bindings/${binding}/link`, {
        method: 'POST',
        headers: { authorization: h.authorization },
      })
    ).json()) as { code: string };
    await until(
      () =>
        (s.db.prepare('SELECT status FROM channels_binding WHERE id = ?').get(binding) as any)?.status ===
        'connected',
    );
    await platform.deliver({ from: 'owner', place: 'dm', text: `/link ${code}` });
    await until(() => platform.botTexts(platform.places.dm).some((t) => t.startsWith('Linked.')));

    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner.token });
    await ws.next((f) => f.t === 'welcome');
    await platform.deliver({ from: 'owner', place: 'dm', text: 'leak please' });
    await until(() => platform.botTexts(platform.places.dm).some((t) => t.includes('[secret:LOCAL_KEY]')));
    const chatId = (s.db.prepare("SELECT chat_id FROM messages WHERE body LIKE '%leak please%'").get() as any)
      .chat_id as string;
    ws.send({ t: 'sub', topics: [`chat:${chatId}`] });
    log.info('tool output', { echoed: `here: ${LOCAL} and ${OP_VALUE}` });
    // the channel preview can show the reply before the run ends: read REST once the reply is final
    let rest = '';
    const t0 = Date.now();
    while (!/"authorKind":"agent"[^}]*"status":"final"/.test(rest) && Date.now() - t0 < 8000) {
      rest = await (await fetch(`${s.url}/api/v1/chats/${chatId}/messages`, { headers: h })).text();
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    const sent = platform.botTexts(platform.places.dm).join('\n');
    expect(sent).toContain('[secret:LOCAL_KEY]');
    expect(sent).toContain('[secret:GH]');
    expect(rest).toContain('[secret:LOCAL_KEY]');
    // every table except the vault's own ciphertext store and settings (wrapped key, kdf salt)
    const tables = (
      s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'").all() as {
        name: string;
      }[]
    )
      .map((t) => t.name)
      .filter((n) => n !== 'secrets' && n !== 'settings');
    const dump = tables.map((t) => JSON.stringify(s.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
    expect(dump).toContain('[secret:LOCAL_KEY]');
    const outputs = { channel: sent, rest, ws: JSON.stringify(ws.frames), db: dump, logs: lines.join('') };
    for (const [where, text] of Object.entries(outputs))
      for (const f of [...forms(LOCAL), ...forms(OP_VALUE), OP_TOKEN])
        expect(text.includes(f), `${where} carries ${JSON.stringify(f)}`).toBe(false);
  });
});
