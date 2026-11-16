/**
 * Brains page server side: every tile state from the real adapters' own detection against fake CLIs (no account, no
 * network), who uses which brain, and the owner-only "Test" (one tool-less prompt, no run, no session, never stored,
 * problems named, 6 per minute).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderEvent, ProviderStatus } from '@pasabot/core';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootTestServer, seedAgent, seedUser, type TestServer } from '../../../packages/testkit/src/index.js';
import { ClaudeProvider } from '../../../providers/claude/src/index.js';
import { CodexProvider } from '../../../providers/codex/src/index.js';
import { createGeminiProvider } from '../../../providers/gemini/src/index.js';
import { createGrokProvider } from '../../../providers/grok/src/index.js';
import { type BrainProblem, brainState, problemOf, TestLimiter } from './brains.js';
import { createProviderOpsModule } from './server.js';

const fixtures = (p: string) =>
  join(import.meta.dirname, '..', '..', '..', 'providers', p, 'src', '__fixtures__');
const claude = () =>
  new ClaudeProvider({
    command: [process.execPath, join(fixtures('claude'), 'fake-claude.mjs')],
    killGraceMs: 200,
    keychain: async () => null,
  });
const codex = () =>
  new CodexProvider({
    command: [process.execPath, join(fixtures('codex'), 'fake-codex.mjs')],
    killGraceMs: 200,
  });

let s: TestServer | null = null;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (s) rmSync(`${s.home}-accounts`, { recursive: true, force: true });
  await s?.cleanup();
  s = null;
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

/** a brain that answers with one scripted error (or hangs), for the test's problem mapping */
function failing(
  id: string,
  ev: Extract<ProviderEvent, { type: 'error' }> | 'hang',
  status?: ProviderStatus,
) {
  const a: ProviderAdapter = {
    id: id as ProviderAdapter['id'],
    displayName: id,
    detect: async () => status ?? { installed: true, signedIn: true },
    capabilities: () => new FakeProvider().capabilities(),
    async *runTurn(_input, signal) {
      if (ev === 'hang') {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        yield { type: 'done', stop: 'cancelled' };
        return;
      }
      yield ev;
      yield { type: 'done', stop: 'error' };
    },
  };
  return a;
}

