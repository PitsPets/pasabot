import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PasaBotModule } from '@pasabot/core';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog, manifestSchema, toolClassesOf, unpinnedLauncher } from './manifest.js';
import connectorsModule, { CALLBACK_PATH } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_CATALOG = join(here, '..', '..', '..', 'catalog', 'connectors');
const ECHO = join(here, '..', '..', 'mcp', 'src', '__fixtures__', 'echo-mcp.mjs');
/** the mcp module, loaded by path the way server discovery loads it (modules never import each other) */
const loadMcp = async () =>
  ((await import(join(here, '..', '..', 'mcp', 'src', 'server.ts'))) as { default: PasaBotModule }).default;

const base = {
  schema: 'pasabot.connector/v1',
  slug: 'x',
  name: 'X',
  version: '1.0.0',
  category: 'Test',
  summary: 'test',
};

describe('connector manifests', () => {
  it('every catalogue file validates, and folder/file names match slug/version', () => {
    const { entries, problems } = loadCatalog([REPO_CATALOG]);
    expect(problems).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(6);
    expect(entries.map((e) => e.manifest.slug)).toContain('github');
    const gh = entries.find((e) => e.manifest.slug === 'github')!.manifest;
    expect(gh.mcp?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('{{secret:token}}');
  });

  it('W38: tools a manifest tags destructive are class delete (money and messages keep their class)', () => {
    const m = manifestSchema.parse({
      ...base,
      kind: 'mcp-stdio',
      mcp: { command: 'uvx', args: ['mcp-server-time==2026.10.28'] },
      toolClasses: { pay_invoice: 'money', post_note: 'publish' },
      destructive: ['drop_bucket', 'pay_invoice', 'post_note'],
    });
    expect(toolClassesOf(m)).toEqual({ pay_invoice: 'money', post_note: 'delete', drop_bucket: 'delete' });
    expect(toolClassesOf({})).toEqual({});
    expect(
      manifestSchema.safeParse({ ...base, kind: 'mcp-stdio', mcp: { command: 'x' }, destructive: [''] })
        .success,
    ).toBe(false);
  });

  it('the seed set ships no raw web fetcher and runs only pinned releases', () => {
    const { entries } = loadCatalog([REPO_CATALOG]);
    // a stdio fetcher does its own HTTP outside safe-net (no SSRF guard): not in the seed set
    expect(entries.map((e) => e.manifest.slug)).not.toContain('fetch');
    for (const { manifest: m } of entries)
      if (m.kind === 'mcp-stdio') {
        expect(unpinnedLauncher(m.mcp!.command!, m.mcp!.args ?? []), m.slug).toBeNull();
        expect(m.network, m.slug).toBeUndefined();
      }
    const gh = entries.find((e) => e.manifest.slug === 'github')!.manifest;
    expect(gh.mcp!.args!.at(-1)).toMatch(/^ghcr\.io\/github\/github-mcp-server@sha256:[0-9a-f]{64}$/);
  });

  it('refuses unpinned launchers and a network allowlist on a stdio server', () => {
    const stdio = (command: string, args: string[], extra: Record<string, unknown> = {}) =>
      manifestSchema.safeParse({ ...base, kind: 'mcp-stdio', mcp: { command, args }, ...extra }).success;
    expect(stdio('uvx', ['mcp-server-fetch'])).toBe(false);
    expect(stdio('uvx', ['mcp-server-time==latest'])).toBe(false);
    expect(stdio('uvx', ['--from', 'evil', 'mcp-server-time==2026.10.28'])).toBe(false);
    expect(stdio('uvx', ['mcp-server-time==2026.10.28'])).toBe(true);
    expect(stdio('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])).toBe(false);
    expect(stdio('npx', ['-y', '@modelcontextprotocol/server-filesystem@latest'])).toBe(false);
    expect(stdio('npx', ['-y', '@modelcontextprotocol/server-filesystem@^2.1.0'])).toBe(false);
    expect(stdio('/usr/local/bin/npx', ['-y', '@modelcontextprotocol/server-filesystem@2.1.0', '/tmp'])).toBe(
      true,
    );
    expect(stdio('docker', ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'])).toBe(false);
    expect(stdio('docker', ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server:v2.0.3'])).toBe(false);
    expect(
      stdio('docker', ['run', '-i', '--rm', `ghcr.io/github/github-mcp-server@sha256:${'a'.repeat(64)}`]),
    ).toBe(true);
    expect(stdio('pipx', ['run', 'mcp-server-time'])).toBe(false);
    expect(stdio('pnpm', ['dlx', 'some-server@1.0.0'])).toBe(false);
    expect(stdio('node', ['server.js'])).toBe(true);
    expect(stdio('node', ['server.js'], { network: { allowHosts: ['example.com'] } })).toBe(false);
  });

  it('rejects unsafe or inconsistent manifests', () => {
    const bad = [
      { ...base, kind: 'mcp-stdio' }, // no command
      { ...base, kind: 'mcp-http', mcp: { url: 'file:///etc/passwd' } },
      {
        ...base,
        kind: 'mcp-stdio',
        mcp: { command: 'x', args: ['{{secret:token}}'] },
        auth: { type: 'api_key', fields: [{ key: 'token', label: 'T', secret: true }] },
      },
      { ...base, kind: 'mcp-stdio', mcp: { command: 'x', env: { A: '{{secret:nope}}' } } },
      { ...base, kind: 'mcp-stdio', mcp: { command: 'x', args: ['{{field:path}}'] } },
      { ...base, kind: 'oauth-api', auth: { type: 'api_key' } },
      { ...base, kind: 'mcp-stdio', mcp: { command: 'x' }, extra: true },
      { ...base, slug: '../etc', kind: 'mcp-stdio', mcp: { command: 'x' } },
      { ...base, kind: 'mcp-stdio', mcp: { command: 'x' }, homepage: 'javascript:alert(1)' },
    ];
    for (const m of bad) expect(manifestSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
    expect(manifestSchema.safeParse({ ...base, kind: 'mcp-stdio', mcp: { command: 'x' } }).success).toBe(
      true,
    );
  });
});

/** a local mock IdP (authorize + token with PKCE S256) and an MCP HTTP server that wants its bearer */
function mockIdp() {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const tokens = new Set<string>();
  let n = 0;
  const seen: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await new Promise<string>((r) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => r(b));
    });
    if (url.pathname === '/authorize') {
      const code = `code-${++n}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        clientId: url.searchParams.get('client_id')!,
        redirectUri: url.searchParams.get('redirect_uri')!,
      });
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      seen.push(f.get('grant_type')!);
      if (f.get('grant_type') === 'refresh_token') {
        if (f.get('refresh_token') !== 'refresh-1') return res.writeHead(400).end('{}');
        const t = `access-${++n}`;
        tokens.add(t);
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: t, expires_in: 3600 }));
      }
      const c = codes.get(f.get('code')!);
      codes.delete(f.get('code')!);
      const ok =
        c &&
        c.clientId === f.get('client_id') &&
        c.redirectUri === f.get('redirect_uri') &&
        createHash('sha256')
          .update(f.get('code_verifier') ?? '')
          .digest('base64url') === c.challenge &&
        f.get('client_secret') === 'owner-client-secret';
      if (!ok)
        return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
      const t = `access-${++n}`;
      tokens.add(t);
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: t, refresh_token: 'refresh-1', expires_in: 3600 }));
    }
    if (url.pathname === '/mcp') {
      const auth = String(req.headers.authorization ?? '');
      if (!tokens.has(auth.replace(/^Bearer /, ''))) return res.writeHead(401).end();
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'cal', version: '1' },
            }
          : m.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'list_events',
                    description: 'List calendar events',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : { content: [{ type: 'text', text: 'Standup at 9' }] };
      // answer as an event stream, the way streamable HTTP servers may
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return { server, tokens, seen };
}

describe('connectors module: installs, the GitHub connector, OAuth2 PKCE against a local mock IdP', () => {
  let s: TestServer;
  let owner: string;
  let agent: string;
  let catalogDir: string;
  const idp = mockIdp();
  let idpUrl = '';
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string>),
      },
    });
  const ownerRun = () => {
    const { token, runId } = seedRunToken(s.db, agent);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'o', name: 'Owner', kind: 'owner', trust: 'trusted' } }), runId);
    return token;
  };
  const tool = async (bearer: string, name: string, args: unknown) => {
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
    const j = (await r.json()) as any;
    const text = j.result.content[0].text as string;
    return j.result.isError ? { error: text } : JSON.parse(text);
  };
  const grantAll = async (serverId: string) =>
    api(`mcp/servers/${serverId}/levels`, {
      method: 'PUT',
      body: JSON.stringify({ levels: [{ role: 'all', level: 'use' }] }),
    });

  beforeAll(async () => {
    await new Promise<void>((r) => idp.server.listen(0, '127.0.0.1', r));
    idpUrl = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;
    catalogDir = mkdtempSync(join(tmpdir(), 'pasabot-catalog-'));
    const put = (m: Record<string, unknown>) => {
      mkdirSync(join(catalogDir, m.slug as string), { recursive: true });
      writeFileSync(join(catalogDir, m.slug as string, `${m.version}.json`), JSON.stringify(m));
    };
    put({
      ...base,
      slug: 'echo-local',
      name: 'Echo (local)',
      kind: 'mcp-stdio',
      mcp: {
        command: process.execPath,
        args: [ECHO],
        env: { GREETING: '{{secret:greeting}}', WHO: '{{field:who}}' },
      },
      auth: {
        type: 'api_key',
        fields: [
          { key: 'greeting', label: 'Greeting', secret: true },
          { key: 'who', label: 'Who', secret: false },
        ],
      },
    });
    put({
      ...base,
      slug: 'mock-cal',
      name: 'Mock Calendar',
      kind: 'mcp-http',
      mcp: { url: `${idpUrl}/mcp`, headers: { Authorization: 'Bearer {{secret:oauth_token}}' } },
      auth: {
        type: 'oauth2_pkce',
        oauth: {
          authorizeUrl: `${idpUrl}/authorize`,
          tokenUrl: `${idpUrl}/token`,
          scopes: ['calendar.read'],
          clientIdFrom: 'owner',
        },
      },
      network: { allowHosts: ['127.0.0.1'] },
      defaultTier: 1,
    });
    process.env.PASABOT_CONNECTORS_CATALOG = catalogDir;
    s = await bootTestServer({ modules: [await loadMcp(), connectorsModule] });
    owner = seedUser(s.db).token;
    agent = seedAgent(s.db, { slug: 'tala', trust: 'trusted' });
  });
  afterAll(async () => {
    delete process.env.PASABOT_CONNECTORS_CATALOG;
    await s.cleanup();
    idp.server.close();
    rmSync(catalogDir, { recursive: true, force: true });
  });

  it('lists the catalogue (seed set + the owner folder) to the owner only', async () => {
    const c = (await (await api('connectors/catalog')).json()) as any;
    const slugs = c.connectors.map((x: any) => x.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(['github', 'github-remote', 'google-calendar', 'echo-local', 'mock-cal']),
    );
    expect(c.problems).toBe(0);
    const member = seedUser(s.db, 'member', 'Mara').token;
    expect((await api('connectors/catalog', {}, member)).status).toBe(403);
  });

  it('GitHub: the token goes to the vault and the official server becomes an MCP server; remove takes it away', async () => {
    const missing = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug: 'github' }),
    });
    expect(missing.status).toBe(400);
    const r = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug: 'github', values: { token: 'ghp_fakeTokenValue123456' } }),
    });
    expect(r.status).toBe(201);
    const inst = (await r.json()) as any;
    expect(inst).toMatchObject({ status: 'ready', secretKeys: ['token'] });
    const row = s.db.prepare("SELECT * FROM mcp_server WHERE id = 'github'").get() as any;
    expect(row.command).toBe('docker');
    expect(JSON.parse(row.args).at(-1)).toMatch(/^ghcr\.io\/github\/github-mcp-server@sha256:[0-9a-f]{64}$/);
    expect(JSON.parse(row.env)).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: '{{secret:token}}' });
    const dump = JSON.stringify([row, s.db.prepare('SELECT * FROM connectors_install').all()]);
    expect(dump).not.toContain('ghp_fakeTokenValue123456');
    const ev = s.db.prepare("SELECT data FROM events WHERE type = 'connectors.mcp'").all() as {
      data: string;
    }[];
    expect(JSON.stringify(ev)).not.toContain('ghp_fakeTokenValue123456');

    // 7.1 upgrade path: a server installed before tool classes existed (cached tool list, no classes at all) gets
    // its cache dropped by the backfill migration and the manifest's declared classes back when mcp is ready again
    const declared = JSON.parse(row.declared_classes);
    expect(declared.add_issue_comment).toBe('outbound-message');
    s.db
      .prepare(
        "UPDATE mcp_server SET declared_classes = '{}', tool_classes = '{}', tools_cache = ?, tier = 1, name = 'Kept' WHERE id = 'github'",
      )
      .run(JSON.stringify([{ name: 'add_issue_comment', description: '', inputSchema: { type: 'object' } }]));
    s.db.exec(
      readFileSync(
        join(here, '..', '..', 'mcp', 'migrations', '202611141700_tool_classes_backfill.sql'),
        'utf8',
      ),
    );
    s.bus.publish('module:mcp', 'mcp.ready', {});
    const upgraded = s.db.prepare("SELECT * FROM mcp_server WHERE id = 'github'").get() as any;
    expect(upgraded.tools_cache).toBeNull();
    expect(JSON.parse(upgraded.declared_classes)).toEqual(declared);
    // the re-announce changes nothing the owner set
    expect(upgraded).toMatchObject({ tier: 1, name: 'Kept' });

    expect((await api(`connectors/installs/${inst.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(s.db.prepare("SELECT id FROM mcp_server WHERE id = 'github'").get()).toBeUndefined();
  });

  it('an installed stdio connector is found and invoked by an agent (secret + field reach the process)', async () => {
    const r = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ slug: 'echo-local', values: { greeting: 'magandang-umaga', who: 'Diwa' } }),
    });
    expect(r.status).toBe(201);
    await grantAll('echo-local');
    const tok = ownerRun();
    const found = await tool(tok, 'tools_find', { query: 'echo' });
    expect(found.tools.map((t: any) => t.tool)).toContain('echo-local/echo_text');
    expect(
      (await tool(tok, 'tools_invoke', { tool: 'echo-local/read_env', arguments: { name: 'WHO' } })).result,
    ).toBe('Diwa');
    const g = await tool(tok, 'tools_invoke', {
      tool: 'echo-local/read_env',
      arguments: { name: 'GREETING' },
    });
    expect(g.result).not.toContain('magandang-umaga'); // reached the process, redacted on the way out
  });

  it('OAuth2 PKCE: owner client id, sign-in at the mock IdP, token in the vault, the agent uses the HTTP server', async () => {
    const r = await api('connectors/installs', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'mock-cal',
        clientId: 'owner-client',
        clientSecret: 'owner-client-secret',
      }),
    });
    const inst = (await r.json()) as any;
    expect(inst.status).toBe('needs_auth');
    expect(s.db.prepare("SELECT id FROM mcp_server WHERE id = 'mock-cal'").get()).toBeUndefined();

    const start = (await (
      await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST', headers: { origin: s.url } })
    ).json()) as { authorizeUrl: string; redirectUri: string };
    expect(start.redirectUri).toBe(`${s.url}${CALLBACK_PATH}`);
    const a = new URL(start.authorizeUrl);
    expect(a.searchParams.get('client_id')).toBe('owner-client');
    expect(a.searchParams.get('scope')).toBe('calendar.read');

    // the browser: IdP redirects back to our public callback, which redirects into the app
    const idpRes = await fetch(start.authorizeUrl, { redirect: 'manual' });
    const callback = idpRes.headers.get('location')!;
    expect(callback.startsWith(`${s.url}${CALLBACK_PATH}?`)).toBe(true);
    const cb = await fetch(callback, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`/#/connectors?oauth=connected&id=${inst.id}`);
    // the state is single use
    const replay = await fetch(callback, { redirect: 'manual' });
    expect(replay.headers.get('location')).toBe('/#/connectors?oauth=expired');

    const installs = (await (await api('connectors/installs')).json()) as any;
    const mine = installs.installs.find((i: any) => i.id === inst.id);
    expect(mine.status).toBe('ready');
    expect(mine.oauth.expiresAt).toBeGreaterThan(Date.now());
    const dump = JSON.stringify([
      s.db.prepare('SELECT * FROM connectors_install').all(),
      s.db.prepare('SELECT * FROM mcp_server').all(),
    ]);
    expect(dump).not.toMatch(/access-\d|refresh-1|owner-client-secret/);

    await grantAll('mock-cal');
    const tok = ownerRun();
    expect((await tool(tok, 'tools_find', { query: 'calendar' })).tools[0].tool).toBe('mock-cal/list_events');
    expect((await tool(tok, 'tools_invoke', { tool: 'mock-cal/list_events', arguments: {} })).result).toBe(
      'Standup at 9',
    );

    // refresh: a new access token replaces the old one under the same vault ref
    const before = s.db.prepare("SELECT env_secret_refs FROM mcp_server WHERE id = 'mock-cal'").get() as any;
    idp.tokens.clear(); // old tokens stop working at the IdP
    expect(
      (
        await api(`connectors/installs/${inst.id}/oauth/refresh`, {
          method: 'POST',
          headers: { origin: s.url },
        })
      ).status,
    ).toBe(200);
    expect(idp.seen).toContain('refresh_token');
    expect(
      (await tool(ownerRun(), 'tools_invoke', { tool: 'mock-cal/list_events', arguments: {} })).result,
    ).toBe('Standup at 9');
    const after = s.db.prepare("SELECT env_secret_refs FROM mcp_server WHERE id = 'mock-cal'").get() as any;
    expect(after.env_secret_refs).toBe(before.env_secret_refs);
  });

  it('a wrong verifier or an unknown state never yields a token', async () => {
    const inst = (await (
      await api('connectors/installs', {
        method: 'POST',
        body: JSON.stringify({
          slug: 'mock-cal',
          clientId: 'someone-else',
          clientSecret: 'owner-client-secret',
        }),
      })
    ).json()) as any;
    const start = (await (
      await api(`connectors/installs/${inst.id}/oauth/start`, { method: 'POST', headers: { origin: s.url } })
    ).json()) as { authorizeUrl: string };
    // the IdP issued the code to a different client id than the one the server will present
    const u = new URL(start.authorizeUrl);
    u.searchParams.set('client_id', 'owner-client');
    const callback = (await fetch(u, { redirect: 'manual' })).headers.get('location')!;
    expect((await fetch(callback, { redirect: 'manual' })).headers.get('location')).toBe(
      `/#/connectors?oauth=failed&id=${inst.id}`,
    );
    const bogus = await fetch(`${s.url}${CALLBACK_PATH}?code=x&state=nope`, { redirect: 'manual' });
    expect(bogus.headers.get('location')).toBe('/#/connectors?oauth=expired');
    const row = s.db.prepare('SELECT status FROM connectors_install WHERE id = ?').get(inst.id) as any;
    expect(row.status).toBe('needs_auth');
  });
});
