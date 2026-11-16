/**
 * W21 done-criteria: `pasabot run tala "sum 2+2" --wait` prints the Fake reply; a revoked or expired token 401; a
 * request with `Origin` refused; non-loopback without `remote_ok` refused; the 31st run in an hour 429; an
 * automation turn cannot auto-approve tier 3. Plus the owner-only REST, the per-agent switch, run isolation between
 * tokens, and the event stream.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedAgent, seedUser, type TestServer } from '../../../packages/testkit/src/index.js';
import { createAutomationModule } from './server.js';

const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const cliMain = fileURLToPath(new URL('../../../apps/cli/src/main.ts', import.meta.url));

type Json = Record<string, any>;
async function call(
  s: TestServer,
  path: string,
  o: { token: string; method?: string; body?: unknown; headers?: Record<string, string> },
) {
  const r = await fetch(`${s.url}/api/m/automation${path}`, {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${o.token}`,
      ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as Json, headers: r.headers };
}

/** Run the real `pasabot` CLI from source; the child always exits (or is killed) before this resolves. */
function cli(args: string[], env: Record<string, string>, timeoutMs = 30_000) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', cliMain, ...args], {
      cwd: moduleRoot,
      env: { ...process.env, ...env, PASABOT_AUTOMATION_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code, out, err });
    });
  });
}

/**
 * Run `pasabot` with a piped stdin: `onOut` sees stdout as it grows and may answer through `write`. The child always
 * exits (or is killed) before this resolves.
 */
function cliTalk(
  args: string[],
  env: Record<string, string>,
  onOut: (out: string, write: (s: string) => void, end: () => void) => void,
  timeoutMs = 30_000,
) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', cliMain, ...args], {
      cwd: moduleRoot,
      env: { ...process.env, ...env, PASABOT_AUTOMATION_TOKEN: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const write = (s: string) => child.stdin.write(s);
    const end = () => child.stdin.end();
    child.stdout.on('data', (d) => {
      out += d;
      onOut(out, write, end);
    });
    child.stderr.on('data', (d) => (err += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code, out, err });
    });
  });
}

