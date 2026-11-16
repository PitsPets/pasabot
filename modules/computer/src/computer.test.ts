/**
 * W16 through a booted server: agent tools over `/mcp` (every action asks the owner, tier 3, at every trust level),
 * the practice display's test app, the action log, and the owner-only viewer REST.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleHost, ToolDef } from '@pasabot/core';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRACTICE, PracticeDriver } from './drivers/practice.js';
import type { ManagedDriver } from './drivers/types.js';
import { pngSize } from './png.js';
import { createComputerModule } from './server.js';

type Rpc = { error?: string } & Record<string, any>;
const rpc = async (url: string, bearer: string, name: string, args: unknown): Promise<Rpc> => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = j.result.content[0]!.text;
  return j.result.isError ? { error: text } : JSON.parse(text);
};

describe('computer module (tools over /mcp + owner viewer REST)', () => {
  let s: TestServer;
  let owner: string;
  let member: string;
  let ws: string;
  const drivers = new Map<string, PracticeDriver>();
  let tala: { id: string; token: string };
  let guarded: { id: string; token: string };
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/computer${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const run = (agentId: string, sender = { kind: 'owner', trust: 'trusted' }) => {
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'x', name: 'Someone', ...sender } }), runId);
    return token;
  };
  /** the call must ask first: wait for the approval, answer it, return its tier and the tool's result */
  const asked = async (agentId: string, call: Promise<Rpc>, decision: 'approved' | 'denied' = 'approved') => {
    let row: { id: string; tier: number } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(agentId) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error('no approval was asked');
    // the server's own service (the REST approve route checks the owner's re-auth first; Playwright covers that)
    s.approvals.decide(row.id, decision, 'owner');
    return { tier: row.tier, result: await call };
  };
  const actions = () =>
    s.db.prepare('SELECT actor, kind, detail, ok FROM computer_action ORDER BY at, id').all() as {
      actor: string;
      kind: string;
      detail: string;
      ok: number;
    }[];

  beforeAll(async () => {
    s = await bootTestServer({
      modules: [
        createComputerModule({
          driver: 'practice',
          create: (_k, agentId) => {
            const d = new PracticeDriver();
            drivers.set(agentId, d);
            return d as ManagedDriver;
          },
        }),
      ],
    });
    owner = seedUser(s.db).token;
    member = seedUser(s.db, 'member', 'Member').token;
    ws = mkdtempSync(join(tmpdir(), 'pasabot-computer-ws-'));
    const tid = seedAgent(s.db, { trust: 'trusted', slug: 'tala' });
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(ws, tid);
    const gid = seedAgent(s.db, { trust: 'guarded', slug: 'ligaya' });
    tala = { id: tid, token: run(tid) };
    guarded = { id: gid, token: run(gid) };
  });
  afterAll(async () => {
    await s.cleanup();
    rmSync(ws, { recursive: true, force: true });
  });

  it('display info needs no approval and says no display is running yet', async () => {
    const r = await rpc(s.url, tala.token, 'computer_display', {});
    expect(r).toEqual({ available: true, running: false });
    expect(s.db.prepare("SELECT count(*) AS n FROM approvals WHERE state = 'pending'").get()).toEqual({
      n: 0,
    });
  });

  it('a trusted agent on an owner turn still asks (tier 3) before a screenshot; the PNG lands in its workspace', async () => {
    const { tier, result } = await asked(tala.id, rpc(s.url, tala.token, 'computer_screenshot', {}));
    expect(tier).toBe(3);
    expect(result.width).toBe(PRACTICE.width);
    expect(result.path.startsWith(join(ws, '.pasabot', 'computer'))).toBe(true);
    expect(pngSize(readFileSync(result.path))).toEqual({ width: PRACTICE.width, height: PRACTICE.height });
    expect(result.pngBase64).toBeUndefined();
  });

  it('the agent clicks the test app button after approval; a denied click never reaches the display', async () => {
    const b = PRACTICE.button;
    const denied = await asked(
      tala.id,
      rpc(s.url, tala.token, 'computer_click', { x: b.x + 5, y: b.y + 5 }),
      'denied',
    );
    expect(denied.tier).toBe(3);
    expect(denied.result.error).toMatch(/not approved/);
    expect(drivers.get(tala.id)!.app.presses).toBe(0);

    const ok = await asked(tala.id, rpc(s.url, tala.token, 'computer_click', { x: b.x + 10, y: b.y + 10 }));
    expect(ok.tier).toBe(3);
    expect(ok.result).toEqual({ ok: true, display: { width: PRACTICE.width, height: PRACTICE.height } });
    expect(drivers.get(tala.id)!.app.presses).toBe(1);
  });

  it('move, type and key each ask (tier 3); typed text never reaches the action log, only its length', async () => {
    await s.vault.put('agent:x', 'shop_key', 'sk-live-supersecretvalue-123456');
    for (const [name, args] of [
      ['computer_move', { x: 5, y: 5 }],
      ['computer_type', { text: 'pay with sk-live-supersecretvalue-123456' }],
      ['computer_key', { keys: 'ctrl+a Return' }],
    ] as const) {
      const r = await asked(tala.id, rpc(s.url, tala.token, name, args));
      expect(r.tier).toBe(3);
      expect(r.result.ok).toBe(true);
    }
    expect(drivers.get(tala.id)!.app.keys).toEqual(['ctrl+a Return']);
    const log = actions();
    const typed = log.find((a) => a.kind === 'type')!;
    expect(typed.detail).toBe('type (40 characters)');
    expect(JSON.stringify(s.db.prepare('SELECT action FROM approvals').all())).not.toContain(
      'supersecretvalue',
    );
  });

  it('a guarded agent asks too, and bad input fails before any approval', async () => {
    const r = await asked(guarded.id, rpc(s.url, guarded.token, 'computer_move', { x: 1, y: 1 }));
    expect(r.tier).toBe(3);
    const bad = await rpc(s.url, guarded.token, 'computer_move', { x: -1, y: 1 });
    expect(bad.error).toMatch(/invalid input/); // schema check: no approval is asked
    const many = await asked(
      guarded.id,
      rpc(s.url, guarded.token, 'computer_key', { keys: `ctrl+a${' x'.repeat(20)}` }),
    );
    expect(many.result.error).toMatch(/more than 16 keys/);
    const inject = await asked(guarded.id, rpc(s.url, guarded.token, 'computer_key', { keys: '--help' }));
    expect(inject.result.error).toMatch(/cannot start with "-"/);
    expect(drivers.get(guarded.id)!.app.keys).toEqual([]);
    const off = await asked(guarded.id, rpc(s.url, guarded.token, 'computer_click', { x: 9999, y: 1 }));
    expect(off.result.error).toMatch(/outside the 640x400 display/);
  });

  it('the owner sees both displays, live frames and the action log; members get 403', async () => {
    const st = (await (await api('/status')).json()) as { driver: string; displays: { agentId: string }[] };
    expect(st.driver).toBe('practice');
    expect(st.displays.map((d) => d.agentId).sort()).toEqual([tala.id, guarded.id].sort());
    const f = await api(`/displays/${tala.id}/frame`);
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('image/png');
    expect(f.headers.get('cache-control')).toBe('no-store');
    expect(pngSize(new Uint8Array(await f.arrayBuffer()))).toEqual({ width: 640, height: 400 });
    const list = (await (await api(`/actions?agentId=${tala.id}`)).json()) as {
      actions: { actor: string; kind: string; agentName: string; detail: string }[];
    };
    expect(list.actions[0]).toMatchObject({ actor: 'agent', kind: 'key', agentName: 'tala' });
    expect(list.actions.map((a) => a.kind)).toContain('screenshot');

    for (const [path, init] of [
      ['/status', {}],
      [`/displays/${tala.id}/frame`, {}],
      ['/actions', {}],
      [`/displays/${tala.id}/stop`, { method: 'POST' }],
      [`/displays/${tala.id}/act`, { method: 'POST', body: JSON.stringify({ kind: 'move', x: 1, y: 1 }) }],
      [`/macos/${tala.id}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) }],
    ] as const)
      expect((await api(path, init as RequestInit, member)).status).toBe(403);
    expect((await fetch(`${s.url}/api/m/computer/status`)).status).toBe(401);
  });

  it('the owner takes control from the viewer (logged as the owner) and stops a display', async () => {
    const b = PRACTICE.button;
    const r = await api(`/displays/${tala.id}/act`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'click', x: b.x + 1, y: b.y + 1 }),
    });
    expect(r.status).toBe(200);
    expect(drivers.get(tala.id)!.app.presses).toBe(2);
    expect(actions().at(-1)).toMatchObject({ actor: 'owner', kind: 'click', ok: 1 });
    // the owner logs the agent's display into a site: the password is typed, never stored or listed
    const typed = await api(`/displays/${tala.id}/act`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'type', text: 'hunter2-real-password' }),
    });
    expect(typed.status).toBe(200);
    expect(drivers.get(tala.id)!.app.typed).toContain('hunter2-real-password');
    expect(actions().at(-1)).toEqual({ actor: 'owner', kind: 'type', detail: 'type (21 characters)', ok: 1 });
    expect(JSON.stringify(s.db.prepare('SELECT * FROM computer_action').all())).not.toContain('hunter2');
    expect(await (await api('/actions')).text()).not.toContain('hunter2');
    expect(
      (await api('/displays/nobody/act', { method: 'POST', body: '{"kind":"move","x":1,"y":1}' })).status,
    ).toBe(404);
    expect((await api(`/displays/${tala.id}/stop`, { method: 'POST' })).status).toBe(200);
    expect(drivers.get(tala.id)!.alive()).toBe(false);
    expect((await api(`/displays/${tala.id}/frame`)).status).toBe(404);
  });

  it('turning on control of this Mac for an agent needs a fresh re-auth; turning it off does not', async () => {
    const on = await api(`/macos/${tala.id}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(401);
    expect(((await on.json()) as { error: string }).error).toBe('reauth_required');
    const off = await api(`/macos/${tala.id}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    // not on macOS here: the per-agent list is empty
    expect(((await off.json()) as { macosAgents: unknown[] }).macosAgents).toEqual([]);
  });
});

describe('driver choice', () => {
  it('macOS stays off for every agent until the owner turns it on for that agent with re-auth', async () => {
    const mac = await bootTestServer({
      modules: [
        createComputerModule({
          platform: 'darwin',
          // a stand-in for the macOS driver: nothing here may touch the real screen
          create: () => new PracticeDriver() as ManagedDriver,
        }),
      ],
    });
    try {
      // the owner made with a password: that session starts freshly re-authenticated (2.4)
      const setup = await fetch(`${mac.url}/api/v1/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: mac.auth.issueSetupToken(),
          displayName: 'Owner',
          password: 'a-long-owner-password',
        }),
      });
      const fresh = ((await setup.json()) as { token: string }).token;
      // another session of the same owner that never re-authenticated
      const stale = seedUser(mac.db).token;
      const api = (path: string, init: RequestInit = {}, token = fresh) =>
        fetch(`${mac.url}/api/m/computer${path}`, {
          ...init,
          headers: {
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${token}`,
          },
        });
      const tala = seedAgent(mac.db, { trust: 'trusted', slug: 'tala' });
      const ligaya = seedAgent(mac.db, { trust: 'trusted', slug: 'ligaya' });
      const asOwnerTurn = (agentId: string) => {
        const { token, runId } = seedRunToken(mac.db, agentId);
        mac.db
          .prepare(
            'UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)',
          )
          .run(
            JSON.stringify({ sender: { id: 'x', name: 'Owner', kind: 'owner', trust: 'trusted' } }),
            runId,
          );
        return token;
      };
      const status = async () =>
        (await (await api('/status')).json()) as {
          driver: string | null;
          reason: string | null;
          macosAgents: { id: string; name: string; enabled: boolean }[];
        };
      expect(await status()).toMatchObject({ driver: null, reason: 'macos_opt_in' });
      expect((await status()).macosAgents.map((a) => [a.name, a.enabled]).sort()).toEqual([
        ['ligaya', false],
        ['tala', false],
      ]);
      // the old server-wide switch of earlier builds no longer turns anything on
      mac.db
        .prepare("INSERT INTO computer_setting (key, value, updated_at) VALUES ('macos_opt_in', '1', 0)")
        .run();
      expect(await status()).toMatchObject({ driver: null, reason: 'macos_opt_in' });
      const talaTok = asOwnerTurn(tala);
      expect(await rpc(mac.url, talaTok, 'computer_display', {})).toMatchObject({ available: false });

      // without a fresh re-auth the switch stays off
      const noReauth = await api(
        `/macos/${tala}`,
        { method: 'PUT', body: JSON.stringify({ enabled: true }) },
        stale,
      );
      expect(noReauth.status).toBe(401);
      expect(await status()).toMatchObject({ driver: null, reason: 'macos_opt_in' });
      // with one, only that agent is turned on
      const onRes = await api(`/macos/${tala}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
      expect(onRes.status).toBe(200);
      expect(await status()).toMatchObject({ driver: 'macos', reason: null });
      expect((await status()).macosAgents.find((a) => a.id === tala)?.enabled).toBe(true);
      expect((await status()).macosAgents.find((a) => a.id === ligaya)?.enabled).toBe(false);
      expect(await rpc(mac.url, talaTok, 'computer_display', {})).toMatchObject({ available: true });
      // the other agent is still refused, at the tool and before any action
      const ligTok = asOwnerTurn(ligaya);
      expect(await rpc(mac.url, ligTok, 'computer_display', {})).toMatchObject({ available: false });
      // refused before any approval card (the owner gets the setup card instead of a pointless question)
      expect((await rpc(mac.url, ligTok, 'computer_click', { x: 1, y: 1 })).error).toMatch(/off for you/);
      expect(
        mac.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ?').get(ligaya) as { n: number },
      ).toEqual({ n: 0 });
      // turning it off for tala needs no re-auth and takes effect at once
      const off = await api(`/macos/${tala}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
      expect(off.status).toBe(200);
      expect(await rpc(mac.url, talaTok, 'computer_display', {})).toMatchObject({ available: false });
      expect((await api('/macos/nobody', { method: 'PUT', body: '{"enabled":false}' })).status).toBe(404);
    } finally {
      await mac.cleanup();
    }
  });

  it('Windows: "not available on Windows yet", plainly, with no driver and nothing to set up', async () => {
    const win = await bootTestServer({ modules: [createComputerModule({ platform: 'win32' })] });
    try {
      const o = seedUser(win.db).token;
      const st = (await (
        await fetch(`${win.url}/api/m/computer/status`, { headers: { authorization: `Bearer ${o}` } })
      ).json()) as { driver: string | null; reason: string };
      expect(st).toMatchObject({ driver: null, reason: 'windows_soon' });
      const aid = seedAgent(win.db, { trust: 'trusted' });
      const { token } = seedRunToken(win.db, aid);
      const r = await rpc(win.url, token, 'computer_display', {});
      expect(r).toMatchObject({ available: false });
      expect(r.reason).toMatch(/not available on Windows yet/);
    } finally {
      await win.cleanup();
    }
  });

  it('Linux without the helpers names what is missing', async () => {
    const mac = await bootTestServer({ modules: [createComputerModule({ platform: 'darwin' })] });
    const lin = await bootTestServer({
      modules: [createComputerModule({ platform: 'linux', path: '/nonexistent' })],
    });
    try {
      const o1 = seedUser(mac.db).token;
      const o2 = seedUser(lin.db).token;
      const st = async (u: string, t: string) =>
        (await (
          await fetch(`${u}/api/m/computer/status`, { headers: { authorization: `Bearer ${t}` } })
        ).json()) as {
          driver: string | null;
          reason: string;
          missing: string[];
        };
      expect(await st(mac.url, o1)).toMatchObject({ driver: null, reason: 'macos_opt_in' });
      expect(await st(lin.url, o2)).toMatchObject({
        driver: null,
        reason: 'missing_bins',
        missing: ['Xvfb', 'xdotool', 'import'],
      });
      // the agent is told plainly, after the owner's approval
      const aid = seedAgent(lin.db, { trust: 'trusted' });
      const { token } = seedRunToken(lin.db, aid);
      const r = await rpc(lin.url, token, 'computer_display', {});
      expect(r).toMatchObject({ available: false, running: false });
      expect(r.reason).toMatch(/install Xvfb, xdotool, import/);
    } finally {
      await mac.cleanup();
      await lin.cleanup();
    }
  });
});

describe('never always-allowed', () => {
  it('every computer action tool is tier 3 and opts out of a per-tool "always allow"', () => {
    const tools: ToolDef[] = [];
    const host = {
      tools: { add: (t: ToolDef) => tools.push(t), addGuard: () => () => {} },
      http: { route: () => {} },
      blocks: { register: () => {} },
      killSwitch: { onStop: () => () => {}, watch: () => () => {}, isStopped: () => false },
      dataDir: '/nonexistent',
    } as unknown as ModuleHost;
    createComputerModule({ driver: 'practice' }).register(host);
    const acts = tools.filter((t) => t.name !== 'computer_display');
    expect(acts.map((t) => t.name).sort()).toEqual([
      'computer_click',
      'computer_key',
      'computer_move',
      'computer_screenshot',
      'computer_type',
    ]);
    for (const t of acts) expect([t.name, t.tier, t.noAlwaysAllow]).toEqual([t.name, 3, true]);
    expect(tools.find((t) => t.name === 'computer_display')!.tier).toBe(0);
  });
});
