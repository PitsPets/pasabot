/**
 * W23 done-criterion: a push arrives on an approval and on an agent error, through a mock push service (127.0.0.1,
 * port 0) that checks the VAPID JWT signature and decrypts the RFC 8291 payload with the browser-side keys, the way
 * a real push service + browser would. Plus: finished replies go to the people who can read the chat, per-device
 * choices, dead subscriptions dropped, unknown push hosts refused, the private key only in the vault.
 */
import {
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  FakeProvider,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { createPushModule } from './server.js';

/** the core's session id for a bearer token (sha-256 hex, as `hashToken` in the server) */
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** The browser side of one subscription: its keys, and RFC 8291 decryption. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    decrypt(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, secret);
      const ikm = hmac(
        prkKey,
        Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]),
      );
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      expect(plain.at(-1)).toBe(2); // last-record delimiter
      return JSON.parse(plain.subarray(0, -1).toString('utf8'));
    },
  };
}

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
/** A mock push service: checks VAPID like a real one (signature, audience, expiry) and records each message. */
async function mockPushService(statusFor: (path: string) => number = () => 201) {
  const got: Received[] = [];
  const srv: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
      if (!m) return res.writeHead(401).end();
      const [h, p, sig] = m[1]!.split('.');
      const k = Buffer.from(m[2]!, 'base64url');
      const pub = createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: k.subarray(1, 33).toString('base64url'),
          y: k.subarray(33, 65).toString('base64url'),
        },
        format: 'jwk',
      });
      const ok = verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: pub, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig!, 'base64url'),
      );
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as { aud: string; exp: number };
      const addr = srv.address() as { port: number };
      if (!ok || claims.aud !== `http://127.0.0.1:${addr.port}` || claims.exp * 1000 < Date.now())
        return res.writeHead(403).end();
      if (req.headers['content-encoding'] !== 'aes128gcm') return res.writeHead(400).end();
      got.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(statusFor(req.url ?? '')).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { got, base, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(statusFor?: (path: string) => number) {
  const svc = await mockPushService(statusFor);
  cleanups.push(svc.close);
  const s: TestServer = await bootTestServer({
    providers: [new FakeProvider({ deltaMs: 1 })],
    modules: [createPushModule({ extraHosts: ['127.0.0.1'], allowInsecure: true, progressAfterMs: 0 })],
    approvalExpiresMs: 60_000,
  });
  cleanups.push(() => s.cleanup());
  const owner = seedUser(s.db, 'owner', 'Diwa');
  const api = async (token: string, path: string, body?: unknown, method?: string) => {
    const r = await fetch(`${s.url}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
  };
  const subscribe = async (token: string, name: string, prefs?: Record<string, boolean>) => {
    const keys = browserKeys();
    const r = await api(token, '/api/m/push/subscriptions', {
      endpoint: `${svc.base}/push/${name}`,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      label: name,
      ...(prefs ? { prefs } : {}),
    });
    expect(r.status).toBe(200);
    return { id: r.json.id as string, keys, name };
  };
  const pushesTo = (name: string) => svc.got.filter((g) => g.path === `/push/${name}`);
  return { s, svc, owner, api, subscribe, pushesTo };
}

async function until<T>(
  f: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  ms = 8000,
) {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('web push', () => {
  it('a push arrives when an approval is needed and when an agent run fails', async () => {
    const { s, owner, api, subscribe, pushesTo } = await setup();
    const cfg = await api(owner.token, '/api/m/push/config');
    expect(cfg.json).toMatchObject({ available: true });
    expect(Buffer.from(cfg.json.publicKey, 'base64url')).toHaveLength(65);
    const phone = await subscribe(owner.token, 'phone');

    const agent = await api(owner.token, '/api/v1/agents', {
      name: 'Tala',
      providerId: 'fake',
      trustLevel: 'standard',
    });
    expect(agent.status).toBe(201);
    const chatId = agent.json.chatId as string;

    // 1. approval: the Fake brain asks for a shell command (tier 2 at `standard`)
    await api(owner.token, `/api/v1/chats/${chatId}/messages`, {
      text: JSON.stringify({
        fakeScript: [
          { expectPermission: { tool: 'Bash', input: { command: 'ls' }, decision: 'allow' } },
          { event: { type: 'text.final', text: 'listed' } },
          { event: { type: 'done', stop: 'end' } },
        ],
      }),
    });
    const ap = await until(() => pushesTo('phone')[0]);
    const n1 = phone.keys.decrypt(ap.body) as Record<string, string>;
    expect(n1).toMatchObject({ title: 'Approval needed', category: 'approval', href: `/chats/${chatId}` });
    expect(ap.headers.urgency).toBe('high');
    const pending = await until(
      async () => (await api(owner.token, '/api/v1/approvals?state=pending')).json.approvals[0],
    );
    expect(
      (await api(owner.token, `/api/v1/approvals/${pending.id}/approve`, { nonce: pending.nonce })).status,
    ).toBe(200);
    // the reply that follows is a "finished" push for the same run, replacing nothing else
    const fin = await until(() =>
      pushesTo('phone')
        .map((g) => phone.keys.decrypt(g.body) as Record<string, string>)
        .find((n) => n.category === 'run.finished'),
    );
    expect(fin).toMatchObject({ title: 'Tala replied', body: 'listed', href: `/chats/${chatId}` });
    expect(fin.tag).toMatch(/^run:/);

    // 2. agent error: the run fails
    const before = pushesTo('phone').length;
    await api(owner.token, `/api/v1/chats/${chatId}/messages`, {
      text: JSON.stringify({
        fakeScript: [
          { event: { type: 'error', kind: 'crash', message: 'the CLI exploded' } },
          { event: { type: 'done', stop: 'error' } },
        ],
      }),
    });
    const err = await until(() =>
      pushesTo('phone')
        .slice(before)
        .map((g) => phone.keys.decrypt(g.body) as Record<string, string>)
        .find((n) => n.category === 'run.failed'),
    );
    expect(err.title).toBe('Tala: run failed');
    expect(err.body).toContain('exploded');
    expect(err.tag).toMatch(/^run:/);

    // the VAPID private key is only in the vault (ciphertext), never in the module's table
    const key = s.db.prepare('SELECT * FROM push_key').get() as Record<string, unknown>;
    expect(Object.keys(key)).not.toContain('private_key');
    expect(s.db.prepare("SELECT scope FROM secrets WHERE name = 'vapid-private-key'").get()).toMatchObject({
      scope: 'module:push',
    });
  });

  it('each device chooses what it gets; other people get only their chats; dead endpoints are dropped', async () => {
    const { s, owner, api, subscribe, pushesTo } = await setup((p) => (p.endsWith('/gone') ? 410 : 201));
    const quiet = await subscribe(owner.token, 'quiet', { approval: false, error: false, finished: false });
    const gone = await subscribe(owner.token, 'gone');
    const member = seedUser(s.db, 'member', 'Maya');
    const mphone = await subscribe(member.token, 'member');
    expect(quiet.id && mphone.id).toBeTruthy();

    // an owner-only notice (no userId) never reaches the member's device, and the quiet device opted out
    const agent = await api(owner.token, '/api/v1/agents', {
      name: 'Tala',
      providerId: 'fake',
      trustLevel: 'standard',
    });
    const chatId = agent.json.chatId as string;
    await api(owner.token, `/api/v1/chats/${chatId}/messages`, {
      text: JSON.stringify({
        fakeScript: [
          { event: { type: 'error', kind: 'crash', message: 'nope' } },
          { event: { type: 'done', stop: 'error' } },
        ],
      }),
    });
    await until(() => pushesTo('gone').length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(pushesTo('quiet')).toHaveLength(0);
    expect(pushesTo('member')).toHaveLength(0);
    // the 410 dropped that subscription
    expect(s.db.prepare('SELECT 1 FROM push_sub WHERE id = ?').get(gone.id)).toBeUndefined();

    // a person sees and changes only their own devices
    expect(
      (await api(member.token, `/api/m/push/subscriptions/${quiet.id}`, { prefs: { alert: false } }, 'PATCH'))
        .status,
    ).toBe(404);
    const mine = await api(member.token, '/api/m/push/subscriptions');
    expect(mine.json.subscriptions.map((x: { id: string }) => x.id)).toEqual([mphone.id]);
    expect(JSON.stringify(mine.json)).not.toContain('/push/'); // endpoints are never sent back

    // test push for one device
    const t = await api(member.token, `/api/m/push/subscriptions/${mphone.id}/test`, {});
    expect(t.json).toEqual({ ok: true, error: null });
    expect(mphone.keys.decrypt(pushesTo('member')[0]!.body)).toMatchObject({ category: 'test' });
  });

  it('a device stops getting pushes once its session ends: logout, device revoke, expiry (review fix)', async () => {
    const { s, owner, api, subscribe, pushesTo } = await setup();
    // four owner sessions, one device each; the stolen phone is a paired device
    const desk = await subscribe(owner.token, 'desk');
    const laptop = seedUser(s.db, 'owner');
    await subscribe(laptop.token, 'laptop');
    const tablet = seedUser(s.db, 'owner');
    await subscribe(tablet.token, 'tablet');
    const phone = seedUser(s.db, 'owner');
    s.db
      .prepare("INSERT INTO devices (id, user_id, name, platform) VALUES ('dev-phone', ?, 'Phone', 'ios')")
      .run(owner.id);
    s.db.prepare("UPDATE sessions SET device_id = 'dev-phone' WHERE id = ?").run(hashToken(phone.token));
    await subscribe(phone.token, 'phone');
    // a member on a shared tablet, then they log out
    const member = seedUser(s.db, 'member', 'Maya');
    await subscribe(member.token, 'shared');

    const agent = await api(owner.token, '/api/v1/agents', {
      name: 'Tala',
      providerId: 'fake',
      trustLevel: 'standard',
    });
    const chatId = agent.json.chatId as string;
    s.db
      .prepare(
        "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'member')",
      )
      .run(chatId, member.id);

    expect((await api(laptop.token, '/api/v1/auth/logout', {})).status).toBe(200);
    expect((await api(member.token, '/api/v1/auth/logout', {})).status).toBe(200);
    expect((await api(owner.token, '/api/v1/devices/dev-phone/revoke', {})).status).toBe(200);
    s.db.prepare('UPDATE sessions SET expires_at = 1 WHERE id = ?').run(hashToken(tablet.token));

    // an owner notice (failed run) and a finished reply in a chat the member could read
    const say = (fakeScript: unknown[]) =>
      api(owner.token, `/api/v1/chats/${chatId}/messages`, { text: JSON.stringify({ fakeScript }) });
    await say([
      { event: { type: 'error', kind: 'crash', message: 'boom' } },
      { event: { type: 'done', stop: 'error' } },
    ]);
    await until(() => pushesTo('desk').length >= 1);
    await say([
      { event: { type: 'text.final', text: 'the private reply' } },
      { event: { type: 'done', stop: 'end' } },
    ]);
    await until(() =>
      pushesTo('desk').some(
        (g) => (desk.keys.decrypt(g.body) as { category: string }).category === 'run.finished',
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    for (const gone of ['laptop', 'phone', 'tablet', 'shared']) expect(pushesTo(gone), gone).toHaveLength(0);
    // and their rows are gone: only the desk is left
    expect(s.db.prepare('SELECT label FROM push_sub').all()).toEqual([{ label: 'desk' }]);

    // signing in again and turning notifications on brings a device back, under the new session
    const again = seedUser(s.db, 'member', 'Maya');
    s.db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(member.id, hashToken(again.token));
    await subscribe(again.token, 'shared');
    expect((await api(again.token, '/api/m/push/subscriptions')).json.subscriptions).toHaveLength(1);
  });

  it('a long run sends a "still working" note to devices that chose it, then the reply under the same tag', async () => {
    const svc = await mockPushService();
    cleanups.push(svc.close);
    const s = await bootTestServer({
      providers: [new FakeProvider({ deltaMs: 1 })],
      modules: [
        createPushModule({
          extraHosts: ['127.0.0.1'],
          allowInsecure: true,
          progressAfterMs: 100,
          progressEveryMs: 60_000,
        }),
      ],
    });
    cleanups.push(() => s.cleanup());
    const owner = seedUser(s.db);
    const keys = browserKeys();
    const sub = await fetch(`${s.url}/api/m/push/subscriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: `${svc.base}/push/p`,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        prefs: { progress: true },
      }),
    });
    expect(sub.status).toBe(200);
    const agent = await fetch(`${s.url}/api/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tala', providerId: 'fake', trustLevel: 'standard' }),
    });
    const { chatId } = (await agent.json()) as { chatId: string };
    await fetch(`${s.url}/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: JSON.stringify({
          fakeScript: [
            { after: 600, event: { type: 'text.final', text: 'done at last' } },
            { event: { type: 'done', stop: 'end' } },
          ],
        }),
      }),
    });
    const notes = () => svc.got.map((g) => keys.decrypt(g.body) as Record<string, string>);
    const prog = await until(() => notes().find((n) => n.category === 'progress'));
    expect(prog.title).toMatch(/^Tala is still working/);
    const fin = await until(() => notes().find((n) => n.category === 'run.finished'));
    expect(fin.tag).toBe(prog.tag); // the reply replaces the progress note on the device
    expect(fin.body).toBe('done at last');
  });

  it('refuses endpoints that are not known push services, and plain http in production', async () => {
    const svc = await mockPushService();
    cleanups.push(svc.close);
    const s = await bootTestServer({ modules: [createPushModule()] });
    cleanups.push(() => s.cleanup());
    const owner = seedUser(s.db);
    const keys = browserKeys();
    for (const endpoint of [
      `${svc.base}/push/x`, // loopback, http
      'https://evil.example/push', // not a push service
      'https://fcm.googleapis.com.evil.example/x',
      'http://fcm.googleapis.com/fcm/send/x', // plain http
    ]) {
      const r = await fetch(`${s.url}/api/m/push/subscriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
      });
      expect(r.status, endpoint).toBe(400);
    }
    const ok = await fetch(`${s.url}/api/m/push/subscriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      }),
    });
    expect(ok.status).toBe(200);
    expect(svc.got).toHaveLength(0);
  });
});

/**
 * Live (PASABOT_LIVE=push): a real browser subscription through a real push service. Turn notifications on in a
 * browser, copy `JSON.stringify(subscription)` from its console into PASABOT_PUSH_SUBSCRIPTION, run this, and the
 * device shows the test notification. Never runs without the gate (it needs the network and a real device).
 */
const live = process.env.PASABOT_LIVE === 'push' && !!process.env.PASABOT_PUSH_SUBSCRIPTION;
describe.skipIf(!live)('web push (live)', () => {
  it('delivers to a real push service', async () => {
    const s = await bootTestServer({ modules: [createPushModule()] });
    cleanups.push(() => s.cleanup());
    const owner = seedUser(s.db);
    const sub = JSON.parse(process.env.PASABOT_PUSH_SUBSCRIPTION ?? '{}') as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    const r = await fetch(`${s.url}/api/m/push/subscriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    const t = await fetch(`${s.url}/api/m/push/subscriptions/${id}/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(await t.json()).toEqual({ ok: true, error: null });
  });
});
