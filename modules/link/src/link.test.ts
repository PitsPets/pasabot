/**
 * W28 done-criteria: real servers (port 0, temp homes) in one Vitest process, linked over the in-memory transport:
 * link with a code and both owners' re-auth, pinned keys only, grants enforced (view cannot chat), a proxied chat
 * that runs under the remote server's own auth and trust, an agent messaging an agent on the other machine, an
 * introduction offered (never applied), unlink refusing the next connection, replayed/expired codes refused and a
 * version-skew handshake refused cleanly.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import {
  createMemoryNetwork,
  createTailcatTransport,
  fingerprint,
  generateLinkKeys,
  type LinkTransport,
  type MemoryNetwork,
} from '@pasabot/link-transport';
import { bootTestServer, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLinkModule, type LinkModuleOptions } from './server.js';
import {
  decodeCode,
  encodeCode,
  FrameConn,
  type Hello,
  newNonce,
  parseHello,
  sha256,
  signTranscript,
  transcript,
} from './wire.js';

type Behave = (input: TurnInput) => Promise<string> | string;
class ScriptedAgents implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'Scripted fake agents (tests)';
  constructor(private readonly behave: Behave) {}
  async detect() {
    return { installed: true, signedIn: true as const };
  }
  capabilities() {
    return {
      resume: false,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    };
  }
  async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    let text: string;
    try {
      text = await this.behave(input);
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: String(e) };
      yield { type: 'done', stop: 'error' };
      return;
    }
    yield { type: 'text.final', text };
    yield { type: 'done', stop: 'end' };
  }
}
const callTool = async (input: TurnInput, name: string, args: unknown) => {
  const r = await fetch(input.mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  if (j.result.isError) throw new Error(j.result.content[0]!.text);
  return JSON.parse(j.result.content[0]!.text);
};

/** every turn any server ran: which machine, which agent, who asked, at what trust */
const seen: { machine: string; slug: string; text: string; from: TurnInput['user']['from'] }[] = [];
const behaviours: Record<string, Behave> = {};

interface Machine {
  name: string;
  s: TestServer;
  owner: string;
  api(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any }>;
  reauth(): Promise<void>;
  agent(slug: string, trust: string, behave: Behave): Promise<{ id: string; chatId: string }>;
}

