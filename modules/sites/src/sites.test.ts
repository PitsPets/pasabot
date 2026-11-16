import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPath, createSitesModule, LIMITS, normalizeBase, slugBase } from './server.js';

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

const three = [
  {
    path: 'index.html',
    content:
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Menu</h1><script src="app.js"></script>',
  },
  { path: 'style.css', content: 'h1 { color: teal; }' },
  { path: 'app.js', content: 'document.title = "Menu";' },
];
const DAY = 24 * 60 * 60 * 1000;

/** A run token for an agent whose run was started by the owner. */
const ownerRun = (s: TestServer, agentId: string) => {
  const { token, runId } = seedRunToken(s.db, agentId);
  s.db
    .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
    .run(JSON.stringify({ sender: { id: 'x', name: 'Owner', kind: 'owner', trust: 'trusted' } }), runId);
  return token;
};

/** A WebSocket upgrade with the given headers: the status the server answers (101 when it upgrades). */
const upgrade = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(`${url}/ws`);
    const req = request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

describe('sites module (tools over /mcp, sites origin, owner REST)', () => {
  let s: TestServer;
  let owner: string;
  let clock = Date.now();
  let sweep: () => Promise<number> = async () => 0;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let guarded: { id: string; token: string };
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/sites${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const run = (agentId: string) => ownerRun(s, agentId);
  const pending = () =>
    (s.db.prepare("SELECT count(*) AS n FROM approvals WHERE state = 'pending'").get() as { n: number }).n;

  beforeAll(async () => {
    s = await bootTestServer({
      modules: [createSitesModule({ now: () => clock, sweepMs: 0, onReady: (x) => (sweep = x.sweep) })],
    });
    owner = seedUser(s.db).token;
    const aid = seedAgent(s.db, { trust: 'trusted', slug: 'tala' });
    const bid = seedAgent(s.db, { trust: 'trusted', slug: 'ligaya' });
    const gid = seedAgent(s.db, { trust: 'guarded', slug: 'bantay' });
    a = { id: aid, token: run(aid) };
    b = { id: bid, token: run(bid) };
    guarded = { id: gid, token: run(gid) };
  });
  afterAll(() => s.cleanup());

  let site: { id: string; slug: string; url: string };

  it('publishes a 3-file site on the sites origin and the URL opens', async () => {
    const r = await rpc(s.url, a.token, 'sites_publish', { title: 'Lunch menu', files: three });
    expect(r.error).toBeUndefined();
    expect(r.files).toBe(3);
    expect(r.slug).toMatch(/^lunch-menu-[a-z2-9]{10}$/);
    expect(new URL(r.url).origin).toBe(new URL(s.sitesUrl).origin);
    expect(new URL(r.url).origin).not.toBe(new URL(s.url).origin);
    site = r as typeof site;
    const page = await fetch(r.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<h1>Menu</h1>');
    expect(page.headers.get('content-type')).toContain('text/html');
    const css = await fetch(r.url.replace('index.html', 'style.css'));
    expect(await css.text()).toContain('teal');
    expect(css.headers.get('content-type')).toContain('text/css');
    // the app origin never serves it
    expect(
      (await fetch(`${s.url}/sites/${r.slug}/index.html`)).headers.get('content-type') ?? '',
    ).not.toContain('text/css');
  });

  it('every sites response carries CSP: sandbox allow-scripts and nosniff, 404s included', async () => {
    const base = site.url.replace('index.html', '');
    for (const p of ['index.html', 'style.css', 'app.js', 'missing.html', '../../etc/passwd', '%2e%2e/x']) {
      const r = await fetch(base + p);
      expect(r.headers.get('content-security-policy'), p).toBe('sandbox allow-scripts');
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
    }
  });

  it('a script on the sites origin gets 403 on credentialed /api writes and /ws, 401 without a session', async () => {
    const origin = new URL(s.sitesUrl).origin;
    const cookie = `pasabot_session=${owner}`;
    // even carrying the owner's cookie (cookies ignore ports), a call from the sites origin is refused
    const post = await fetch(`${s.url}/api/m/sites/settings`, {
      method: 'PUT',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ publicBaseUrl: 'https://evil.example' }),
    });
    expect(post.status).toBe(403);
    // (a sandboxed page sends `Origin: null`; the browser sends it no SameSite=Strict cookie, proven in e2e)
    expect(await upgrade(s.url, { origin, cookie })).toBe(403);
    expect(await upgrade(s.url, { origin: 'null', cookie })).toBe(403);
    // a sandboxed page sends no cookie at all: the API answers 401
    expect((await fetch(`${s.url}/api/m/sites/sites`, { headers: { origin: 'null' } })).status).toBe(401);
    expect((await fetch(`${s.url}/api/v1/chats`, { headers: { origin } })).status).toBe(401);
  });

  it('refuses the 21st file, bad paths and a site without index.html, without asking the owner', async () => {
    const before = pending();
    const files = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({
      path: i === 0 ? 'index.html' : `p${i}.html`,
      content: `<p>${i}</p>`,
    }));
    const r = await rpc(s.url, guarded.token, 'sites_publish', { title: 'Too many', files });
    expect(r.error).toMatch(/at most 20 files; this one has 21/);
    for (const path of ['../x.html', '.env', 'a/../b.html', 'run.exe', 'img\\x.png', '/abs.html', 'a b.html'])
      expect(
        (await rpc(s.url, a.token, 'sites_publish', { title: 'x', files: [{ path, content: 'x' }] })).error,
        path,
      ).toMatch(/bad file path|not allowed/);
    expect(
      (
        await rpc(s.url, a.token, 'sites_publish', {
          title: 'x',
          files: [{ path: 'page.html', content: 'x' }],
        })
      ).error,
    ).toMatch(/needs an index.html/);
    expect(
      (
        await rpc(s.url, a.token, 'sites_publish', {
          title: 'x',
          files: [{ path: 'index.html', content: 'x'.repeat(LIMITS.fileBytes + 1) }],
        })
      ).error,
    ).toBeDefined();
    // 20 files is fine
    const ok = await rpc(s.url, a.token, 'sites_publish', { title: 'Twenty', files: files.slice(0, 20) });
    expect(ok.files).toBe(20);
    expect(pending()).toBe(before);
    expect((await rpc(s.url, a.token, 'sites_unpublish', { site: ok.id })).removed).toBe(ok.slug);
  });

  it('publishing is tier 2: a guarded agent waits for the owner', async () => {
    const call = rpc(s.url, guarded.token, 'sites_publish', { title: 'Guarded', files: three.slice(0, 1) });
    let row: { id: string; tier: number } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(guarded.id) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row?.tier).toBe(2);
    s.approvals.decide(row!.id, 'denied', 'owner');
    expect((await call).error).toBeDefined();
    expect(s.db.prepare('SELECT count(*) AS n FROM sites_site WHERE agent_id = ?').get(guarded.id)).toEqual({
      n: 0,
    });
  });

  it('only the publishing agent replaces, renews or removes its site', async () => {
    for (const [tool, args] of [
      ['sites_renew', { site: site.slug }],
      ['sites_unpublish', { site: site.id }],
      ['sites_publish', { site: site.id, title: 'Hijack', files: three }],
    ] as const)
      expect((await rpc(s.url, b.token, tool, args)).error, tool).toMatch(/published by another agent/);
    expect(await (await fetch(site.url)).text()).toContain('<h1>Menu</h1>');
    expect(await rpc(s.url, b.token, 'sites_list', {})).toEqual([]);
    const mine = (await rpc(s.url, a.token, 'sites_list', {})) as unknown as { slug: string }[];
    expect(mine.map((x) => x.slug)).toEqual([site.slug]);
  });

  it('replacing keeps the address and swaps the files', async () => {
    const r = await rpc(s.url, a.token, 'sites_publish', {
      site: site.slug,
      title: 'Lunch menu v2',
      files: [
        { path: 'index.html', content: '<h1>Menu two</h1>' },
        { path: 'img/dot.png', base64: 'iVBORw0KGgo=' },
      ],
    });
    expect(r.url).toBe(site.url);
    expect(await (await fetch(site.url)).text()).toContain('Menu two');
    expect((await fetch(site.url.replace('index.html', 'style.css'))).status).toBe(404);
    const png = await fetch(site.url.replace('index.html', 'img/dot.png'));
    expect(png.headers.get('content-type')).toBe('image/png');
  });

  it('a secret value in a text file is redacted before it is published', async () => {
    await s.vault.put('global', 'shop_key', 'sk-test-5a6b7c8d9e0f1234');
    const r = await rpc(s.url, a.token, 'sites_publish', {
      title: 'Leaky',
      files: [{ path: 'index.html', content: '<p>key: sk-test-5a6b7c8d9e0f1234</p>' }],
    });
    const body = await (await fetch(r.url)).text();
    expect(body).not.toContain('sk-test-5a6b7c8d9e0f1234');
    await rpc(s.url, a.token, 'sites_unpublish', { site: r.id });
  });

  it('owner REST: list, tunnel address, public toggle, renew, remove; members are refused', async () => {
    const member = seedUser(s.db, 'member', 'Mia').token;
    expect((await api('/sites', {}, member)).status).toBe(403);
    const list = (await (await api('/sites')).json()) as {
      sites: { id: string; agent: { name: string }; paths: { path: string }[]; publicUrl: string | null }[];
      publicBaseUrl: string;
    };
    const mine = list.sites.find((x) => x.id === site.id)!;
    expect(mine.agent.name).toBe('tala');
    expect(mine.paths.map((p) => p.path)).toEqual(['img/dot.png', 'index.html']);
    expect(list.publicBaseUrl).toBe('');
    // public needs a tunnel address first
    const no = await api(`/sites/${site.id}/public`, {
      method: 'POST',
      body: JSON.stringify({ public: true }),
    });
    expect(no.status).toBe(400);
    expect(
      (
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({ publicBaseUrl: 'javascript:alert(1)' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({ publicBaseUrl: 'https://sites.example.test/' }),
        })
      ).status,
    ).toBe(200);
    const pub = (await (
      await api(`/sites/${site.id}/public`, { method: 'POST', body: JSON.stringify({ public: true }) })
    ).json()) as { publicUrl: string };
    expect(pub.publicUrl).toBe(`https://sites.example.test/sites/${site.slug}/index.html`);
    const renewed = (await (
      await api(`/sites/${site.id}/renew`, { method: 'POST', body: JSON.stringify({ days: 30 }) })
    ).json()) as { expiresAt: number };
    expect(renewed.expiresAt).toBe(clock + 30 * DAY);
  });

  it('the expiry job removes an expired site; renew keeps one alive', async () => {
    const short = await rpc(s.url, b.token, 'sites_publish', { title: 'Short', files: three, days: 1 });
    const kept = await rpc(s.url, b.token, 'sites_publish', { title: 'Kept', files: three, days: 1 });
    expect((await fetch(short.url)).status).toBe(200);
    expect((await rpc(s.url, b.token, 'sites_renew', { site: kept.id, days: 3 })).expiresAt).toBe(
      new Date(clock + 3 * DAY).toISOString(),
    );
    clock += 2 * DAY;
    expect(await sweep()).toBe(1);
    expect((await fetch(short.url)).status).toBe(404);
    expect(s.db.prepare('SELECT count(*) AS n FROM sites_site WHERE id = ?').get(short.id)).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) AS n FROM sites_file WHERE site_id = ?').get(short.id)).toEqual({
      n: 0,
    });
    expect((await fetch(kept.url)).status).toBe(200);
    const listed = (await rpc(s.url, b.token, 'sites_list', {})) as unknown as { id: string }[];
    expect(listed.map((x) => x.id)).toEqual([kept.id]);
    // the owner removes a site
    expect((await api(`/sites/${kept.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(kept.url)).status).toBe(404);
  });
});

describe('sites survive a restart with their content types', () => {
  it('a live site is served again after the server restarts; an expired one is gone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pasabot-sites-'));
    let clock = Date.now();
    try {
      const boot = () =>
        bootTestServer({ home, modules: [createSitesModule({ now: () => clock, sweepMs: 0 })] });
      let s = await boot();
      const aid = seedAgent(s.db, { trust: 'trusted' });
      const token = ownerRun(s, aid);
      const files = [
        { path: 'index.html', content: '<p>hi</p>' },
        { path: 'pic.webp', base64: 'UklGRg==' },
      ];
      const live = await rpc(s.url, token, 'sites_publish', { title: 'Live', files, days: 5 });
      const gone = await rpc(s.url, token, 'sites_publish', { title: 'Gone', files, days: 1 });
      await s.close();
      clock += 2 * DAY;
      s = await boot();
      const sitesUrl = s.sitesUrl;
      const at = (u: string) => `${sitesUrl}${new URL(u).pathname}`;
      const pic = await fetch(at(live.url).replace('index.html', 'pic.webp'));
      expect(pic.status).toBe(200);
      expect(pic.headers.get('content-type')).toBe('image/webp');
      expect((await fetch(at(gone.url))).status).toBe(404);
      await s.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('site bytes are freed and quotas hold under load', () => {
  let s: TestServer;
  let home: string;
  let clock = Date.now();
  let sweep: () => Promise<number> = async () => 0;
  const store = () => join(home, 'modules', 'sites', 'store');
  const blobRows = () => (s.db.prepare('SELECT count(*) AS n FROM blobs').get() as { n: number }).n;
  /** about 300 KB of fresh random text, so no two publishes share a stored file */
  const big = () => [
    { path: 'index.html', content: '<p>hi</p>' },
    { path: 'noise.txt', content: randomBytes(225 * 1024).toString('base64') },
  ];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pasabot-sites-gc-'));
    s = await bootTestServer({
      home,
      modules: [createSitesModule({ now: () => clock, sweepMs: 0, onReady: (x) => (sweep = x.sweep) })],
    });
  });
  afterAll(async () => {
    await s.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('unpublish, replace and expiry free the stored bytes; nothing goes to the shared BlobStore', async () => {
    const aid = seedAgent(s.db, { trust: 'trusted' });
    const token = ownerRun(s, aid);
    const blobsBefore = blobRows();
    // publish/unpublish churn: the store is empty again after each round
    for (let i = 0; i < 5; i++) {
      const r = await rpc(s.url, token, 'sites_publish', { title: `Churn ${i}`, files: big() });
      expect(r.error).toBeUndefined();
      expect(readdirSync(store())).toHaveLength(2);
      expect((await rpc(s.url, token, 'sites_unpublish', { site: r.id })).removed).toBe(r.slug);
      expect(readdirSync(store())).toEqual([]);
    }
    // replacing the same site again and again keeps only the current files
    const site = await rpc(s.url, token, 'sites_publish', { title: 'Same', files: big() });
    for (let i = 0; i < 4; i++)
      expect(
        (await rpc(s.url, token, 'sites_publish', { site: site.id, title: 'Same', files: big() })).url,
      ).toBe(site.url);
    expect(readdirSync(store())).toHaveLength(2);
    const sizes = readdirSync(store()).reduce((n, f) => n + statSync(join(store(), f)).size, 0);
    expect(sizes).toBeLessThan(LIMITS.siteBytes);
    // the expiry job frees it too
    clock += (LIMITS.defaultDays + 1) * DAY;
    expect(await sweep()).toBe(1);
    expect(readdirSync(store())).toEqual([]);
    expect(blobRows()).toBe(blobsBefore);
  });

  it('a shared file stays while another site still uses it', async () => {
    const aid = seedAgent(s.db, { trust: 'trusted' });
    const token = ownerRun(s, aid);
    const one = await rpc(s.url, token, 'sites_publish', { title: 'One', files: three });
    const two = await rpc(s.url, token, 'sites_publish', { title: 'Two', files: three });
    expect(readdirSync(store())).toHaveLength(3);
    await rpc(s.url, token, 'sites_unpublish', { site: one.id });
    expect(readdirSync(store())).toHaveLength(3);
    expect(await (await fetch(two.url.replace('index.html', 'style.css'))).text()).toContain('teal');
    await rpc(s.url, token, 'sites_unpublish', { site: two.id });
    expect(readdirSync(store())).toEqual([]);
  });

  it('concurrent publishes cannot pass the live-site quota together', async () => {
    const aid = seedAgent(s.db, { trust: 'trusted' });
    const token = ownerRun(s, aid);
    for (let i = 0; i < LIMITS.sitesPerAgent - 1; i++)
      expect(
        (await rpc(s.url, token, 'sites_publish', { title: `Site ${i}`, files: three })).error,
      ).toBeUndefined();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        rpc(s.url, token, 'sites_publish', {
          title: `Race ${i}`,
          files: [{ path: 'index.html', content: `${i}` }],
        }),
      ),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error).toMatch(/already have 10 live sites/);
    expect(s.db.prepare('SELECT count(*) AS n FROM sites_site WHERE agent_id = ?').get(aid)).toEqual({
      n: LIMITS.sitesPerAgent,
    });
  });

  it(`at most ${LIMITS.publishesPerHour} publishes an hour per agent, refused without asking the owner`, async () => {
    const aid = seedAgent(s.db, { trust: 'trusted' });
    const token = ownerRun(s, aid);
    const tiny = [{ path: 'index.html', content: '<p>x</p>' }];
    const site = await rpc(s.url, token, 'sites_publish', { title: 'Busy', files: tiny });
    for (let i = 1; i < LIMITS.publishesPerHour; i++)
      expect(
        (await rpc(s.url, token, 'sites_publish', { site: site.id, title: 'Busy', files: tiny })).error,
      ).toBeUndefined();
    const approvals = () => (s.db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number }).n;
    const before = approvals();
    expect((await rpc(s.url, token, 'sites_publish', { title: 'More', files: tiny })).error).toMatch(
      /at most 30 times an hour/,
    );
    expect(approvals()).toBe(before);
    clock += 61 * 60 * 1000;
    expect((await rpc(s.url, token, 'sites_publish', { title: 'More', files: tiny })).error).toBeUndefined();
  });
});

describe('helpers', () => {
  it('paths, slugs and tunnel addresses', () => {
    expect(checkPath('index.html').mime).toContain('text/html');
    expect(() => checkPath('a/./b.html')).toThrow();
    expect(slugBase('  Ang Menu ng Tanghalian!! ')).toBe('ang-menu-ng-tanghalian');
    expect(slugBase('***')).toBe('site');
    expect(normalizeBase('https://sites.example.test/x/')).toBe('https://sites.example.test/x');
    expect(normalizeBase('ftp://x')).toBeNull();
    expect(normalizeBase('https://a@x.test')).toBeNull();
    expect(normalizeBase('')).toBe('');
  });
});
