import { randomBytes } from 'node:crypto';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, type TestServer } from '../../../../packages/testkit/src/index.js';
import { hashToken } from '../core/services.js';

describe('tier-3 approvals need a fresh re-auth', () => {
  let s: TestServer;
  /** a session of the owner that was not just signed in with the password (a stolen cookie, an old tab) */
  let token = '';
  let ownerId = '';
  let chatId = '';
  const fake = new FakeProvider();
  const api = async (path: string, body?: unknown, o: { method?: string; origin?: boolean } = {}) => {
    const r = await fetch(`${s.url}${path}`, {
      method: o.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(o.origin ? { origin: new URL(s.url).origin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined>) => {
    for (let i = 0; i < 200; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out');
  };
  const ask = (tool: string, input: unknown, decision: 'allow' | 'deny', reply: string) =>
    JSON.stringify({
      fakeScript: [
        { expectPermission: { tool, input, decision } },
        { event: { type: 'text.final', text: reply } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
  const pending = () =>
    waitFor(async () => ((await api('/api/v1/approvals?state=pending')).json.approvals as any[])[0]);
  const reply = (text: string) =>
    waitFor(async () =>
      ((await api(`/api/v1/chats/${chatId}/messages`)).json.messages as any[]).find(
        (m) => m.authorKind === 'agent' && m.body === text && m.status === 'final',
      ),
    );

  beforeAll(async () => {
    s = await bootTestServer({ providers: [fake] });
    const setup = await fetch(`${s.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: s.auth.issueSetupToken(),
        displayName: 'Owner',
        password: 'owner-password',
      }),
    });
    const j = (await setup.json()) as { token: string; user: { id: string } };
    ownerId = j.user.id;
    // the setup session is fresh (the password was just given); the tests use an older session of the owner
    token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, Date.now(), Date.now() + 3600_000);
    expect(j.token).toBeTruthy();
    const r = await api('/api/v1/agents', { name: 'Tala', providerId: 'fake' });
    chatId = r.json.chatId;
  });
  afterAll(() => s.cleanup());

  it('approve without re-auth -> 401 reauth_required; wrong password refused; after re-auth it goes through', async () => {
    await api(`/api/v1/chats/${chatId}/messages`, {
      text: ask('Read', { file_path: '/etc/hosts' }, 'allow', 'read'),
    });
    const a = await pending();
    expect(a.tier).toBe(3);
    expect(await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).toMatchObject({
      status: 401,
      json: { error: 'reauth_required' },
    });
    expect(s.approvals.get(a.id)!.state).toBe('pending');
    expect((await api('/api/v1/auth/reauth', { password: 'nope-nope' })).status).toBe(401);
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
    expect((await reply('read')).status).toBe('final');
    expect(fake.decisions.at(-1)).toEqual({ tool: 'Read', decision: 'allow' });
  });

  it('a run activity line is readable for the chat; deny of tier 3 never needs re-auth', async () => {
    s.auth.reauthedWithin('x'); // unknown session: false, no throw
    await api(`/api/v1/chats/${chatId}/messages`, {
      text: ask('Read', { file_path: '/etc/passwd' }, 'deny', 'no'),
    });
    const a = await pending();
    expect((await api(`/api/v1/approvals/${a.id}/deny`, {})).status).toBe(200);
    const m = await reply('no');
    const act = await api(`/api/v1/runs/${m.runId}/activity`);
    expect(act.status).toBe(200);
    expect(act.json.events.some((e: any) => e.type === 'permission')).toBe(true);
    expect((await api('/api/v1/runs/nope/activity')).status).toBe(404);
  });

  it('adding or removing a passkey needs a fresh re-auth (a stolen session cannot mint its own re-auth factor)', async () => {
    const stale = token;
    token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, Date.now(), Date.now() + 3600_000);
    try {
      const fake = { challengeId: 'x', response: { id: 'x' } };
      expect(await api('/api/v1/auth/passkey/register/options', {}, { origin: true })).toMatchObject({
        status: 401,
        json: { error: 'reauth_required' },
      });
      expect(await api('/api/v1/auth/passkey/register/verify', fake, { origin: true })).toMatchObject({
        status: 401,
        json: { error: 'reauth_required' },
      });
      s.db
        .prepare(
          'INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run('pk1', ownerId, 'cred1', Buffer.from([1]), 0, '[]', Date.now());
      expect(
        await api('/api/v1/auth/passkeys/pk1', undefined, { method: 'DELETE', origin: true }),
      ).toMatchObject({ status: 401, json: { error: 'reauth_required' } });
      expect(s.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get('pk1')).toBeTruthy();

      // a sign-in challenge never counts as a re-auth; the re-auth options demand user verification
      const login = await api('/api/v1/auth/passkey/login/options', {}, { origin: true });
      expect(login.status).toBe(200);
      expect(
        (
          await api(
            '/api/v1/auth/reauth',
            { passkey: { challengeId: login.json.challengeId, response: { id: 'cred1' } } },
            { origin: true },
          )
        ).status,
      ).toBe(401);
      const ro = await api('/api/v1/auth/passkey/reauth/options', {}, { origin: true });
      expect(ro.status).toBe(200);
      expect(ro.json.options.userVerification).toBe('required');
      expect(ro.json.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual(['cred1']);

      // after the password re-auth both go through
      expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
      expect((await api('/api/v1/auth/passkey/register/options', {}, { origin: true })).status).toBe(200);
      expect(
        (await api('/api/v1/auth/passkeys/pk1', undefined, { method: 'DELETE', origin: true })).status,
      ).toBe(200);
      const audit = s.db.prepare("SELECT action FROM audit_log WHERE action = 'passkey.removed'").all();
      expect(audit).toHaveLength(1);
    } finally {
      token = stale;
    }
  });

  it('a page (Origin header) gets the session cookie only; the token is in the body for non-browser clients', async () => {
    const login = (origin?: string) =>
      fetch(`${s.url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ password: 'owner-password' }),
      });
    const page = await login(new URL(s.url).origin);
    expect(page.status).toBe(200);
    const pj = (await page.json()) as Record<string, unknown>;
    expect(pj.token).toBeUndefined();
    expect(pj.user).toMatchObject({ id: ownerId });
    expect(page.headers.get('set-cookie')).toMatch(/pasabot_session=[^;]+; HttpOnly/);
    const cli = (await (await login()).json()) as { token?: string };
    expect(typeof cli.token).toBe('string');
  });
});
