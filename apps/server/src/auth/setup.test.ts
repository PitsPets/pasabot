import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootTestServer, type TestServer } from '../../../../packages/testkit/src/index.js';

/** Raw HTTP so the test controls Host / Origin / Upgrade exactly. */
function raw(url: string, path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  const u = new URL(url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path, method, headers, setHost: false, agent: false },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: '' });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const wsHeaders = (host: string, origin?: string) => ({
  host,
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  ...(origin ? { origin } : {}),
});

describe('test:setup', () => {
  let s: TestServer;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${s.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    s = await bootTestServer();
  });
  afterAll(() => s.cleanup());

  it('a fresh server needs setup and minted a setup link at boot (token only in the fragment)', async () => {
    expect(await (await fetch(`${s.url}/api/v1/setup`)).json()).toMatchObject({ needsSetup: true });
    expect(s.setupLink).toMatch(/\/#\/setup\?token=[\w-]{40,}$/);
  });

  it('owner creation without a valid setup token -> 403', async () => {
    expect((await post('/api/v1/setup', { displayName: 'Mallory', password: 'password123' })).status).toBe(
      403,
    );
    expect(
      (await post('/api/v1/setup', { token: 'x'.repeat(43), displayName: 'M', password: 'password123' }))
        .status,
    ).toBe(403);
    expect(s.auth.needsSetup()).toBe(true);
  });

  it('the setup token is single-use; the owner gets a session that works', async () => {
    const token = s.setupLink!.split('token=')[1]!;
    const r = await post('/api/v1/setup', { token, displayName: 'Diwa', password: 'correct horse' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { token: string; user: { kind: string } };
    expect(j.user.kind).toBe('owner');
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const me = await fetch(`${s.url}/api/v1/me`, { headers: { authorization: `Bearer ${j.token}` } });
    expect(me.status).toBe(200);
    // the same token again, and a fresh token once an owner exists
    expect(
      (await post('/api/v1/setup', { token, displayName: 'Again', password: 'password123' })).status,
    ).toBe(403);
    // minting is refused once an owner exists; a code minted elsewhere (a `pasabot setup-link` race) still gets 409
    expect(() => s.auth.issueSetupToken()).toThrow(/owner_exists/);
    const fresh = 'f'.repeat(43);
    s.db
      .prepare('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(createHash('sha256').update(fresh).digest('hex'), Date.now(), Date.now() + 60_000);
    expect(
      (await post('/api/v1/setup', { token: fresh, displayName: 'Second', password: 'password123' })).status,
    ).toBe(409);
  });

  it('password login works and a wrong password is refused', async () => {
    expect((await post('/api/v1/auth/login', { password: 'nope' })).status).toBe(401);
    expect((await post('/api/v1/auth/login', { password: 'correct horse' })).status).toBe(200);
  });

  it('a foreign Host gets 421 on HTTP and on the WS upgrade (DNS rebinding)', async () => {
    const port = new URL(s.url).port;
    expect((await raw(s.url, '/api/v1/health', { host: `evil.example:${port}` })).status).toBe(421);
    expect((await raw(s.url, '/api/v1/health', { host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(s.url, '/ws', wsHeaders(`rebind.example:${port}`))).status).toBe(421);
  });

  it('a WS upgrade from a foreign Origin is refused; an allowed Origin upgrades', async () => {
    const host = `127.0.0.1:${new URL(s.url).port}`;
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://evil.example'))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'null'))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, `http://localhost:${new URL(s.url).port}`))).status).toBe(
      101,
    );
  });

  it('the Origin check is scheme://host:port, not the host alone (the sites origin is refused)', async () => {
    const port = new URL(s.url).port;
    const host = `127.0.0.1:${port}`;
    const sitesOrigin = new URL(s.sitesUrl).origin; // same host, other port: serves untrusted HTML
    expect((await raw(s.url, '/ws', wsHeaders(host, sitesOrigin))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://localhost:5173'))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://127.0.0.1'))).status).toBe(403);
    const r = await raw(
      s.url,
      '/api/v1/auth/login',
      { host, origin: sitesOrigin, 'content-type': 'application/json' },
      'POST',
      JSON.stringify({ password: 'correct horse' }),
    );
    expect(r.status).toBe(403);
  });

  it('a cross-site mutation (foreign Origin) is refused before auth', async () => {
    const r = await post(
      '/api/v1/auth/login',
      { password: 'correct horse' },
      { origin: 'http://evil.example' },
    );
    expect(r.status).toBe(403);
  });

  it('QR pairing: code -> claim -> owner confirms -> device session; codes are single-use', async () => {
    const login = (await (await post('/api/v1/auth/login', { password: 'correct horse' })).json()) as {
      token: string;
    };
    const owner = { authorization: `Bearer ${login.token}` };
    const code = (await (await post('/api/v1/pairing', {}, owner)).json()) as {
      code: string;
      fingerprint: string;
    };
    const claim = (await (
      await post('/api/v1/pairing/claim', { code: code.code, deviceName: 'Phone' })
    ).json()) as {
      claimId: string;
      claimSecret: string;
      fingerprint: string;
    };
    expect(claim.fingerprint).toBe(code.fingerprint);
    expect((await post('/api/v1/pairing/claim', { code: code.code, deviceName: 'Thief' })).status).toBe(403);
    expect(
      (await post(`/api/v1/pairing/claims/${claim.claimId}/session`, { claimSecret: claim.claimSecret }))
        .status,
    ).toBe(202);
    expect((await post(`/api/v1/pairing/claims/${claim.claimId}/confirm`, {}, owner)).status).toBe(200);
    const sess = await post(`/api/v1/pairing/claims/${claim.claimId}/session`, {
      claimSecret: claim.claimSecret,
    });
    const j = (await sess.json()) as { token: string; deviceId: string };
    expect(sess.status).toBe(200);
    expect(
      (await fetch(`${s.url}/api/v1/me`, { headers: { authorization: `Bearer ${j.token}` } })).status,
    ).toBe(200);
  });

  it('regression (authz): pairing needs a fresh re-auth; a stale session can neither make a code nor let a device in', async () => {
    const login = async () =>
      ({
        authorization: `Bearer ${((await (await post('/api/v1/auth/login', { password: 'correct horse' })).json()) as { token: string }).token}`,
      }) as Record<string, string>;
    const stale = await login(); // fresh now, stale once the clock moves past the re-auth window
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    const notify = vi.spyOn(s.notifier, 'notify');
    try {
      const noCode = await post('/api/v1/pairing', {}, stale);
      expect(noCode.status).toBe(401);
      expect(await noCode.json()).toEqual({ error: 'reauth_required' });

      const owner = await login(); // a password sign-in counts as a fresh re-auth
      const code = (await (await post('/api/v1/pairing', {}, owner)).json()) as { code: string };
      const claim = (await (
        await post('/api/v1/pairing/claim', {
          code: code.code,
          deviceName: 'Kitchen tablet',
          platform: 'web',
        })
      ).json()) as { claimId: string; claimSecret: string };
      // the stale session sees the claim but cannot confirm it: the claim stays pending, no session is minted
      const refused = await post(`/api/v1/pairing/claims/${claim.claimId}/confirm`, {}, stale);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: 'reauth_required' });
      expect(
        (await post(`/api/v1/pairing/claims/${claim.claimId}/session`, { claimSecret: claim.claimSecret }))
          .status,
      ).toBe(202);
      expect(notify).not.toHaveBeenCalled();
      // re-auth on the stale session (password) makes it fresh again, and the confirm goes through
      expect((await post('/api/v1/auth/reauth', { password: 'correct horse' }, stale)).status).toBe(200);
      expect((await post(`/api/v1/pairing/claims/${claim.claimId}/confirm`, {}, stale)).status).toBe(200);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', body: expect.stringContaining('"Kitchen tablet" (web)') }),
      );
      // declining never needs a re-auth
      clock.mockImplementation(() => realNow() + 9 * 60_000); // owner re-authed 3 min ago: still fresh
      const c2 = (await (await post('/api/v1/pairing', {}, owner)).json()) as { code: string };
      const claim2 = (await (
        await post('/api/v1/pairing/claim', { code: c2.code, deviceName: 'Unknown' })
      ).json()) as { claimId: string };
      clock.mockImplementation(() => realNow() + 11.5 * 60_000); // owner now stale, the claim still live
      expect((await post(`/api/v1/pairing/claims/${claim2.claimId}/confirm`, {}, owner)).status).toBe(401);
      expect((await post(`/api/v1/pairing/claims/${claim2.claimId}/reject`, {}, owner)).status).toBe(200);
    } finally {
      clock.mockRestore();
      notify.mockRestore();
    }
  });

  it('QR pairing: a claim is bound to its code (`?codeId=`), and device names must be printable', async () => {
    const login = (await (await post('/api/v1/auth/login', { password: 'correct horse' })).json()) as {
      token: string;
    };
    const owner = { authorization: `Bearer ${login.token}` };
    type Code = { code: string; codeId: string; publicUrl: string | null };
    const old = (await (await post('/api/v1/pairing', {}, owner)).json()) as Code;
    const mine = (await (await post('/api/v1/pairing', {}, owner)).json()) as Code;
    expect(old.codeId).toMatch(/^[0-9a-f]{24}$/);
    expect(old.codeId).not.toBe(mine.codeId);
    expect(JSON.stringify(mine)).not.toContain(old.code);
    // the address the server advertises for phones (PASABOT_PUBLIC_URL, else its own listen URL)
    expect(new URL(mine.publicUrl!).protocol).toMatch(/^https?:$/);
    // an attacker claims the older code first with a familiar name; the real phone claims the new one
    const thief = await post('/api/v1/pairing/claim', { code: old.code, deviceName: 'Boss iPhone' });
    expect(thief.status).toBe(200);
    expect((await post('/api/v1/pairing/claim', { code: mine.code, deviceName: 'Phone' })).status).toBe(200);
    const list = async (q = '') =>
      (
        (await (await fetch(`${s.url}/api/v1/pairing/claims${q}`, { headers: owner })).json()) as {
          claims: { id: string; codeId: string; deviceName: string }[];
        }
      ).claims;
    expect((await list()).length).toBeGreaterThanOrEqual(2);
    const own = await list(`?codeId=${mine.codeId}`);
    expect(own.map((c) => c.deviceName)).toEqual(['Phone']);
    expect(own[0]!.codeId).toBe(mine.codeId);
    // terminal control sequences, bidi overrides and line separators are refused in a device name or platform
    for (const deviceName of [
      '\u001b[2K\rLet "Diwa" in',
      'a\u009b31m',
      'evil\u202egnp',
      'x\u2028y',
      '\u0007',
    ]) {
      const c = (await (await post('/api/v1/pairing', {}, owner)).json()) as Code;
      expect((await post('/api/v1/pairing/claim', { code: c.code, deviceName })).status).toBe(400);
    }
    const c = (await (await post('/api/v1/pairing', {}, owner)).json()) as Code;
    expect(
      (
        await post('/api/v1/pairing/claim', {
          code: c.code,
          deviceName: 'ok',
          platform: 'iOS\u001b]0;x\u0007',
        })
      ).status,
    ).toBe(400);
    // ordinary names (accents, emoji, Filipino text) still pass
    expect(
      (await post('/api/v1/pairing/claim', { code: c.code, deviceName: 'Teléfono ni Diwa 📱' })).status,
    ).toBe(200);
  });
});

describe('Origin allowlist (configured hosts and origins)', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await bootTestServer({
      allowedHosts: ['pasabot.example'],
      allowedOrigins: ['http://localhost:5173'],
    });
  });
  afterAll(() => s.cleanup());

  it('a configured host is allowed over https on 443, not over plain http or another port', async () => {
    const host = 'pasabot.example';
    expect((await raw(s.url, '/ws', wsHeaders(host, 'https://pasabot.example'))).status).toBe(101);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://pasabot.example'))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'https://pasabot.example:8443'))).status).toBe(403);
  });

  it('an explicitly allowed origin passes only with its exact scheme and port', async () => {
    const host = `127.0.0.1:${new URL(s.url).port}`;
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://localhost:5173'))).status).toBe(101);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'https://localhost:5173'))).status).toBe(403);
    expect((await raw(s.url, '/ws', wsHeaders(host, 'http://localhost:5174'))).status).toBe(403);
  });
});
