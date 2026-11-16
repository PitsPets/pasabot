/**
 * W36 everyday apps: the shipped catalogue's own rules (every entry names its official source, a pinned release or
 * the vendor's https endpoint, a section, a plain line in English and Filipino, tool classes, money tools that ask),
 * the app's own sign-in found from the MCP server's metadata (a fake MCP server + fake OAuth server on 127.0.0.1,
 * port 0: discovery, client registration, PKCE, the RFC 8707 resource, the main helper's grant and the chat card),
 * SSRF refusals while discovering, and the "Needs a code" test against a fake MCP server.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PasaBotModule } from '@pasabot/core';
import { bootTestServer, seedAgent, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GROUPS,
  loadCatalog,
  manifestSchema,
  registersClient,
  toolClassesOf,
  unpinnedLauncher,
} from './manifest.js';
import connectorsModule, { CALLBACK_PATH } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_CATALOG = join(here, '..', '..', '..', 'catalog', 'connectors');
const loadMcp = async () =>
  ((await import(join(here, '..', '..', 'mcp', 'src', 'server.ts'))) as { default: PasaBotModule }).default;
const locale = (lng: string) =>
  JSON.parse(readFileSync(join(here, '..', 'locales', `${lng}.json`), 'utf8')) as {
    describe: Record<string, string>;
    try?: Record<string, { a: string; b: string }>;
  };

describe('W36: the shipped catalogue', () => {
  const { entries, problems } = loadCatalog([REPO_CATALOG]);
  it('every entry: official source, pinned release or vendor https endpoint, section, plain line en+fil, classes', () => {
    expect(problems).toEqual([]);
    const en = locale('en');
    const fil = locale('fil');
    for (const { manifest: m } of entries) {
      expect(m.source, m.slug).toMatch(/^https:\/\//);
      expect(GROUPS, m.slug).toContain(m.group);
      expect(en.describe[m.slug], m.slug).toBeTruthy();
      expect(fil.describe[m.slug], m.slug).toBeTruthy();
      expect(fil.describe[m.slug], m.slug).not.toBe(en.describe[m.slug]);
      if (m.kind === 'mcp-stdio')
        expect(unpinnedLauncher(m.mcp!.command!, m.mcp!.args ?? []), m.slug).toBeNull();
      if (m.kind === 'mcp-http') {
        const u = new URL(m.mcp!.url!);
        expect(u.protocol, m.slug).toBe('https:');
        // the vendor's own host serves it (the source page is the vendor's, or its official repository)
        expect(m.network?.allowHosts ?? [], m.slug).toEqual([]);
      }
    }
    // the apps added in W36 sign in at their own page and declare their tool classes
    for (const slug of ['notion', 'atlassian', 'trello', 'clickup', 'intercom', 'stripe']) {
      const m = entries.find((e) => e.manifest.slug === slug)?.manifest;
      expect(m, slug).toBeDefined();
      expect(registersClient(m!), slug).toBe(true);
      expect(m!.toolClasses, slug).toBeDefined();
      expect(en.try?.[slug]?.a && fil.try?.[slug]?.b, slug).toBeTruthy();
    }
    // money apps: everything that moves money or writes always asks
    const stripe = toolClassesOf(entries.find((e) => e.manifest.slug === 'stripe')!.manifest);
    for (const t of ['stripe_api_write', 'send_money', 'transfer_money', 'convert_currency'])
      expect(stripe[t], t).toBe('money');
    // tools that overwrite, move or archive the owner's content ask like a delete (the sign-in card promises it)
    const cls = (slug: string) => toolClassesOf(entries.find((e) => e.manifest.slug === slug)!.manifest);
    expect(cls('notion')).toMatchObject({ 'notion-update-page': 'delete', 'notion-move-pages': 'delete' });
    expect(cls('atlassian')).toMatchObject({ updateConfluencePage: 'delete', editJiraIssue: 'delete' });
    expect(entries.filter((e) => e.manifest.popular).length).toBeGreaterThanOrEqual(3);
  });

  it('a discovered sign-in is for HTTP servers only, and a key page needs a key', () => {
    const base = {
      schema: 'pasabot.connector/v1',
      slug: 'x',
      name: 'X',
      version: '1.0.0',
      category: 'T',
      summary: 's',
    };
    const own = { type: 'oauth2_pkce', oauth: { discover: 'mcp', clientIdFrom: 'register' } };
    expect(
      manifestSchema.safeParse({
        ...base,
        kind: 'mcp-http',
        mcp: { url: 'https://a.example/mcp' },
        auth: own,
      }).success,
    ).toBe(true);
    expect(manifestSchema.safeParse({ ...base, kind: 'oauth-api', auth: own }).success).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...base,
        kind: 'mcp-http',
        mcp: { url: 'https://a.example/mcp' },
        auth: { type: 'none', keyPage: 'https://a.example/keys' },
      }).success,
    ).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...base,
        kind: 'mcp-http',
        mcp: { url: 'https://a.example' },
        group: 'nope',
      }).success,
    ).toBe(false);
  });
});

/** a fake MCP server that is also its own OAuth server (PRM, AS metadata, DCR, PKCE) on 127.0.0.1 */
function fakeApp(o: { prmServers?: (base: string) => string[]; httpsRedirectsOnly?: boolean } = {}) {
  const clients = new Map<string, string>();
  // refresh token -> the client it was issued to (a refresh with another client is invalid_grant)
  const refreshes = new Map<string, string>();
  const tokenCalls: { grant: string; clientId: string | null }[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; resource: string | null }>();
  const tokens = new Set<string>();
  const seen: { path: string; resource?: string | null }[] = [];
  let n = 0;
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await new Promise<string>((r) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => r(b));
    });
    const json = (status: number, v: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    seen.push({ path: url.pathname });
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: o.prmServers ? o.prmServers(base) : [base],
        scopes_supported: ['read', 'write'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register') {
      const r = JSON.parse(body) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(r.token_endpoint_auth_method).toBe('none');
      // like hosted apps: a plain-http return address that is not this computer is refused
      const ru = new URL(r.redirect_uris[0]!);
      if (
        o.httpsRedirectsOnly &&
        ru.protocol === 'http:' &&
        !['127.0.0.1', 'localhost'].includes(ru.hostname)
      )
        return json(400, { error: 'invalid_redirect_uri' });
      const id = `client-${++n}`;
      clients.set(id, r.redirect_uris[0]!);
      return json(201, { client_id: id });
    }
    if (url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id')!;
      expect(clients.get(clientId)).toBe(url.searchParams.get('redirect_uri'));
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe('read write');
      const code = `code-${++n}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        clientId,
        resource: url.searchParams.get('resource'),
      });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      seen.push({ path: '/token', resource: f.get('resource') });
      tokenCalls.push({ grant: f.get('grant_type') ?? '', clientId: f.get('client_id') });
      if (f.get('grant_type') === 'refresh_token') {
        const owner = refreshes.get(f.get('refresh_token') ?? '');
        if (!owner || owner !== f.get('client_id')) return json(400, { error: 'invalid_grant' });
        const t = `tok-${++n}`;
        tokens.add(t);
        refreshes.set(`r-${n}`, owner);
        return json(200, { access_token: t, refresh_token: `r-${n}`, expires_in: 3600 });
      }
      const c = codes.get(f.get('code') ?? '');
      const ok =
        c &&
        c.clientId === f.get('client_id') &&
        c.resource === f.get('resource') &&
        createHash('sha256')
          .update(f.get('code_verifier') ?? '')
          .digest('base64url') === c.challenge;
      if (!ok) return json(400, { error: 'invalid_grant' });
      const t = `tok-${++n}`;
      tokens.add(t);
      refreshes.set(`r-${n}`, c.clientId);
      return json(200, { access_token: t, refresh_token: `r-${n}`, expires_in: 3600 });
    }
    if (url.pathname === '/mcp' || url.pathname === '/keyed') {
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const allowed = url.pathname === '/keyed' ? auth === 'good-code' : tokens.has(auth);
      if (!allowed) return res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '1' },
            }
          : m.method === 'tools/list'
            ? { tools: [{ name: 'list_pages', description: 'List pages', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'ok' }] };
      return json(200, { jsonrpc: '2.0', id: m.id, result });
    }
    res.writeHead(404).end();
  });
  return {
    server,
    seen,
    tokenCalls,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return base;
    },
  };
}

describe('W36: sign in at the app’s own page, refused addresses, and a code that is tested', () => {
  let s: TestServer;
  let owner: string;
  let main: string;
  let catalogDir: string;
  const good = fakeApp();
  // a metadata file that sends the sign-in to the cloud metadata address
  const evil = fakeApp({ prmServers: () => ['http://169.254.169.254/latest'] });
  // an app that, like hosted ones, takes no plain-http return address on another device
  const strict = fakeApp({ httpsRedirectsOnly: true });
  const LAN = '192.168.1.50';
  let goodUrl = '';
  let evilUrl = '';
  let strictUrl = '';
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${s.url}/api/m/${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${owner}`,
        origin: s.url,
        ...(init.headers as Record<string, string>),
      },
    });
  const add = async (slug: string, values: Record<string, string> = {}) =>
    (await (
      await api('connectors/installs', { method: 'POST', body: JSON.stringify({ slug, values }) })
    ).json()) as {
      id: string;
      status: string;
      signIn: boolean;
    };

  beforeAll(async () => {
    goodUrl = await good.start();
    evilUrl = await evil.start();
    strictUrl = await strict.start();
    catalogDir = mkdtempSync(join(tmpdir(), 'pasabot-w36-'));
    const put = (m: Record<string, unknown>) => {
      mkdirSync(join(catalogDir, m.slug as string), { recursive: true });
      writeFileSync(join(catalogDir, m.slug as string, '1.0.0.json'), JSON.stringify(m));
    };
    const app = (slug: string, url: string, allowHosts: string[]) =>
      put({
        schema: 'pasabot.connector/v1',
        slug,
        name: slug,
        version: '1.0.0',
        category: 'Test',
        summary: 'test',
        group: 'files-notes',
        kind: 'mcp-http',
        mcp: { url, headers: { Authorization: 'Bearer {{secret:oauth_token}}' } },
        auth: { type: 'oauth2_pkce', oauth: { discover: 'mcp', clientIdFrom: 'register' } },
        network: { allowHosts },
        toolClasses: {},
      });
    app('fake-notes', `${goodUrl}/mcp`, ['127.0.0.1']);
    app('fake-evil', `${evilUrl}/mcp`, ['127.0.0.1']);
    app('fake-strict', `${strictUrl}/mcp`, ['127.0.0.1']);
    // not allowlisted: the loopback address itself is refused while discovering
    app('fake-loopback', `${goodUrl}/mcp`, []);
    put({
      schema: 'pasabot.connector/v1',
      slug: 'fake-keyed',
      name: 'Keyed',
      version: '1.0.0',
      category: 'Test',
      summary: 'test',
      kind: 'mcp-http',
      mcp: { url: `${goodUrl}/keyed`, headers: { Authorization: 'Bearer {{secret:token}}' } },
      auth: {
        type: 'api_key',
        fields: [{ key: 'token', label: 'Code', secret: true }],
        keyPage: 'https://example.com/keys',
      },
      network: { allowHosts: ['127.0.0.1'] },
    });
    // W37: a code app that cannot be reached, one that answers but will not work, one on a private address
    const keyed = (slug: string, url: string, allowHosts: string[]) =>
      put({
        schema: 'pasabot.connector/v1',
        slug,
        name: slug,
        version: '1.0.0',
        category: 'Test',
        summary: 'test',
        kind: 'mcp-http',
        mcp: { url, headers: { Authorization: 'Bearer {{secret:token}}' } },
        auth: { type: 'api_key', fields: [{ key: 'token', label: 'Code', secret: true }] },
        network: { allowHosts },
      });
    keyed('fake-keygone', 'http://127.0.0.1:9/mcp', ['127.0.0.1']);
    keyed('fake-keyodd', `${goodUrl}/nothing-here`, ['127.0.0.1']);
    keyed('fake-keyprivate', `${goodUrl}/keyed`, []);
    // W37: an app with its own sign-in that cannot be reached
    app('fake-gone', 'http://127.0.0.1:9/mcp', ['127.0.0.1']);
    process.env.PASABOT_CONNECTORS_CATALOG = catalogDir;
    // the phone's LAN address is an allowed host, so a page opened there may start a sign-in
    s = await bootTestServer({ modules: [await loadMcp(), connectorsModule], allowedHosts: [LAN] });
    owner = seedUser(s.db).token;
    main = seedAgent(s.db, { slug: 'kuya', trust: 'trusted' });
    seedAgent(s.db, { slug: 'other', trust: 'trusted' });
    s.db
      .prepare("INSERT INTO settings (key, value) VALUES ('module:orchestrator:agentId', ?)")
      .run(JSON.stringify(main));
  });
  afterAll(async () => {
    delete process.env.PASABOT_CONNECTORS_CATALOG;
    await s.cleanup();
    good.server.close();
    evil.server.close();
    strict.server.close();
    rmSync(catalogDir, { recursive: true, force: true });
  });

  it('the catalogue says how each one signs in, and where to get a code', async () => {
    const c = (await (await api('connectors/catalog')).json()) as {
      connectors: { slug: string; group: string; auth: { signIn: string | null; keyPage: string | null } }[];
    };
    const by = (slug: string) => c.connectors.find((x) => x.slug === slug)!;
    expect(by('fake-notes').auth.signIn).toBe('own');
    expect(by('fake-notes').group).toBe('files-notes');
    expect(by('fake-keyed').auth).toMatchObject({ signIn: null, keyPage: 'https://example.com/keys' });
    expect(by('fake-keyed').group).toBe('other');
    expect(by('google-calendar').auth.signIn).toBe('owner');
  });

  it('own sign-in: discovered, registered, PKCE + resource; main helper only; a card in its chat', async () => {
    const inst = await add('fake-notes');
    expect(inst).toMatchObject({ status: 'needs_auth', signIn: true });
    const start = (await (
      await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST' })
    ).json()) as {
      authorizeUrl: string;
      redirectUri: string;
    };
    expect(start.redirectUri).toBe(`${s.url}${CALLBACK_PATH}`);
    const a = new URL(start.authorizeUrl);
    expect(a.origin + a.pathname).toBe(`${goodUrl}/authorize`);
    expect(a.searchParams.get('resource')).toBe(`${goodUrl}/mcp`);
    const back = (await fetch(start.authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
    const cb = await fetch(back, { redirect: 'manual' });
    expect(cb.headers.get('location')).toBe(`/#/connectors?oauth=connected&id=${inst.id}`);
    expect(good.seen.find((x) => x.path === '/token' && 'resource' in x)?.resource).toBe(`${goodUrl}/mcp`);

    // the token reaches the MCP server; it never sits in a row
    const server = s.db.prepare("SELECT * FROM mcp_server WHERE id = 'fake-notes'").get() as { id: string };
    expect(server).toBeDefined();
    expect(JSON.stringify(s.db.prepare('SELECT * FROM connectors_install').all())).not.toMatch(/tok-\d/);
    const test = (await (await api('mcp/servers/fake-notes/test', { method: 'POST' })).json()) as {
      ok: boolean;
    };
    expect(test.ok).toBe(true);

    // who may use it: the main helper only
    const levels = s.db
      .prepare("SELECT agent_id, role, level FROM mcp_agent WHERE server_id = 'fake-notes'")
      .all();
    expect(levels).toEqual([{ agent_id: main, role: null, level: 'use' }]);

    // "<App> is connected" in the main helper's own chat, once the app has listed its tools (W37)
    for (let i = 0; i < 50 && !cards('fake-notes'); i++) await new Promise((r) => setTimeout(r, 100));
    const card = s.db
      .prepare("SELECT m.blocks FROM messages m WHERE m.blocks LIKE '%connectors.connected%'")
      .all() as { blocks: string }[];
    expect(card).toHaveLength(1);
    expect(card[0]!.blocks).toContain('"slug":"fake-notes"');

    // a second sign-in reuses the registration for the same return address
    const again = (await (
      await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST' })
    ).json()) as {
      authorizeUrl: string;
    };
    expect(new URL(again.authorizeUrl).searchParams.get('client_id')).toBe(a.searchParams.get('client_id'));
  });

  it('a sign-in started from another address never changes the client the tokens belong to', async () => {
    const inst = await add('fake-notes');
    const from = (origin: string) =>
      api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST', headers: { origin } }).then(
        async (r) => (await r.json()) as { authorizeUrl: string },
      );
    const finish = async (authorizeUrl: string) => {
      const back = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
      // the callback runs on this server whatever host the return address names
      const u = new URL(back);
      return (await fetch(`${s.url}${u.pathname}${u.search}`, { redirect: 'manual' })).headers.get(
        'location',
      );
    };
    const clientOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get('client_id');
    const other = s.url.replace('127.0.0.1', 'localhost');
    // signed in from the laptop with client A
    const a = await from(s.url);
    expect(await finish(a.authorizeUrl)).toBe(`/#/connectors?oauth=connected&id=${inst.id}`);
    // a sign-in from another address registers client B, and is left unfinished
    const b = await from(other);
    expect(clientOf(b.authorizeUrl)).not.toBe(clientOf(a.authorizeUrl));
    // refreshing still sends client A with A's refresh token
    const r1 = await api(`connectors/installs/${inst.id}/oauth/refresh`, { method: 'POST' });
    expect(r1.status).toBe(200);
    expect(good.tokenCalls.at(-1)).toEqual({ grant: 'refresh_token', clientId: clientOf(a.authorizeUrl) });
    // two sign-ins in flight from two addresses: each exchanges with its own client; the last one wins
    const a2 = await from(s.url);
    const b2 = await from(other);
    expect(clientOf(a2.authorizeUrl)).toBe(clientOf(a.authorizeUrl)); // one client per return address, reused
    expect(clientOf(b2.authorizeUrl)).toBe(clientOf(b.authorizeUrl));
    expect(await finish(b2.authorizeUrl)).toBe(`/#/connectors?oauth=connected&id=${inst.id}`);
    expect(await finish(a2.authorizeUrl)).toBe(`/#/connectors?oauth=connected&id=${inst.id}`);
    const r2 = await api(`connectors/installs/${inst.id}/oauth/refresh`, { method: 'POST' });
    expect(r2.status).toBe(200);
    expect(good.tokenCalls.at(-1)).toEqual({ grant: 'refresh_token', clientId: clientOf(a.authorizeUrl) });
  });

  it('an app that refuses a plain-http return address on the LAN says where to sign in, not "try later"', async () => {
    const inst = await add('fake-strict');
    const port = new URL(s.url).port;
    const r = await api(`connectors/installs/${inst.id}/oauth/start`, {
      method: 'POST',
      headers: { origin: `http://${LAN}:${port}` },
    });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe('signin_insecure');
    // the same app from this computer signs in
    const ok = await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST' });
    expect(ok.status).toBe(200);
    // the page has a plain line for it in English and Filipino
    for (const lng of ['en', 'fil']) {
      const l = JSON.parse(readFileSync(join(here, '..', 'locales', `${lng}.json`), 'utf8')) as {
        signin: Record<string, string>;
      };
      expect(l.signin.insecure, lng).toContain('{{name}}');
      expect(l.signin.insecure, lng).not.toBe(l.signin.failed);
    }
  });

  it('SSRF: a metadata file pointing at the cloud metadata address, or a loopback app not allowlisted, is refused', async () => {
    for (const slug of ['fake-evil', 'fake-loopback']) {
      const inst = await add(slug);
      const r = await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST' });
      expect(r.status, slug).toBe(502);
      expect(JSON.stringify(await r.json()), slug).toMatch(/signin_refused/);
      const row = s.db.prepare('SELECT status, config FROM connectors_install WHERE id = ?').get(inst.id) as {
        status: string;
        config: string;
      };
      expect(row.status).toBe('needs_auth');
      expect(row.config).not.toContain('_client_id');
    }
  });

  it('a code: the right one tests fine, a wrong one is refused with 401 (the page then removes it)', async () => {
    const ok = await add('fake-keyed', { token: 'good-code' });
    const id = (
      s.db.prepare('SELECT id FROM mcp_server WHERE source = ?').get(`connector:${ok.id}`) as { id: string }
    ).id;
    expect(
      ((await (await api(`mcp/servers/${id}/test`, { method: 'POST' })).json()) as { ok: boolean }).ok,
    ).toBe(true);
    expect((await api(`connectors/installs/${ok.id}`, { method: 'DELETE' })).status).toBe(204);
    const bad = await add('fake-keyed', { token: 'wrong-code' });
    const id2 = (
      s.db.prepare('SELECT id FROM mcp_server WHERE source = ?').get(`connector:${bad.id}`) as { id: string }
    ).id;
    const t = (await (await api(`mcp/servers/${id2}/test`, { method: 'POST' })).json()) as {
      ok: boolean;
      error: string;
    };
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/401/);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM mcp_server').all())).not.toContain('wrong-code');
  });
  // ---------- W37: "<App> is connected" only after a working connection; a failed add keeps nothing ----------
  const cards = (slug: string) =>
    (
      s.db.prepare("SELECT m.blocks FROM messages m WHERE m.blocks LIKE '%connectors.connected%'").all() as {
        blocks: string;
      }[]
    ).filter((m) => m.blocks.includes(`"slug":"${slug}"`)).length;
  /** how many installs of this app, and how many tool servers in all (a failed add leaves both as they were) */
  const kept = (slug: string) => ({
    installs: (
      s.db.prepare('SELECT count(*) AS n FROM connectors_install WHERE manifest_id = ?').get(slug) as {
        n: number;
      }
    ).n,
    servers: (s.db.prepare('SELECT count(*) AS n FROM mcp_server').get() as { n: number }).n,
  });
  const tryCode = (slug: string, token: string) =>
    api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug, values: { token }, test: true }),
    });

  it('W37: a wrong code is refused with its own reason; nothing is kept and no card is posted', async () => {
    const before = cards('fake-keyed');
    const was = kept('fake-keyed');
    const r = await tryCode('fake-keyed', 'WRONG-code-123');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('test_code');
    expect(kept('fake-keyed')).toEqual(was);
    const listed = (await (await api('connectors/installs')).json()) as { installs: { slug: string }[] };
    expect(listed.installs.filter((i) => i.slug === 'fake-keyed')).toHaveLength(was.installs);
    expect(cards('fake-keyed')).toBe(before);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM connectors_install').all())).not.toContain('WRONG');
  });

  it('W37: an app that cannot be reached, or answers but will not work, says so; nothing kept, no card', async () => {
    for (const [slug, reason] of [
      ['fake-keygone', 'test_unreachable'],
      ['fake-keyodd', 'test_refused'],
      // a private address the app is not allowed to use: refused before anything is sent, nothing saved
      ['fake-keyprivate', 'test_unreachable'],
    ] as const) {
      const was = kept(slug);
      const r = await tryCode(slug, 'good-code');
      expect(r.status, slug).toBe(502);
      expect(((await r.json()) as { error: string }).error, slug).toBe(reason);
      expect(kept(slug), slug).toEqual(was);
      expect(cards(slug), slug).toBe(0);
    }
  });

  it('W37: the right code is tested, added, and posts "<App> is connected" exactly once', async () => {
    const before = cards('fake-keyed');
    const was = kept('fake-keyed');
    const r = await tryCode('fake-keyed', 'good-code');
    expect(r.status).toBe(201);
    const inst = (await r.json()) as { id: string; status: string };
    expect(inst.status).toBe('ready');
    expect(kept('fake-keyed')).toEqual({ installs: was.installs + 1, servers: was.servers + 1 });
    expect(cards('fake-keyed')).toBe(before + 1);
    // listing its tools again later never posts a second card
    const id = (
      s.db.prepare('SELECT id FROM mcp_server WHERE source = ?').get(`connector:${inst.id}`) as { id: string }
    ).id;
    await api(`mcp/servers/${id}/test`, { method: 'POST' });
    expect(cards('fake-keyed')).toBe(before + 1);
    expect((await api(`connectors/installs/${inst.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('W37: a sign-in that cannot start keeps nothing and says why; one that can returns the page to open', async () => {
    const gone = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug: 'fake-gone', values: {}, signIn: true }),
    });
    const was = kept('fake-gone');
    expect(gone.status).toBe(502);
    expect(((await gone.json()) as { error: string }).error).toMatch(/^signin_/);
    expect(kept('fake-gone')).toEqual({ ...was, installs: 0 });
    const ok = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug: 'fake-notes', values: {}, signIn: true }),
    });
    expect(ok.status).toBe(201);
    const j = (await ok.json()) as { id: string; status: string; authorizeUrl: string };
    expect(j.status).toBe('needs_auth');
    expect(new URL(j.authorizeUrl).origin).toBe(goodUrl);
    expect((await api(`connectors/installs/${j.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('W37: a tool server on this computer or a private network is refused before anything is saved', async () => {
    const n = () => (s.db.prepare('SELECT count(*) AS n FROM mcp_server').get() as { n: number }).n;
    const before = n();
    for (const url of [
      'http://127.0.0.1:7777/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:80/mcp',
      'http://localhost:7777/mcp',
      'http://10.0.0.5/mcp',
    ]) {
      const r = await api('mcp/servers', {
        method: 'POST',
        body: JSON.stringify({ name: `ssrf ${url.slice(7, 20)}`, transport: 'http', url }),
      });
      expect(r.status, url).toBe(400);
      expect(((await r.json()) as { error: string }).error, url).toBe('blocked_address');
    }
    expect(n()).toBe(before);
    // an address the owner allows on purpose is kept
    const allowed = await api('mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'mine',
        transport: 'http',
        url: `${goodUrl}/mcp`,
        allowHosts: ['127.0.0.1'],
      }),
    });
    expect(allowed.status).toBe(201);
  });
});