async function machine(
  net: MemoryNetwork,
  name: string,
  opts: {
    protocolVersion?: number;
    minProtocolVersion?: number;
    codeTtlMs?: number;
    transport?: LinkModuleOptions['transport'];
  } = {},
): Promise<Machine> {
  const s = await bootTestServer({
    modules: [
      createLinkModule({ ...opts, name, transport: opts.transport ?? ((keys) => net.transport(keys)) }),
    ],
    providers: [
      new ScriptedAgents((input) => {
        seen.push({ machine: name, slug: input.agent.slug, text: input.user.text, from: input.user.from });
        const b = behaviours[`${name}/${input.agent.slug}`];
        return b ? b(input) : 'ok';
      }),
    ] as ProviderAdapter[],
  });
  const setup = await fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: s.auth.issueSetupToken(),
      displayName: `Owner of ${name}`,
      password: `password-for-${name}`,
    }),
  });
  const ownerToken = ((await setup.json()) as { token: string }).token;
  const m: Machine = {
    name,
    s,
    owner: ownerToken,
    async api(path, init = {}) {
      const r = await fetch(`${s.url}${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${m.owner}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    },
    async reauth() {
      const r = await m.api('/api/v1/auth/reauth', { body: { password: `password-for-${name}` } });
      expect(r.status).toBe(200);
    },
    async agent(slug, trust, behave) {
      behaviours[`${name}/${slug}`] = behave;
      const r = await m.api('/api/v1/agents', {
        body: { name: slug, slug, providerId: 'fake', trustLevel: trust },
      });
      expect(r.status).toBe(201);
      return { id: r.json.agent.id, chatId: r.json.chatId };
    },
  };
  return m;
}

/** a session of the owner that has not re-authenticated (an old tab) */
const staleSession = (m: Machine) => {
  const token = randomBytes(32).toString('base64url');
  const owner = m.s.db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string };
  m.s.db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), owner.id, Date.now(), Date.now() + 3600_000);
  return token;
};

describe('machine linking (W28)', () => {
  const net = createMemoryNetwork();
  let a: Machine; // alpha: has the agents
  let b: Machine; // beta: links to alpha
  let peerOfBOnA = '';
  let peerOfAOnB = '';

  beforeAll(async () => {
    a = await machine(net, 'alpha');
    b = await machine(net, 'beta');
  });
  afterAll(async () => {
    await a.s.cleanup();
    await b.s.cleanup();
  });

  const link = async (from: Machine, to: Machine, grantForJoiner: string, grantForCodeOwner: string) => {
    const code = (await from.api('/api/m/link/codes', { body: {} })).json.code as string;
    await to.reauth();
    const join = await to.api('/api/m/link/join', { body: { code, grant: grantForCodeOwner } });
    expect(join.status).toBe(201);
    const req = (await from.api('/api/m/link/peers')).json.peers.find((p: any) => p.state === 'requested');
    await from.reauth();
    const conf = await from.api(`/api/m/link/peers/${req.id}/confirm`, { body: { grant: grantForJoiner } });
    expect(conf.status).toBe(200);
    return { onFrom: req.id as string, onTo: join.json.peer.id as string };
  };

  it('links with a one-time code; both owners must re-auth; each side pins the other key', async () => {
    const status = (await a.api('/api/m/link/status')).json;
    expect(status).toMatchObject({ name: 'alpha', transport: 'memory', available: { ok: true } });
    const code = (await a.api('/api/m/link/codes', { body: {} })).json;
    expect(code.code.startsWith('bkl1.')).toBe(true);

    // B without a fresh re-auth: refused, and the code is not spent
    b.owner = staleSession(b);
    const stale = await b.api('/api/m/link/join', { body: { code: code.code, grant: 'chat' } });
    expect(stale).toMatchObject({ status: 401, json: { error: 'reauth_required' } });
    await b.reauth();
    const join = await b.api('/api/m/link/join', { body: { code: code.code, grant: 'chat' } });
    expect(join.status).toBe(201);
    expect(join.json.peer).toMatchObject({ name: 'alpha', state: 'awaiting', grant: 'chat' });
    peerOfAOnB = join.json.peer.id;

    // A sees a request; nothing is active until A's owner confirms with a re-auth and picks B's grant
    const reqs = (await a.api('/api/m/link/peers')).json.peers;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ name: 'beta', state: 'requested' });
    peerOfBOnA = reqs[0].id;
    expect((await b.api(`/api/m/link/peers/${peerOfAOnB}/agents`)).status).toBe(409); // not confirmed yet
    a.owner = staleSession(a);
    expect(
      (await a.api(`/api/m/link/peers/${peerOfBOnA}/confirm`, { body: { grant: 'view' } })).json.error,
    ).toBe('reauth_required');
    await a.reauth();
    const conf = await a.api(`/api/m/link/peers/${peerOfBOnA}/confirm`, { body: { grant: 'view' } });
    expect(conf.json).toMatchObject({ peer: { state: 'active', grant: 'view' }, told: true });
    expect((await b.api('/api/m/link/peers')).json.peers[0]).toMatchObject({ state: 'active' });

    // pinned keys: each row holds exactly the other server's key; the address is only a vault reference
    const keyA = a.s.db.prepare('SELECT public_key, address_ref FROM link_peer').get() as any;
    const keyB = b.s.db.prepare('SELECT public_key, address_ref FROM link_peer').get() as any;
    expect(keyA.public_key).not.toBe(keyB.public_key);
    expect(JSON.parse(keyA.address_ref)).toMatchObject({ scope: 'link' });
    expect(JSON.stringify((await a.api('/api/m/link/peers')).json)).not.toContain('memory:');
  });

  it('only pinned keys may connect: an unknown server with the same address shape is refused', async () => {
    const stranger = net.transport(generateLinkKeys());
    const code = decodeCode((await a.api('/api/m/link/codes', { body: {} })).json.code)!;
    const { stream } = await stranger.dial(code.address);
    const frames: any[] = [];
    stream.on('data', (c: Buffer) => {
      for (const l of c.toString().split('\n').filter(Boolean)) frames.push(JSON.parse(l));
    });
    const id = await stranger.identity();
    stream.write(
      `${JSON.stringify({ t: 'hello', v: 1, min: 1, features: [], pub: id.publicKey, nonce: randomBytes(16).toString('base64url'), name: 'mallory', purpose: 'call' })}\n`,
    );
    await new Promise((r) => setTimeout(r, 100));
    const hello = frames.find((f) => f.t === 'hello');
    // it signs garbage: the listener refuses before answering anything
    stream.write(`${JSON.stringify({ t: 'auth', sig: 'x'.repeat(86) })}\n`);
    await new Promise((r) => setTimeout(r, 100));
    expect(hello).toBeTruthy();
    expect(frames.at(-1)).toMatchObject({ t: 'refuse', code: 'peer_key' });
  });

  it('a view grant cannot chat; it can list the agents', async () => {
    const tala = await a.agent('tala', 'trusted', (i) => `tala heard: ${i.user.text.split('\n').at(-1)}`);
    const agents = await b.api(`/api/m/link/peers/${peerOfAOnB}/agents`);
    expect(agents.json.agents.map((x: any) => x.slug)).toContain('tala');
    const r = await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${tala.id}?wait=1`, {
      body: { text: 'hello' },
    });
    expect(r.status).toBe(202);
    expect(r.json.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(r.json.messages.at(-1).body).toContain('only allows view');
    expect(seen.filter((x) => x.machine === 'alpha')).toEqual([]);
  });

  it('a chat grant opens a proxied chat whose turn runs on the remote server under its own auth and trust', async () => {
    await a.reauth();
    // A's owner narrows/widens what beta may do on alpha: here a fresh link is not needed, the grant is per row
    a.s.db.prepare("UPDATE link_peer SET grant_level = 'chat' WHERE id = ?").run(peerOfBOnA);
    const tala = (await a.api('/api/v1/agents')).json.agents.find((x: any) => x.slug === 'tala');
    const r = await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${tala.id}?wait=1`, {
      body: { text: 'kumusta' },
    });
    expect(r.json.messages.map((m: any) => [m.role, m.body])).toContainEqual([
      'agent',
      'tala heard: > kumusta',
    ]);
    const turn = seen.find((x) => x.machine === 'alpha' && x.slug === 'tala')!;
    // never the owner: sender kind link, trust capped at standard although tala is trusted; no turn on beta
    expect(turn.from).toMatchObject({ kind: 'link', id: peerOfBOnA, name: 'beta', trust: 'standard' });
    expect(turn.text).toContain('linked PasaBot machine');
    expect(seen.some((x) => x.machine === 'beta')).toBe(false);
    // the run and its chat live on alpha (its own audit and approvals), in a module chat, not tala's own chat
    const run = a.s.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'done'").get() as { n: number };
    expect(run.n).toBeGreaterThan(0);
    expect(b.s.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('a linked machine, at chat and at view grant, never gets what a turn asks the owner: no tool, arguments or nonce', async () => {
    a.s.tools.add({
      name: 'lk_diary',
      title: 'Read the diary',
      description: 'reads a file',
      input: z.object({ path: z.string() }),
      tier: 2,
      handler: async () => 'the diary says hi',
    });
    const vera = await a.agent('vera', 'trusted', async (input) => {
      if (!input.user.text.includes('diary')) return 'idle';
      try {
        await callTool(input, 'lk_diary', { path: '/owner/secret-diary.txt' });
        return 'read it';
      } catch {
        return 'could not';
      }
    });
    const ownerId = (a.s.db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string }).id;
    const sent = await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${vera.id}`, {
      body: { text: 'read the diary' },
    });
    expect(sent.status).toBe(202);
    // the turn runs on alpha and asks alpha's owner (a link sender never auto-approves tier 2)
    const pending = (await until(() =>
      a.s.db.prepare("SELECT id, nonce FROM approvals WHERE state = 'pending'").get(),
    )) as { id: string; nonce: string };
    const leaks = (x: unknown) => {
      const t = JSON.stringify(x);
      return (
        t.includes('secret-diary') ||
        t.includes('lk_diary') ||
        t.includes(pending.nonce) ||
        t.includes(pending.id)
      );
    };
    expect(leaks((await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${vera.id}`)).json)).toBe(false);
    // at view grant: the agent list, and a refused chat, carry none of it either
    a.s.db.prepare("UPDATE link_peer SET grant_level = 'view' WHERE id = ?").run(peerOfBOnA);
    expect(leaks((await b.api(`/api/m/link/peers/${peerOfAOnB}/agents`)).json)).toBe(false);
    const tala = (await a.api('/api/v1/agents')).json.agents.find((x: any) => x.slug === 'tala');
    const refused = await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${tala.id}?wait=1`, {
      body: { text: 'diary?' },
    });
    expect(refused.json.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(leaks(refused.json)).toBe(false);
    a.s.db.prepare("UPDATE link_peer SET grant_level = 'chat' WHERE id = ?").run(peerOfBOnA);
    // alpha's owner refuses in the app: the linked machine gets the helper's own words only
    a.s.approvals.decide(pending.id, 'denied', ownerId);
    const done = (await until(async () => {
      const h = (await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${vera.id}`)).json;
      return h.messages.some((m: any) => m.role !== 'me') ? h : undefined;
    })) as any;
    expect(done.messages.at(-1)).toMatchObject({ role: 'agent', body: 'could not' });
    expect(leaks(done)).toBe(false);
  });

  it('an agent messages an agent on the other machine via the collab tools, within the grant', async () => {
    await a.agent('dagat', 'standard', (i) => (i.user.text.includes('weather') ? 'maaraw sa alpha' : 'hm'));
    const bea = await b.agent('bea', 'trusted', async (input) => {
      if (!input.user.text.includes('ask alpha')) return 'idle';
      const m = await callTool(input, 'link_machines', {});
      const r = await callTool(input, 'link_message', { to: 'dagat@alpha', text: 'how is the weather?' });
      return `machines ${m.machines.map((x: any) => x.name).join(',')}; dagat said: ${r.reply} (trust ${r.trust})`;
    });
    await b.api(`/api/v1/chats/${bea.chatId}/messages`, { body: { text: 'please ask alpha' } });
    const reply = await until(() => {
      const row = b.s.db
        .prepare(
          "SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'agent' ORDER BY created_at DESC",
        )
        .get(bea.chatId) as { body: string } | undefined;
      return row?.body.startsWith('machines') ? row.body : undefined;
    });
    expect(reply).toBe('machines alpha; dagat said: maaraw sa alpha (trust standard)');
    const turn = seen.find((x) => x.machine === 'alpha' && x.slug === 'dagat')!;
    expect(turn.from).toMatchObject({ kind: 'link', trust: 'standard' });
    expect(turn.text).toContain('agent bea on beta');
  });

  it('a third machine linking to one member gets an introduction offer to the others, never applied', async () => {
    const c = await machine(net, 'gamma');
    try {
      await link(a, c, 'view', 'view');
      const intros = await until(async () => {
        const l = (await b.api('/api/m/link/intros')).json.intros;
        return l.length ? l : undefined;
      });
      expect(intros[0]).toMatchObject({ name: 'gamma', via: 'alpha' });
      const cIntros = await until(async () => {
        const l = (await c.api('/api/m/link/intros')).json.intros;
        return l.length ? l : undefined;
      });
      expect(cIntros[0]).toMatchObject({ name: 'beta', via: 'alpha' });
      // nothing linked by itself, and accepting is only a note
      expect(
        (await b.api(`/api/m/link/intros/${intros[0].id}`, { body: { decision: 'accepted' } })).status,
      ).toBe(200);
      expect((await b.api('/api/m/link/peers')).json.peers.map((p: any) => p.name)).toEqual(['alpha']);
      expect((await c.api('/api/m/link/peers')).json.peers.map((p: any) => p.name)).toEqual(['alpha']);
    } finally {
      await c.s.cleanup();
    }
  });

  it('replayed and expired codes are refused', async () => {
    const d = await machine(net, 'delta', { codeTtlMs: 50 });
    const e = await machine(net, 'echo');
    try {
      const code = (await a.api('/api/m/link/codes', { body: {} })).json.code;
      await d.reauth();
      expect((await d.api('/api/m/link/join', { body: { code, grant: 'view' } })).status).toBe(201);
      await e.reauth();
      const replay = await e.api('/api/m/link/join', { body: { code, grant: 'view' } });
      expect(replay).toMatchObject({ status: 409, json: { error: 'code_used' } });
      const short = (await d.api('/api/m/link/codes', { body: {} })).json.code;
      await new Promise((r) => setTimeout(r, 80));
      const expired = await e.api('/api/m/link/join', { body: { code: short, grant: 'view' } });
      expect(expired).toMatchObject({ status: 409, json: { error: 'code_expired' } });
      // a forged code carrying a real address but another secret links nothing
      const real = decodeCode((await d.api('/api/m/link/codes', { body: {} })).json.code)!;
      const forged = encodeCode({ ...real, secret: randomBytes(16).toString('base64url') });
      expect((await e.api('/api/m/link/join', { body: { code: forged, grant: 'view' } })).json.error).toBe(
        'code_invalid',
      );
    } finally {
      await d.s.cleanup();
      await e.s.cleanup();
    }
  });

  it('a version-skew handshake is refused cleanly with an update message', async () => {
    const future = await machine(net, 'future', { protocolVersion: 9, minProtocolVersion: 9 });
    try {
      const code = (await future.api('/api/m/link/codes', { body: {} })).json.code;
      await b.reauth();
      const r = await b.api('/api/m/link/join', { body: { code, grant: 'view' } });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('version_unsupported');
      expect(r.json.message).toContain('Update this machine');
      expect((await future.api('/api/m/link/peers')).json.peers).toEqual([]);
      // and the other way round: the newer machine is told to update the older one
      const old = (await b.api('/api/m/link/codes', { body: {} })).json.code;
      await future.reauth();
      const r2 = await future.api('/api/m/link/join', { body: { code: old, grant: 'view' } });
      expect(r2.json).toMatchObject({ error: 'version_unsupported' });
      expect(r2.json.message).toContain('Update that machine');
    } finally {
      await future.s.cleanup();
    }
  });

  it('a joiner sends nothing to a listener whose key is not the code’s, and the code never leaves it', async () => {
    // someone else answers at the code's address (an on-path LAN host, a reused DHCP address)
    const mitm = net.transport(generateLinkKeys());
    const got: Buffer[] = [];
    await mitm.listen((s) => {
      s.on('data', (c: Buffer) => got.push(c));
      s.on('error', () => {});
    });
    const real = decodeCode((await a.api('/api/m/link/codes', { body: {} })).json.code)!;
    const hijacked = encodeCode({ ...real, address: (await mitm.identity()).address });
    await b.reauth();
    const r = await b.api('/api/m/link/join', { body: { code: hijacked, grant: 'view' } });
    expect(r).toMatchObject({ status: 409, json: { error: 'peer_key' } });
    await new Promise((res) => setTimeout(res, 50));
    expect(Buffer.concat(got).length).toBe(0);
    // the real code is still unspent on alpha
    expect(a.s.db.prepare('SELECT used_at FROM link_code WHERE hash = ?').get(sha256(real.secret))).toEqual({
      used_at: null,
    });
  });

  it('even a listener with the code’s own key never sees the code or its hash on the wire', async () => {
    const keys = generateLinkKeys();
    const fake = net.transport(keys);
    const got: Buffer[] = [];
    await fake.listen((s) => {
      s.on('data', (c: Buffer) => {
        got.push(c);
        s.write(`${JSON.stringify({ t: 'refuse', code: 'nope', message: 'no' })}\n`);
      });
      s.on('error', () => {});
    });
    const secret = randomBytes(16).toString('base64url');
    const code = encodeCode({
      address: (await fake.identity()).address,
      fingerprint: fingerprint(keys.publicKey),
      secret,
      transport: 'memory',
    });
    await b.reauth();
    expect((await b.api('/api/m/link/join', { body: { code, grant: 'view' } })).json.error).toBe('nope');
    const wire = Buffer.concat(got).toString('utf8');
    expect(JSON.parse(wire.split('\n')[0]!)).toMatchObject({ t: 'hello', purpose: 'link' });
    expect(wire).not.toContain('codeHash');
    expect(wire).not.toContain(sha256(secret));
    expect(wire).not.toContain(secret);
  });

  it('an address that looks like a CLI option is refused, in a pasted code and in a joiner’s link request', async () => {
    const real = decodeCode((await a.api('/api/m/link/codes', { body: {} })).json.code)!;
    expect(decodeCode(encodeCode({ ...real, address: '-state-dir=/tmp/x' }))).toBeNull();
    await b.reauth();
    expect(
      (
        await b.api('/api/m/link/join', {
          body: { code: encodeCode({ ...real, address: '--x' }), grant: 'view' },
        })
      ).json.error,
    ).toBe('code_invalid');
    // a joiner holding a valid code asks alpha to store a dial address that is a flag
    const keys = generateLinkKeys();
    const { stream } = await net.transport(keys).dial(real.address);
    const conn = new FrameConn(stream);
    const hello: Hello = {
      t: 'hello',
      v: 1,
      min: 1,
      features: [],
      pub: keys.publicKey,
      nonce: newNonce(),
      name: 'mallory',
      purpose: 'link',
    };
    conn.send(hello as unknown as Record<string, unknown>);
    const theirs = parseHello(await conn.next(2000));
    const t = transcript(1, hello, theirs, sha256(real.secret));
    conn.send({ t: 'auth', sig: signTranscript(keys, 'dialer', t) });
    expect(await conn.next(2000)).toMatchObject({ t: 'auth' });
    conn.send({ t: 'req', op: 'link', args: { address: '-state-dir=/tmp/x' } });
    expect(await conn.next(2000)).toMatchObject({ t: 'refuse', code: 'protocol' });
    conn.close();
    expect((await a.api('/api/m/link/peers')).json.peers.map((p: any) => p.name)).not.toContain('mallory');
  });

  it('a turn a linked machine asked for cannot message or list other linked machines (no reaching past the grant)', async () => {
    // beta's chat grant on alpha reaches relay; alpha in turn holds a chat grant on beta, which relay must not use
    const relay = await a.agent('relay', 'trusted', async (input) => {
      const out: string[] = [];
      for (const [tool, args] of [
        ['link_message', { to: 'bea@beta', text: 'pass this on' }],
        ['link_machines', { machine: 'beta' }],
        ['link_machines', {}],
      ] as const)
        out.push(
          await callTool(input, tool, args).then(
            () => 'ran',
            (e: Error) => e.message,
          ),
        );
      return out.join(' | ');
    });
    const before = seen.filter((x) => x.machine === 'beta').length;
    const r = await b.api(`/api/m/link/peers/${peerOfAOnB}/chats/${relay.id}?wait=1`, {
      body: { text: 'tell bea on beta to do it' },
    });
    const last = r.json.messages.at(-1);
    expect(last.role).toBe('agent');
    expect(last.body.split(' | ')).toEqual([
      expect.stringContaining('cannot reach other linked machines'),
      expect.stringContaining('cannot reach other linked machines'),
      expect.stringContaining('cannot reach other linked machines'),
    ]);
    expect(seen.filter((x) => x.machine === 'beta').length).toBe(before);
  });

  it('unlink revokes at once: the next connection is refused on both sides', async () => {
    const del = await a.api(`/api/m/link/peers/${peerOfBOnA}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    // alpha refuses beta's next connection at once (its pinned key is revoked)
    const r = await b.api(`/api/m/link/peers/${peerOfAOnB}/agents`);
    expect(r.json?.error === 'not_linked' || r.status === 404).toBe(true);
    // beta was told and revoked its side too
    await until(async () => ((await b.api('/api/m/link/peers')).json.peers.length === 0 ? true : undefined));
    expect(a.s.db.prepare('SELECT state FROM link_peer WHERE id = ?').get(peerOfBOnA)).toEqual({
      state: 'revoked',
    });
  });
});

/**
 * The same flow over the tailcat transport, driven through a stub of the real v0.7.0 CLI (no network): the link code
 * names a short-lived linking-window address, both sides pin the other's tunnel key from the link handshake, `--allow`
 * then lists only linked machines, and unlink drops the key at once.
 */
describe('machine linking over tailcat (stub CLI)', () => {
  const STUB = fileURLToPath(
    new URL('../../../packages/link-transport/src/__fixtures__/tailcat-stub.mjs', import.meta.url),
  );
  chmodSync(STUB, 0o755);
  const SOCKDIR = mkdtempSync(join(tmpdir(), 'bk-tcs-'));
  const transports: LinkTransport[] = [];
  const viaTailcat: LinkModuleOptions['transport'] = (keys, ctx) => {
    const t = createTailcatTransport({
      keys,
      stateDir: join(ctx.dataDir, 'tailcat'),
      bin: STUB,
      timeoutMs: 5000,
      dialerIdleMs: 200,
    });
    transports.push(t);
    return t;
  };
  const net = createMemoryNetwork();
  let a: Machine;
  let b: Machine;
  beforeAll(async () => {
    process.env.TAILCAT_STUB_SOCKDIR = SOCKDIR;
    process.env.TAILCAT_STUB_REFUSE_MS = '400';
    a = await machine(net, 'alpha-tc', { transport: viaTailcat });
    b = await machine(net, 'beta-tc', { transport: viaTailcat });
  });
  afterAll(async () => {
    await Promise.all(transports.map((t) => t.close?.()));
    await a.s.cleanup();
    await b.s.cleanup();
    delete process.env.TAILCAT_STUB_SOCKDIR;
    delete process.env.TAILCAT_STUB_REFUSE_MS;
    const left = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(STUB) && (l.includes(a.s.home ?? '\0') || l.includes('--key=new')));
    expect(readdirSync(SOCKDIR)).toEqual([]);
    rmSync(SOCKDIR, { recursive: true, force: true });
    expect(left).toEqual([]);
  });

  it('links through the linking window, pins both tunnel keys, admits only linked machines, unlink drops the key', async () => {
    const status = (await a.api('/api/m/link/status')).json;
    expect(status).toMatchObject({
      transport: 'tailcat',
      available: { ok: true },
      transportStatus: { serving: false, linked: 0, linkWindow: false, version: 'v0.7.0' }, // nothing linked yet
    });
    const code = (await a.api('/api/m/link/codes', { body: {} })).json.code as string;
    expect((await a.api('/api/m/link/status')).json.transportStatus.linkWindow).toBe(true);
    const windowAddress = decodeCode(code)!.address;
    await b.reauth();
    const joined = await b.api('/api/m/link/join', { body: { code, grant: 'chat' } });
    expect(joined.status).toBe(201);
    // the window closes once no code is left; the code's address is dead from then on
    await until(async () =>
      (await a.api('/api/m/link/status')).json.transportStatus.linkWindow === false ? true : undefined,
    );
    const onA = a.s.db.prepare('SELECT id, transport_key FROM link_peer').get() as any;
    const onB = b.s.db.prepare('SELECT id, transport_key, address_ref FROM link_peer').get() as any;
    expect(onA.transport_key).toMatch(/^nodekey:[0-9a-f]{64}$/);
    expect(onB.transport_key).toMatch(/^nodekey:[0-9a-f]{64}$/);
    expect(onA.transport_key).not.toBe(onB.transport_key);
    // beta stored alpha's long-lived address, not the window's
    const stored = await b.s.vault.get(JSON.parse(onB.address_ref), { actor: 'test', purpose: 'test' });
    expect(stored).not.toBe(windowAddress);
    expect(stored.startsWith('tc')).toBe(true);
    // alpha confirms: that dials beta, which admits alpha's tunnel key since the join
    await a.reauth();
    const conf = await a.api(`/api/m/link/peers/${onA.id}/confirm`, { body: { grant: 'chat' } });
    expect(conf.json).toMatchObject({ peer: { state: 'active' }, told: true });
    for (const m of [a, b])
      expect((await m.api('/api/m/link/status')).json.transportStatus).toMatchObject({
        serving: true,
        linked: 1,
      });
    const check = await b.api(`/api/m/link/peers/${onB.id}/check`, { body: {} });
    expect(check.json).toMatchObject({ online: true, linked: true });
    expect(check.json.path).toBeUndefined(); // review fix: no `tailcat ping`, whose argv would carry the address
    expect(JSON.stringify(check.json)).not.toContain(stored);
    // review fix: a code spent on a link that is then refused (already linked) closes the window as well
    const code2 = (await a.api('/api/m/link/codes', { body: {} })).json.code as string;
    expect((await a.api('/api/m/link/status')).json.transportStatus.linkWindow).toBe(true);
    await b.reauth();
    const again = await b.api('/api/m/link/join', { body: { code: code2, grant: 'chat' } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    await until(async () =>
      (await a.api('/api/m/link/status')).json.transportStatus.linkWindow === false ? true : undefined,
    );
    // a third machine that never linked is refused by the tunnel (silently, like an unreachable one)
    const stranger = createTailcatTransport({
      keys: generateLinkKeys(),
      stateDir: mkdtempSync(join(tmpdir(), 'bk-tc-stranger-')),
      bin: STUB,
      timeoutMs: 3000,
      dialerIdleMs: 100,
    });
    transports.push(stranger);
    await expect(stranger.dial(stored)).rejects.toMatchObject({ code: 'unreachable' });
    // unlink: alpha drops beta's tunnel key at once; beta's next call is refused
    const del = await a.api(`/api/m/link/peers/${onA.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const r = await b.api(`/api/m/link/peers/${onB.id}/agents`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