describe('provider-ops: Brains page', () => {
  it('lists every brain with its real state, version, fix commands and who uses it (owner only)', async () => {
    vi.stubEnv('FAKE_CLAUDE_AUTH', 'in');
    vi.stubEnv('FAKE_CODEX_LOGGED_OUT', '1');
    const local = failing('local:abc', 'hang', { installed: false, signedIn: 'unknown', reachable: false });
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0 })],
      providers: [
        claude(),
        codex(),
        createGeminiProvider({ command: ['pb-no-such-gemini', '--acp'] }),
        local,
        new FakeProvider(),
      ],
    });
    const owner = seedUser(s.db);
    const member = seedUser(s.db, 'member', 'Mem');
    const tala = { id: seedAgent(s.db, { slug: 'tala', providerId: 'claude' }) };
    const o = api(owner.token);
    expect(
      (
        await o('PUT', `/api/m/provider-ops/agents/${tala.id}`, {
          fallback: [{ providerId: 'fake' }],
          accountId: null,
          compactPct: null,
          compactTokens: null,
        })
      ).status,
    ).toBe(200);
    expect((await api(member.token)('GET', '/api/m/provider-ops/brains')).status).toBe(403);

    const r = await o('GET', '/api/m/provider-ops/brains?lang=en');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.json.brains.map((b: any) => [b.id, b]));
    expect(r.json.brains.map((b: any) => b.id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'grok',
      'local',
      'acp',
      'fake',
    ]);
    expect(by.claude).toMatchObject({
      name: 'Claude',
      monogram: 'Cl',
      state: 'ready',
      unconfirmed: false,
      version: '2.1.0',
      signInCmd: ['claude'],
      usedBy: [{ id: tala.id, name: 'tala', role: 'main' }],
    });
    expect(by.codex).toMatchObject({
      state: 'needs_sign_in',
      version: '0.167.0',
      signInCmd: ['codex', 'login'],
    });
    expect(by.gemini).toMatchObject({
      state: 'not_installed',
      installCmd: ['npm', 'install', '-g', '@google/gemini-cli'],
    });
    // no adapter registered at all: still a tile, with the way to get it
    expect(by.opencode).toMatchObject({ state: 'not_installed', installer: 'starter', providers: [] });
    expect(by.grok).toMatchObject({ state: 'not_installed', vaultKey: 'XAI_API_KEY' });
    expect(by.local).toMatchObject({
      state: 'unreachable',
      providers: [{ id: 'local:abc', state: 'unreachable' }],
    });
    expect(by.acp).toMatchObject({ state: 'not_installed', providers: [] });
    expect(by.fake).toMatchObject({ state: 'ready', usedBy: [{ id: tala.id, role: 'backup' }] });
    expect(by.claude.description).toMatch(/Claude/);
    // nothing of the CLIs' sign-in output reaches the page
    expect(JSON.stringify(r.json)).not.toMatch(/authMethod|Logged in using/);
  });

  it('Test: one tool-less prompt through the real adapter, no run/message/session kept, problems named', async () => {
    vi.stubEnv('FAKE_CLAUDE_AUTH', 'in');
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0, testTimeoutMs: 300, testsPerMinute: 50 })],
      providers: [
        claude(),
        new FakeProvider({ deltaMs: 1 }),
        createGeminiProvider({ command: ['pb-no-such-gemini', '--acp'] }),
        failing('acp:auth', { type: 'error', kind: 'auth', message: 'Not logged in' }),
        failing('acp:limit', { type: 'error', kind: 'quota', message: 'usage limit reached' }),
        failing('acp:reset', {
          type: 'error',
          kind: 'rate_limit',
          message: 'usage limit reached, resets in 2h',
          retryAfterMs: 7_200_000,
        }),
        failing('acp:offline', { type: 'error', kind: 'offline', message: 'ECONNREFUSED' }),
        failing('acp:model', { type: 'error', kind: 'crash', message: 'Error: model "gpt-x" not found' }),
        failing('acp:hang', 'hang'),
      ],
    });
    const owner = seedUser(s.db);
    const o = api(owner.token);
    const fake = await o('POST', '/api/m/provider-ops/brains/fake/test', {});
    expect(fake.status).toBe(200);
    expect(fake.json.result).toMatchObject({ ok: true, providerId: 'fake' });
    expect(fake.json.result.reply).toContain('Reply with only the word: ready');
    const cl = await o('POST', '/api/m/provider-ops/brains/claude/test', {});
    expect(cl.json.result).toMatchObject({ ok: true, providerId: 'claude' });
    expect(typeof cl.json.result.ms).toBe('number');

    const problem = async (id: string, providerId?: string): Promise<BrainProblem> =>
      (await o('POST', `/api/m/provider-ops/brains/${id}/test`, providerId ? { providerId } : {})).json.result
        .problem;
    expect(await problem('gemini')).toBe('not_installed');
    expect(await problem('grok')).toBe('not_installed'); // no adapter at all
    expect(await problem('acp', 'acp:auth')).toBe('auth');
    expect(await problem('acp', 'acp:limit')).toBe('limit');
    // a limit with a known reset carries the time it resets (the page names it); one without has none
    const t0 = Date.now();
    const reset = (await o('POST', '/api/m/provider-ops/brains/acp/test', { providerId: 'acp:reset' })).json
      .result;
    expect(reset.problem).toBe('limit');
    expect(reset.resetAt).toBeGreaterThanOrEqual(t0 + 7_200_000);
    expect(reset.resetAt).toBeLessThan(Date.now() + 7_200_000 + 1000);
    expect(
      (await o('POST', '/api/m/provider-ops/brains/acp/test', { providerId: 'acp:limit' })).json.result
        .resetAt,
    ).toBeUndefined();
    expect(await problem('acp', 'acp:offline')).toBe('offline');
    expect(await problem('acp', 'acp:model')).toBe('model');
    expect(await problem('acp', 'acp:hang')).toBe('timeout');
    expect((await o('POST', '/api/m/provider-ops/brains/acp/test', { providerId: 'acp:nope' })).status).toBe(
      404,
    );

    // nothing kept: no run rows, no messages, no native sessions, no leftover test workspace
    expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) AS n FROM provider_sessions').get()).toEqual({ n: 0 });
    const ws = join(s.home, 'workspaces');
    expect(existsSync(ws) ? readdirSync(ws).filter((d) => d.startsWith('.brain-test-')) : []).toEqual([]);

    const member = seedUser(s.db, 'member', 'Mem');
    expect((await api(member.token)('POST', '/api/m/provider-ops/brains/fake/test', {})).status).toBe(403);
  });

  it('Test is limited per minute (429), and states map from ProviderStatus as the SPEC says', async () => {
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0, testsPerMinute: 2 })],
      providers: [new FakeProvider({ deltaMs: 1 })],
    });
    const o = api(seedUser(s.db).token);
    expect((await o('POST', '/api/m/provider-ops/brains/fake/test', {})).status).toBe(200);
    expect((await o('POST', '/api/m/provider-ops/brains/fake/test', {})).status).toBe(200);
    const third = await o('POST', '/api/m/provider-ops/brains/fake/test', {});
    expect(third.status).toBe(429);

    expect(brainState({ installed: false, signedIn: false })).toEqual({
      state: 'not_installed',
      unconfirmed: false,
    });
    expect(brainState({ installed: true, signedIn: false })).toEqual({
      state: 'needs_sign_in',
      unconfirmed: false,
    });
    expect(brainState({ installed: true, signedIn: 'unknown' })).toEqual({
      state: 'ready',
      unconfirmed: true,
    });
    expect(brainState({ installed: true, signedIn: 'unknown' }, { noSignIn: true }).unconfirmed).toBe(false);
    expect(brainState({ installed: false, signedIn: 'unknown', reachable: false }).state).toBe('unreachable');
    expect(problemOf({ ok: false, kind: 'crash', message: 'spawn claude ENOENT', ms: 1 })).toBe(
      'not_installed',
    );
    expect(problemOf({ ok: false, kind: 'crash', message: '401 Unauthorized', ms: 1 })).toBe('auth');
    let t = 0;
    const l = new TestLimiter(1, 1000, () => t);
    expect(l.take()).toBe(0);
    expect(l.take()).toBe(1000);
    t = 1001;
    expect(l.take()).toBe(0);
  });
  it('Grok via the vault: the saved XAI_API_KEY signs the tile in and reaches the CLI in a test and in a turn', async () => {
    // a server-env key never reaches the CLI (scrubbed), so it must not read as signed in
    vi.stubEnv('XAI_API_KEY', 'server-env-key-not-passed');
    vi.stubEnv('HOME', join(import.meta.dirname, 'no-such-home'));
    const real = createGrokProvider({ command: [process.execPath, '-e', ''], versionArgs: null });
    expect((await real.detect()).signedIn).toBe('unknown');
    vi.unstubAllEnvs();

    const seen: (string | undefined)[] = [];
    const grok: ProviderAdapter = {
      id: 'grok' as ProviderAdapter['id'],
      displayName: 'Grok',
      keyEnv: ['XAI_API_KEY'],
      detect: async () => ({ installed: true, signedIn: false, hint: 'run `grok` once to sign in' }),
      capabilities: () => new FakeProvider().capabilities(),
      async *runTurn(input) {
        seen.push(input.env.XAI_API_KEY);
        if (input.env.XAI_API_KEY !== 'xai-test-key-123')
          yield { type: 'error', kind: 'auth', message: 'Not logged in' };
        else yield { type: 'text.final', text: 'ready' };
        yield { type: 'done', stop: 'end' };
      },
    };
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0, testsPerMinute: 50 })],
      providers: [grok, new FakeProvider({ deltaMs: 1 })],
    });
    const o = api(seedUser(s.db).token);
    const tile = async () =>
      ((await o('GET', '/api/m/provider-ops/brains')).json.brains as { id: string; state: string }[]).find(
        (b) => b.id === 'grok',
      )!;
    const status = async () =>
      ((await o('GET', '/api/v1/providers')).json.providers as { id: string; status: ProviderStatus }[]).find(
        (p) => p.id === 'grok',
      )!.status;
    // before the key is saved: needs sign-in, and the test fails with auth
    expect((await tile()).state).toBe('needs_sign_in');
    expect((await status()).signedIn).toBe(false);
    expect((await o('POST', '/api/m/provider-ops/brains/grok/test', {})).json.result.problem).toBe('auth');

    // review finding: a `global` entry of that name is a {{secret:NAME}} reference for tools, never a brain key
    // (an agent's process could read it from its env); it neither signs the tile in nor reaches the CLI
    await s.vault.put('global', 'XAI_API_KEY', 'global-ref-not-passed');
    expect((await tile()).state).toBe('needs_sign_in');
    expect((await o('POST', '/api/m/provider-ops/brains/grok/test', {})).json.result.problem).toBe('auth');

    // only the owner's "Key for Grok" (scope brain:grok) is a brain key
    await s.vault.put('brain:grok', 'XAI_API_KEY', 'xai-test-key-123');
    expect((await tile()).state).toBe('ready');
    expect((await status()).signedIn).toBe(true);
    const ok = await o('POST', '/api/m/provider-ops/brains/grok/test', {});
    expect(ok.json.result).toMatchObject({ ok: true, reply: 'ready' });

    // an agent's real turn gets the key too
    const created = await o('POST', '/api/v1/agents', {
      name: 'Gk',
      providerId: 'grok',
      trustLevel: 'trusted',
    });
    expect(created.status).toBe(201);
    // an entry in the agent's own scope (e.g. one it asked for with vault_request_secret) never becomes its env
    await s.vault.put(`agent:${created.json.agent.id}`, 'XAI_API_KEY', 'agent-ref-not-passed');
    await o('POST', `/api/v1/chats/${created.json.chatId}/messages`, { text: 'hi' });
    const end = Date.now() + 5000;
    while (seen.length < 4 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([undefined, undefined, 'xai-test-key-123', 'xai-test-key-123']);
    // the key never comes back in an answer
    expect(JSON.stringify(ok.json)).not.toContain('xai-test-key-123');
  });
  // qa-b problem 1: a signed-out Claude CLI answers its own "Not logged in · Please run /login" as an assistant
  // message (with `error: authentication_failed`) and a result with is_error; Test said "Works. Reply: Not logged in".
  // The fake below prints the exact line shapes the real CLI 2.1.321 printed on this Mac inside the old sandbox.
  it('Test and the runner read a "Not logged in" answer as Needs sign-in, never as Works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-signed-out-'));
    const cli = join(dir, 'signed-out-claude.mjs');
    writeFileSync(
      cli,
      `const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.stdin.once('data', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's-out', apiKeySource: 'none' });
  out({ type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: 's-out', usage: {} });
  process.exit(1);
});
`,
    );
    // a CLI that even ends its turn as a success with only that line (no error at all)
    const quiet: ProviderAdapter = {
      ...failing('acp:quiet', 'hang'),
      async *runTurn() {
        yield { type: 'text.final', text: 'Not logged in. Please run /login' };
        yield { type: 'done', stop: 'end' };
      },
    };
    try {
      s = await bootTestServer({
        // a sign-in failure pauses the brain for one usage-check interval, so the backup takes the item
        modules: [createProviderOpsModule({ checkMs: 60_000, testTimeoutMs: 10_000, testsPerMinute: 50 })],
        providers: [
          new ClaudeProvider({
            command: [process.execPath, cli],
            killGraceMs: 200,
            keychain: async () => null,
          }),
          quiet,
          new FakeProvider({ deltaMs: 1 }),
        ],
      });
      const o = api(seedUser(s.db).token);
      const cl = (await o('POST', '/api/m/provider-ops/brains/claude/test', {})).json.result;
      expect(cl).toMatchObject({ ok: false, problem: 'auth', providerId: 'claude' });
      expect(cl.message).toContain('Not logged in');
      const q = (await o('POST', '/api/m/provider-ops/brains/acp/test', { providerId: 'acp:quiet' })).json
        .result;
      expect(q).toMatchObject({ ok: false, problem: 'auth' });

      // the runner: the signed-out turn fails on sign-in, so the agent's backup brain answers instead
      const created = await o('POST', '/api/v1/agents', {
        name: 'Cl',
        providerId: 'claude',
        trustLevel: 'trusted',
      });
      expect(created.status).toBe(201);
      const agentId = created.json.agent.id as string;
      const put = await o('PUT', `/api/m/provider-ops/agents/${agentId}`, {
        fallback: [{ providerId: 'fake' }],
        accountId: null,
        compactPct: null,
        compactTokens: null,
      });
      expect(put.status).toBe(200);
      // qa-b problem 2: the details panel reads the saved backup here (it is not on the agent row)
      const got = await o('GET', `/api/m/provider-ops/agents/${agentId}`);
      expect(got.json.settings.fallback).toEqual([{ providerId: 'fake' }]);
      expect(created.json.agent.fallback).toEqual([]);
      const member = api(seedUser(s.db, 'member', 'Mem').token);
      expect((await member('GET', `/api/m/provider-ops/agents/${agentId}`)).status).toBe(403);
      expect((await o('GET', '/api/m/provider-ops/agents/nope')).status).toBe(404);
      await o('POST', `/api/v1/chats/${created.json.chatId}/messages`, { text: 'hi' });
      const runs = () =>
        s!.db
          .prepare('SELECT provider_id AS p, state FROM runs WHERE agent_id = ? ORDER BY started_at')
          .all(agentId) as { p: string; state: string }[];
      const end = Date.now() + 8000;
      while (!runs().some((r) => r.p === 'fake' && r.state === 'done') && Date.now() < end)
        await new Promise((r) => setTimeout(r, 20));
      expect(runs()).toEqual([
        { p: 'claude', state: 'failed' },
        { p: 'fake', state: 'done' },
      ]);

      // a turn that "succeeds" with only the sign-in line is a failed run (auth), not the agent's answer
      const q2 = await o('POST', '/api/v1/agents', {
        name: 'Q',
        providerId: 'acp:quiet',
        trustLevel: 'trusted',
      });
      await o('POST', `/api/v1/chats/${q2.json.chatId}/messages`, { text: 'hi' });
      const qRun = () =>
        s!.db.prepare('SELECT state FROM runs WHERE agent_id = ?').get(q2.json.agent.id) as
          | { state: string }
          | undefined;
      const end2 = Date.now() + 8000;
      while (!['failed', 'done'].includes(qRun()?.state ?? '') && Date.now() < end2)
        await new Promise((r) => setTimeout(r, 20));
      expect(qRun()?.state).toBe('failed');
      const reply = s.db
        .prepare("SELECT status FROM messages WHERE chat_id = ? AND author_kind = 'agent'")
        .get(q2.json.chatId) as { status: string };
      expect(reply.status).toBe('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // qa w19 run 7: the user's `claude` (a wrapper that brings its own token) and `codex` (a login kept outside its
  // auth.json) work outside, but a turn runs on PasaBot's clean config dir and is signed out: detection and Test must
  // ask the way a turn runs, so the tiles say Needs sign-in before anything has failed, and Test never says Works
  it('detection and Test run the way a turn runs: a CLI signed in only outside the clean config dir reads Needs sign-in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-turn-env-'));
    const TOKEN = 'sk-ant-oat01-setup-token-turn-env';
    const cl = join(dir, 'outside-only-claude.mjs');
    writeFileSync(
      cl,
      `const a = process.argv.slice(2);
// signed in with the user's own config (no CLAUDE_CONFIG_DIR), or with a setup token the runner hands over
const ok = !process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(TOKEN)};
if (a.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: ok })); process.exit(0); }
process.stdin.once('data', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const text = ok ? 'ready' : 'Not logged in · Please run /login';
  out({ type: 'system', subtype: 'init', session_id: 's-env' });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: !ok, result: text, session_id: 's-env', usage: {} });
  process.exit(ok ? 0 : 1);
});
`,
    );
    const cx = join(dir, 'outside-only-codex.mjs');
    writeFileSync(
      cx,
      `const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('codex-cli 0.155.0'); process.exit(0); }
// signed in only with the user's own CODEX_HOME (e.g. a keyring login), never on the turn's clean one
if (a[0] === 'login' && a[1] === 'status') process.exit(process.env.CODEX_HOME ? 1 : 0);
process.exit(1);
`,
    );
    try {
      s = await bootTestServer({
        modules: [createProviderOpsModule({ checkMs: 0, testTimeoutMs: 10_000, testsPerMinute: 50 })],
        providers: [
          new ClaudeProvider({
            command: [process.execPath, cl],
            killGraceMs: 200,
            keychain: async () => null,
          }),
          new CodexProvider({ command: [process.execPath, cx], killGraceMs: 200 }),
          new FakeProvider({ deltaMs: 1 }),
        ],
      });
      // outside the turn environment both CLIs really are signed in: only the turn's way of asking can tell
      expect((await new ClaudeProvider({ command: [process.execPath, cl] }).detect()).signedIn).toBe(true);
      expect((await new CodexProvider({ command: [process.execPath, cx] }).detect()).signedIn).toBe(true);
      const o = api(seedUser(s.db).token);
      const tiles = async () =>
        (
          (await o('GET', '/api/m/provider-ops/brains')).json.brains as {
            id: string;
            state: string;
            failedSignIn: boolean;
            signInCmd?: string[];
            vaultKey?: string;
          }[]
        ).filter((b) => b.id === 'claude' || b.id === 'codex');
      const signedIn = async (id: string) =>
        (
          (await o('GET', '/api/v1/providers')).json.providers as { id: string; status: ProviderStatus }[]
        ).find((p) => p.id === id)!.status.signedIn;
      // before any test or turn: Needs sign-in, with the steps (the app's own sign-in; for Claude also the token)
      const [tc, tx] = await tiles();
      expect(tc).toMatchObject({ id: 'claude', state: 'needs_sign_in', failedSignIn: false });
      expect(tc!.signInCmd?.length).toBeGreaterThan(0);
      expect(tc!.vaultKey).toBe('CLAUDE_CODE_OAUTH_TOKEN');
      expect(tx).toMatchObject({ id: 'codex', state: 'needs_sign_in', failedSignIn: false });
      expect(tx!.signInCmd?.length).toBeGreaterThan(0);
      expect(await signedIn('claude')).toBe(false);
      expect(await signedIn('codex')).toBe(false);
      // Test runs a real turn the same way: never Works
      const bad = await o('POST', '/api/m/provider-ops/brains/claude/test', {});
      expect(bad.json.result).toMatchObject({ ok: false, problem: 'auth' });
      // the setup token (vault, the brain's own scope) is the sign-in a turn gets: Ready, and Test works
      await s.vault.put('brain:claude', 'CLAUDE_CODE_OAUTH_TOKEN', TOKEN);
      expect((await tiles())[0]).toMatchObject({ id: 'claude', state: 'ready', failedSignIn: false });
      const ok = await o('POST', '/api/m/provider-ops/brains/claude/test', {});
      expect(ok.json.result).toMatchObject({ ok: true, reply: 'ready' });
      expect(JSON.stringify(ok.json)).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // qa-a 1c: `claude auth status` said logged in (a wrapper script outside the sandbox) while turns were signed out,
  // and the tile and the agent header kept saying Ready after the Test and a real turn failed on sign-in
  it('a Claude test or turn that fails on sign-in reads Needs sign-in until one works; a setup token signs it in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-claude-token-'));
    const cli = join(dir, 'wrapped-claude.mjs');
    const TOKEN = 'sk-ant-oat01-setup-token-test-xyz';
    writeFileSync(
      cli,
      `const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.stdin.once('data', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const ok = process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(TOKEN)};
  const text = ok ? 'ready' : 'Not logged in · Please run /login';
  out({ type: 'system', subtype: 'init', session_id: 's-tok' });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: !ok, result: text, session_id: 's-tok', usage: {} });
  process.exit(ok ? 0 : 1);
});
`,
    );
    try {
      s = await bootTestServer({
        modules: [createProviderOpsModule({ checkMs: 0, testTimeoutMs: 10_000, testsPerMinute: 50 })],
        providers: [
          new ClaudeProvider({
            command: [process.execPath, cli],
            killGraceMs: 200,
            keychain: async () => null,
          }),
          new FakeProvider({ deltaMs: 1 }),
        ],
      });
      const o = api(seedUser(s.db).token);
      const tile = async () =>
        (
          (await o('GET', '/api/m/provider-ops/brains')).json.brains as {
            id: string;
            state: string;
            failedSignIn: boolean;
            vaultKey?: string;
          }[]
        ).find((b) => b.id === 'claude')!;
      const signedIn = async () =>
        (
          (await o('GET', '/api/v1/providers')).json.providers as { id: string; status: ProviderStatus }[]
        ).find((p) => p.id === 'claude')!.status.signedIn;
      // the CLI says logged in: Ready until something really runs
      expect(await tile()).toMatchObject({
        state: 'ready',
        failedSignIn: false,
        vaultKey: 'CLAUDE_CODE_OAUTH_TOKEN',
      });
      // a real turn fails on sign-in: the agent header (providers) and the tile both flip
      const created = await o('POST', '/api/v1/agents', {
        name: 'Cl',
        providerId: 'claude',
        trustLevel: 'trusted',
      });
      expect(created.status).toBe(201);
      await o('POST', `/api/v1/chats/${created.json.chatId}/messages`, { text: 'hi' });
      const end = Date.now() + 8000;
      while ((await signedIn()) !== false && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
      expect(await signedIn()).toBe(false);
      expect(await tile()).toMatchObject({ state: 'needs_sign_in', failedSignIn: true });
      // a check that fails again keeps it remembered (the CLI still says logged in)
      expect((await o('POST', '/api/m/provider-ops/brains/claude/test', {})).json.result.problem).toBe(
        'auth',
      );
      expect((await tile()).state).toBe('needs_sign_in');
      // the setup token goes into the brain's own vault scope: what failed was the old sign-in
      const saved = await s.vault.put('brain:claude', 'CLAUDE_CODE_OAUTH_TOKEN', TOKEN);
      expect(await tile()).toMatchObject({ state: 'ready', failedSignIn: false });
      const ok = await o('POST', '/api/m/provider-ops/brains/claude/test', {});
      expect(ok.json.result).toMatchObject({ ok: true, reply: 'ready' });
      expect(await tile()).toMatchObject({ state: 'ready', failedSignIn: false });
      expect(await signedIn()).toBe(true);
      // a test that fails on sign-in flips it again (the token was removed)
      expect(await s.vault.remove(saved.id)).toBe(true);
      const bad = await o('POST', '/api/m/provider-ops/brains/claude/test', {});
      expect(bad.json.result).toMatchObject({ ok: false, problem: 'auth' });
      expect(await tile()).toMatchObject({ state: 'needs_sign_in', failedSignIn: true });
      // the token never comes back in any answer
      for (const r of [
        ok,
        bad,
        await o('GET', '/api/m/provider-ops/brains'),
        await o('GET', '/api/v1/providers'),
      ])
        expect(JSON.stringify(r.json)).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Test: a brain that ends at once without a word is a crash, not a timeout', async () => {
    const silent: ProviderAdapter = {
      ...failing('acp:silent', 'hang'),
      async *runTurn() {
        yield { type: 'done', stop: 'end' };
      },
    };
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0, testTimeoutMs: 30_000, testsPerMinute: 50 })],
      providers: [silent],
    });
    const o = api(seedUser(s.db).token);
    const r = (await o('POST', '/api/m/provider-ops/brains/acp/test', { providerId: 'acp:silent' })).json
      .result;
    expect(r).toMatchObject({ ok: false, problem: 'crash' });
    expect(r.ms).toBeLessThan(30_000);
  });
});