describe('automation API + CLI', () => {
  let s: TestServer;
  let ownerTok: string;
  let memberTok: string;
  let tala: string;
  const mod = createAutomationModule();
  const OWNER_PASSWORD = 'test-only owner password';
  const issue = async (agentId: string, extra: Json = {}) => {
    const r = await call(s, '/tokens', { token: ownerTok, body: { agentId, label: 'test', ...extra } });
    expect(r.status).toBe(201);
    return r.json as { token: string; info: { id: string } };
  };
  const on = (agentId: string, enabled = true) =>
    call(s, `/agents/${agentId}`, { token: ownerTok, method: 'PUT', body: { enabled } });

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider({ deltaMs: 2 })], modules: [mod] });
    // the owner has a password (pairing asks for a fresh re-auth); the seeded session never proved it
    const made = await fetch(`${s.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: /token=([\w-]+)/.exec(s.setupLink ?? '')?.[1],
        displayName: 'PitsPets',
        password: OWNER_PASSWORD,
      }),
    });
    expect(made.status).toBe(200);
    ownerTok = seedUser(s.db).token;
    memberTok = seedUser(s.db, 'member', 'M').token;
    tala = seedAgent(s.db, { slug: 'tala' });
  });
  afterAll(() => s.cleanup());

  it('only the owner manages the switch and tokens; issuing needs the switch on; the raw token is shown once', async () => {
    expect((await call(s, '/agents', { token: memberTok })).status).toBe(403);
    expect((await call(s, '/tokens', { token: memberTok, body: { agentId: tala, label: 'x' } })).status).toBe(
      403,
    );
    const off = await call(s, '/tokens', { token: ownerTok, body: { agentId: tala, label: 'x' } });
    expect(off.status).toBe(409);
    expect(off.json.error).toBe('automation_off');
    expect((await on(tala)).json.agent).toMatchObject({ slug: 'tala', enabled: true });
    // trust above standard is not even accepted by the schema
    expect(
      (await call(s, '/tokens', { token: ownerTok, body: { agentId: tala, label: 'x', trust: 'trusted' } }))
        .status,
    ).toBe(400);
    const { token, info } = await issue(tala);
    expect(info).toMatchObject({
      agentId: tala,
      trust: 'standard',
      scopes: ['runs'],
      label: 'test',
      active: true,
    });
    const list = await call(s, '/tokens', { token: ownerTok });
    expect(JSON.stringify(list.json)).not.toContain(token);
    // an automation token cannot reach the owner routes (widening is owner-session only)
    expect((await call(s, '/tokens', { token })).status).toBe(401);
    expect((await call(s, `/agents/${tala}`, { token, method: 'PUT', body: { enabled: true } })).status).toBe(
      401,
    );
  });

  it('`pasabot run tala "sum 2+2" --wait` prints the Fake reply (token created through `pasabot token create`)', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'pasabot-cli-'));
    try {
      mkdirSync(join(cfg, 'pasabot'), { recursive: true });
      writeFileSync(join(cfg, 'pasabot', 'session.json'), JSON.stringify({ url: s.url, token: ownerTok }));
      // `pasabot pair` re-auths with PASABOT_PASSWORD when the server answers reauth_required
      const env = { XDG_CONFIG_HOME: cfg, PASABOT_URL: s.url, PASABOT_PASSWORD: OWNER_PASSWORD };
      const made = await cli(['token', 'create', 'tala', '--label', 'laptop'], env);
      expect(made.code, made.err).toBe(0);
      expect(statSync(join(cfg, 'pasabot', 'automation.json')).mode & 0o777).toBe(0o600);
      const listed = await cli(['list'], env);
      expect(listed.out).toMatch(/tala .* automation on .*\(token saved here\)/);
      const r = await cli(['run', 'tala', 'sum 2+2', '--wait'], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out.trim()).toBe('echo: sum 2+2');
      const streamed = await cli(['run', 'tala', 'stream me', '--stream'], env);
      expect(streamed.code, streamed.err).toBe(0);
      expect(streamed.out.trim()).toBe('echo: stream me');
      // `pasabot pair` prints a terminal QR of the pairing link; the code in it is claimable by a phone
      const paired = await cli(['pair', '--no-wait'], env);
      expect(paired.code, paired.err).toBe(0);
      expect(paired.out).toMatch(/[▀▄█]/);
      const code = /#\/pair\?code=([A-Za-z0-9]+)/.exec(paired.out)?.[1];
      expect(code).toBeTruthy();
      const claim = await fetch(`${s.url}/api/v1/pairing/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: 'Phone' }),
      });
      expect(claim.status).toBe(200);
      // default setup: the link is the server's loopback address, and the CLI says a phone cannot open it
      expect(paired.err).toMatch(/cannot open it.*PASABOT_PUBLIC_URL.*--url/s);
      // the CLI refuses another agent's name for this token
      const other = seedAgent(s.db, { slug: 'ligaya' });
      expect((await cli(['run', 'ligaya', 'hi', '--wait'], env)).code).not.toBe(0);
      expect(other).toBeTruthy();
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('`pasabot pair` confirms only the claim made on its own code, never an older pending one, and has no --yes', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'pasabot-cli-'));
    const claimCode = async (code: string, deviceName: string) => {
      const r = await fetch(`${s.url}/api/v1/pairing/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName }),
      });
      expect(r.status).toBe(200);
      return (await r.json()) as { claimId: string; claimSecret: string };
    };
    const sessionState = async (c: { claimId: string; claimSecret: string }) =>
      (
        await fetch(`${s.url}/api/v1/pairing/claims/${c.claimId}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claimSecret: c.claimSecret }),
        })
      ).status;
    try {
      mkdirSync(join(cfg, 'pasabot'), { recursive: true });
      writeFileSync(join(cfg, 'pasabot', 'session.json'), JSON.stringify({ url: s.url, token: ownerTok }));
      const env = { XDG_CONFIG_HOME: cfg, PASABOT_URL: s.url, PASABOT_PASSWORD: OWNER_PASSWORD };
      // the owner's session confirms it's you first (pairing needs a fresh re-auth)
      const fresh = await fetch(`${s.url}/api/v1/auth/reauth`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerTok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password: OWNER_PASSWORD }),
      });
      expect(fresh.status).toBe(200);
      // an attacker saw an earlier code and claimed it with a familiar name; that claim stays pending
      const old = await fetch(`${s.url}/api/v1/pairing`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerTok}`, 'content-type': 'application/json' },
        body: '{}',
      });
      const thief = await claimCode(((await old.json()) as { code: string }).code, 'Boss iPhone');
      // --yes is gone: nothing is ever confirmed without the owner reading the claim
      const yes = await cli(['pair', '--yes'], env);
      expect(yes.code).not.toBe(0);
      expect(yes.err).toMatch(/--yes is not supported/);
      let phone: Promise<{ claimId: string; claimSecret: string }> | null = null;
      let prompted = '';
      const r = await cliTalk(['pair', '--url', 'http://192.168.1.20:7777'], env, (out, write, end) => {
        const code = /#\/pair\?code=([A-Za-z0-9]+)/.exec(out)?.[1];
        if (code && !phone) phone = claimCode(code, 'Phone');
        if (!prompted && out.includes('[y/N]')) {
          prompted = out;
          write('y\n');
          end();
        }
      });
      expect(r.code, r.err).toBe(0);
      // the link uses the address phones can reach, and the prompt names only this code's claim
      expect(r.out).toContain('http://192.168.1.20:7777/#/pair?code=');
      expect(r.err).not.toMatch(/cannot open it/);
      expect(prompted).toMatch(/"Phone"/);
      expect(prompted).toMatch(/fingerprint [0-9a-f]{4}-/);
      expect(prompted).not.toContain('Boss iPhone');
      expect(r.out).toContain('Paired "Phone"');
      expect(await sessionState(await phone!)).toBe(200);
      // the attacker's claim was never confirmed
      expect(await sessionState(thief)).toBe(202);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('runs: poll with wait, an event stream, and a token sees only its own runs', async () => {
    const a = await issue(tala);
    const b = await issue(tala);
    const started = await call(s, '/runs', { token: a.token, body: { text: 'hello there' } });
    expect(started.status).toBe(202);
    const id = started.json.run.id as string;
    const polled = await call(s, `/runs/${id}?wait=10000`, { token: a.token });
    expect(polled.json.run).toMatchObject({ state: 'done', reply: 'echo: hello there' });
    expect((await call(s, `/runs/${id}`, { token: b.token })).status).toBe(404);
    expect((await call(s, `/runs/${id}/stream`, { token: b.token })).status).toBe(404);
    // the stream of a finished run ends at once with `done`
    const st = await fetch(`${s.url}/api/m/automation/runs/${id}/stream`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(st.headers.get('content-type')).toContain('text/event-stream');
    const body = await st.text();
    expect(body).toContain('event: done');
    expect(body).toContain('echo: hello there');
    // the wrong agent name is refused, and the switch off stops new runs
    expect((await call(s, '/runs', { token: a.token, body: { text: 'x', agent: 'ligaya' } })).status).toBe(
      403,
    );
    await on(tala, false);
    const offRun = await call(s, '/runs', { token: a.token, body: { text: 'x' } });
    expect(offRun.status).toBe(403);
    expect(offRun.json.error).toBe('automation_off');
    await on(tala, true);
  });

  it('a revoked or expired token gets 401', async () => {
    const t = await issue(tala);
    expect((await call(s, '/whoami', { token: t.token })).status).toBe(200);
    expect(
      (await call(s, `/tokens/${t.info.id}/revoke`, { token: ownerTok, body: {} })).json.token.active,
    ).toBe(false);
    expect((await call(s, '/runs', { token: t.token, body: { text: 'x' } })).status).toBe(401);
    const e = await issue(tala);
    s.db.prepare('UPDATE automation_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, e.info.id);
    expect((await call(s, '/runs', { token: e.token, body: { text: 'x' } })).status).toBe(401);
    expect((await call(s, '/whoami', { token: e.token })).status).toBe(401);
  });

  it('a request with an Origin header is refused, even the server’s own origin', async () => {
    const t = await issue(tala);
    const before = (s.db.prepare('SELECT count(*) AS n FROM automation_run').get() as { n: number }).n;
    for (const origin of [new URL(s.url).origin, 'https://evil.example', 'null']) {
      const r = await call(s, '/runs', { token: t.token, body: { text: 'x' }, headers: { origin } });
      expect([401, 403]).toContain(r.status);
      expect((await call(s, '/whoami', { token: t.token, headers: { origin } })).status).toBe(401);
    }
    expect((s.db.prepare('SELECT count(*) AS n FROM automation_run').get() as { n: number }).n).toBe(before);
  });

  it('non-loopback without remote_ok is refused; with remote_ok it runs', async () => {
    const local = await issue(tala);
    const remote = await issue(tala, { remoteOk: true });
    const host = new URL(s.url).host;
    const from = (token: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/m/automation/runs',
        remoteAddress: '100.64.0.7',
        headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ text: 'from the tailnet' }),
      });
    expect((await from(local.token)).statusCode).toBe(401);
    expect((await from(remote.token)).statusCode).toBe(202);
  });

  it('cutting access stops queued runs: revoke and switch-off cancel them, and a dispatch-time check refuses the rest', async () => {
    const agent = seedAgent(s.db, { slug: 'dalisay' });
    await on(agent);
    const start = async (token: string, n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await call(s, '/runs', { token, body: { text: `queued ${i}` } });
        expect(r.status).toBe(202);
        ids.push(r.json.run.id);
      }
      return ids;
    };
    const states = (ids: string[]) => ids.map((id) => s.queue.get(id)?.state);
    const ran = (ids: string[]) =>
      (
        s.db
          .prepare(`SELECT count(*) AS n FROM runs WHERE queue_item_id IN (${ids.map(() => '?').join(',')})`)
          .get(...ids) as { n: number }
      ).n;
    // the agent is busy (queue paused): the leaked token's runs wait in the queue
    s.queue.pause(agent);
    const leaked = await issue(agent);
    const a = await start(leaked.token, 3);
    const revoked = await call(s, `/tokens/${leaked.info.id}/revoke`, { token: ownerTok, body: {} });
    expect(revoked.json).toMatchObject({ token: { active: false }, cancelledRuns: 3 });
    expect(states(a)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    // switch off cancels every unfinished run of the agent, whatever the token
    const other = await issue(agent);
    const b = await start(other.token, 2);
    const off = await call(s, `/agents/${agent}`, {
      token: ownerTok,
      method: 'PUT',
      body: { enabled: false },
    });
    expect(off.json).toMatchObject({ agent: { enabled: false }, cancelledRuns: 2 });
    expect(states(b)).toEqual(['cancelled', 'cancelled']);
    // a token that expires (or is revoked behind the module's back) while its runs wait: refused at dispatch time
    await on(agent);
    const expiring = await issue(agent);
    const c = await start(expiring.token, 2);
    s.db
      .prepare('UPDATE automation_tokens SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, expiring.info.id);
    // the switch turned off directly in the table (no cancel path): also refused at dispatch time
    const fresh = await issue(agent);
    const d = await start(fresh.token, 1);
    s.queue.resume(agent);
    await s.dispatcher.idle();
    expect(c.map((id) => s.queue.get(id))).toMatchObject([
      { state: 'cancelled', error: 'automation token revoked or expired' },
      { state: 'cancelled', error: 'automation token revoked or expired' },
    ]);
    expect(s.queue.get(d[0]!)?.state).toBe('done');
    s.queue.pause(agent);
    const e = await start(fresh.token, 1);
    s.db.prepare('UPDATE automation_agent SET enabled = 0 WHERE agent_id = ?').run(agent);
    s.queue.resume(agent);
    await s.dispatcher.idle();
    expect(s.queue.get(e[0]!)).toMatchObject({
      state: 'cancelled',
      error: 'automation is off for this agent',
    });
    // none of the cut-off runs ever started a turn
    expect(ran([...a, ...b, ...c, ...e])).toBe(0);
  });

  it('the 31st run in an hour gets 429 with Retry-After', async () => {
    const t = await issue(tala);
    for (let i = 0; i < 30; i++) {
      const r = await call(s, '/runs', { token: t.token, body: { text: `n${i}` } });
      expect(r.status, `run ${i + 1}`).toBe(202);
    }
    const r = await call(s, '/runs', { token: t.token, body: { text: 'one too many' } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3500);
    // another token of the same agent has its own budget
    expect((await call(s, '/runs', { token: (await issue(tala)).token, body: { text: 'ok' } })).status).toBe(
      202,
    );
  });

  it('an automation turn cannot auto-approve tier 3, even on a trusted agent', async () => {
    const trusted = seedAgent(s.db, { slug: 'bayani', trust: 'trusted' });
    await on(trusted);
    const t = await issue(trusted);
    const asked = new Promise<Json>((resolve) => {
      const off = s.bus.subscribe((ev) => {
        if (ev.type === 'approval.requested' && (ev.data as Json).agentId === trusted) {
          off();
          resolve(ev.data as Json);
        }
      });
    });
    const text = JSON.stringify({
      fakeScript: [
        { expectPermission: { tool: 'Read', input: { file_path: '/etc/hosts' }, decision: 'deny' } },
        { event: { type: 'text.final', text: 'not allowed' } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
    const started = await call(s, '/runs', { token: t.token, body: { text } });
    expect(started.status).toBe(202);
    const a = await asked;
    expect(a).toMatchObject({ tier: 3, state: 'pending' });
    // the owner says no; the run finishes with the provider having received `deny`
    s.approvals.decide(a.id, 'denied', 'owner');
    const done = await call(s, `/runs/${started.json.run.id}?wait=10000`, { token: t.token });
    expect(done.json.run.state).toBe('done');
    const ev = s.db
      .prepare(
        "SELECT data FROM run_events WHERE type = 'permission' AND run_id IN (SELECT id FROM runs WHERE queue_item_id = ?)",
      )
      .get(started.json.run.id) as { data: string };
    expect(JSON.parse(ev.data)).toMatchObject({ tier: 3, decision: 'deny' });
  });
});
