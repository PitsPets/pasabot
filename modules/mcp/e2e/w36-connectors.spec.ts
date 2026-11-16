/**
 * W36 everyday apps in the browser, in English and Filipino at 1440 and 390 px: a Popular row on top, one section per
 * thing people do, each card with its brand tile, one plain line and one button that says what happens (Add, Sign
 * in, Needs a code); Sign in first shows what the helper will be able to do; the app's own sign-in runs end to end
 * against a fake app on 127.0.0.1 (its own metadata, client registration, PKCE) and lands under Connected, with who
 * may use it. Nothing here reaches a real service: the real apps' Sign in is opened, never continued.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { skipOnboarding } from '../../../packages/testkit/src/e2e.js';

const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const PASSWORD = 'correct horse battery';
// biome-ignore lint/suspicious/noExplicitAny: locale JSON
const strings = (lng: string): any =>
  JSON.parse(readFileSync(new URL(`../../connectors/locales/${lng}.json`, import.meta.url), 'utf8'));
const fill = (s: string, v: Record<string, string>) =>
  s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => v[k] ?? '');

/** a fake app: an MCP server that is its own OAuth server (RFC 9728 + 8414 metadata, 7591 registration, PKCE) */
function fakeApp() {
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  let base = '';
  let n = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, v: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json(200, {
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/register') return json(201, { client_id: `fake-client-${++n}` });
      if (url.pathname === '/authorize') {
        const code = `c${++n}`;
        codes.set(code, url.searchParams.get('code_challenge')!);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (url.pathname === '/token') {
        const f = new URLSearchParams(body);
        const ok =
          createHash('sha256')
            .update(f.get('code_verifier') ?? '')
            .digest('base64url') === codes.get(f.get('code') ?? '');
        if (!ok) return json(400, { error: 'invalid_grant' });
        const t = `t${++n}`;
        tokens.add(t);
        return json(200, { access_token: t, expires_in: 3600 });
      }
      if (url.pathname === '/mcp' || url.pathname === '/keyed') {
        const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        // W37: `/keyed` takes one pasted code; `/mcp` the tokens its own sign-in issued
        if (!(url.pathname === '/keyed' ? auth === 'good-code' : tokens.has(auth)))
          return res.writeHead(401).end();
        const m = JSON.parse(body);
        if (m.id === undefined) return res.writeHead(202).end();
        const result =
          m.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'f', version: '1' },
              }
            : { tools: [{ name: 'list_notes', description: 'List notes', inputSchema: { type: 'object' } }] };
        return json(200, { jsonrpc: '2.0', id: m.id, result });
      }
      res.writeHead(404).end();
    });
  });
  return {
    server,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return base;
    },
  };
}

async function noOverflow(page: Page) {
  const [doc, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(doc, `horizontal overflow at ${vw}px`).toBeLessThanOrEqual(vw!);
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(repoRoot, '.qa', `w36-${name}.png`), fullPage: true });

for (const lng of ['en', 'fil'] as const) {
  test(`W36 connectors (${lng}): Popular, sections, one button per state, sign in at the app's own page`, async ({
    page,
  }, info) => {
    const w = info.project.name === 'phone' ? 390 : 1440;
    const t = strings(lng);
    const app = fakeApp();
    const appUrl = await app.start();
    const catalog = mkdtempSync(join(tmpdir(), 'pasabot-w36-e2e-'));
    for (const d of ['fake-notes', 'bin', 'apps', 'home']) mkdirSync(join(catalog, d));
    writeFileSync(
      join(catalog, 'fake-notes', '1.0.0.json'),
      JSON.stringify({
        schema: 'pasabot.connector/v1',
        slug: 'fake-notes',
        name: 'Fake Notes',
        version: '1.0.0',
        category: 'Test',
        summary: 'A local test app.',
        group: 'files-notes',
        kind: 'mcp-http',
        mcp: { url: `${appUrl}/mcp`, headers: { Authorization: 'Bearer {{secret:oauth_token}}' } },
        auth: { type: 'oauth2_pkce', oauth: { discover: 'mcp', clientIdFrom: 'register' } },
        network: { allowHosts: ['127.0.0.1'] },
        toolClasses: {},
      }),
    );
    // W37: a code app (fake-keys), a code app that cannot be reached, a sign-in app that cannot be reached
    const manifest = (slug: string, name: string, url: string, auth: Record<string, unknown>) => {
      mkdirSync(join(catalog, slug));
      writeFileSync(
        join(catalog, slug, '1.0.0.json'),
        JSON.stringify({
          schema: 'pasabot.connector/v1',
          slug,
          name,
          version: '1.0.0',
          category: 'Test',
          summary: 'A local test app.',
          group: 'files-notes',
          kind: 'mcp-http',
          mcp: {
            url,
            headers: {
              Authorization: `Bearer {{secret:${auth.type === 'api_key' ? 'token' : 'oauth_token'}}}`,
            },
          },
          auth,
          network: { allowHosts: ['127.0.0.1'] },
          toolClasses: {},
        }),
      );
    };
    const codeAuth = {
      type: 'api_key',
      fields: [{ key: 'token', label: 'Access code', secret: true }],
      keyPage: 'https://example.com/keys',
    };
    manifest('fake-keys', 'Fake Keys', `${appUrl}/keyed`, codeAuth);
    manifest('fake-keygone', 'Fake Keygone', 'http://127.0.0.1:9/mcp', codeAuth);
    manifest('fake-gone', 'Fake Gone', 'http://127.0.0.1:9/mcp', {
      type: 'oauth2_pkce',
      oauth: { discover: 'mcp', clientIdFrom: 'register' },
    });
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      // detection and "found on this computer" look at empty test folders, never this machine's own
      env: {
        ...process.env,
        PASABOT_CONNECTORS_CATALOG: catalog,
        PASABOT_CONNECTORS_PATH: join(catalog, 'bin'),
        PASABOT_CONNECTORS_APPS: join(catalog, 'apps'),
        PASABOT_CONNECTORS_SCAN_HOME: join(catalog, 'home'),
      },
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once('line', resolve);
        child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
      });
      const server = JSON.parse(line) as { url: string; setupLink: string };
      await page.goto(server.setupLink);
      await page.getByLabel('Your name').fill('Diwa');
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await page.getByLabel('Password again').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create owner account' }).click();
      await skipOnboarding(page);
      if (lng !== 'en') {
        await page.goto(`${server.url}/#/settings/look/language`);
        await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
        await expect(page.locator('html')).toHaveAttribute('lang', lng);
      }
      await page.goto(`${server.url}/#/connectors`);
      const card = (slug: string) => page.locator(`[data-connector="${slug}"]`);

      // Popular on top, then sections of what people do; each card: its tile, one plain line, one button
      const popular = page.getByTestId('connectors-popular');
      await expect(popular.getByRole('heading', { name: t.groups.popular })).toBeVisible();
      for (const slug of ['notion', 'trello', 'stripe', 'google-calendar'])
        await expect(popular.locator(`[data-connector="${slug}"]`)).toBeVisible();
      for (const [g, slug] of [
        ['work-tasks', 'atlassian'],
        ['work-tasks', 'clickup'],
        ['social-chat', 'intercom'],
        ['files-notes', 'fake-notes'],
      ] as const) {
        const sec = page.getByTestId(`connectors-group-${g}`);
        await expect(sec.getByRole('heading', { name: t.groups[g] })).toBeVisible();
        await expect(sec.locator(`[data-connector="${slug}"]`)).toBeVisible();
      }
      for (const slug of ['notion', 'atlassian', 'trello', 'clickup', 'intercom', 'stripe']) {
        await expect(card(slug).locator('.bk-brand-tile')).toHaveAttribute('data-mark', slug);
        await expect(card(slug)).toContainText(t.describe[slug]);
        await expect(card(slug).getByTestId('connector-action')).toHaveText(t.button.signIn);
      }
      await expect(card('github-remote').getByTestId('connector-action')).toHaveText(t.button.code);
      await expect(page.getByTestId('connectors-page')).not.toContainText(/MCP|OAuth|stdio/);
      await noOverflow(page);
      await shot(page, `${lng}-${w}-catalogue`);

      // a search finds by plain words; Popular steps aside while searching
      await page.getByTestId('connectors-search').fill(lng === 'en' ? 'invoices' : 'invoice');
      await expect(card('stripe')).toBeVisible();
      await expect(card('notion')).toHaveCount(0);
      await expect(popular).toHaveCount(0);
      await page.getByTestId('connectors-search').fill('');

      // Sign in: first, what the helper will be able to do (the real app is never opened here)
      await card('stripe').getByTestId('connector-action').click();
      const consent = card('stripe').getByTestId('connector-signin');
      await expect(consent).toContainText(t.signin.can);
      await expect(consent).toContainText(t.describe.stripe);
      await expect(consent).toContainText(t.signin.ask);
      await expect(
        consent.getByRole('button', { name: fill(t.signin.go, { name: 'Stripe' }) }),
      ).toBeVisible();
      await shot(page, `${lng}-${w}-sign-in-card`);
      await consent.getByRole('button', { name: t.install.cancel }).click();
      await expect(consent).toHaveCount(0);

      // Needs a code: the app's own page, a password field
      await card('github-remote').getByTestId('connector-action').click();
      const code = card('github-remote').getByTestId('connector-install-form');
      await expect(code.getByTestId('connector-get-code')).toHaveAttribute(
        'href',
        'https://github.com/settings/personal-access-tokens/new',
      );
      await expect(code.locator('input')).toHaveAttribute('type', 'password');
      await shot(page, `${lng}-${w}-code-card`);
      await code.getByRole('button', { name: t.install.cancel }).click();

      // the app's own sign-in, end to end against the fake app
      await card('fake-notes').getByTestId('connector-action').click();
      await card('fake-notes')
        .getByRole('button', { name: fill(t.signin.go, { name: 'Fake Notes' }) })
        .click();
      await expect(page.getByTestId('oauth-outcome')).toHaveText(
        fill(t.oauth.connectedApp, { name: 'Fake Notes' }),
      );
      const added = page.locator('[data-connector-install="fake-notes"]');
      await expect(added.locator('[data-install-status="ready"]')).toHaveText(t.status.ready);
      await expect(card('fake-notes')).toHaveCount(0);
      expect(await page.content()).not.toMatch(/fake-client-\d|"t\d"/);
      await noOverflow(page);
      await shot(page, `${lng}-${w}-connected`);

      // W37: a wrong code, an app that cannot be reached: the reason shows under the field, what was typed stays,
      // nothing is listed under Connected and no "connected" card reaches the main helper's chat
      const tryCode = async (slug: string, code: string) => {
        await card(slug).getByTestId('connector-action').click();
        const form = card(slug).getByTestId('connector-install-form');
        await form.locator('input').first().fill(code);
        await form.getByRole('button', { name: t.code.test }).click();
        return form;
      };
      const wrong = await tryCode('fake-keys', 'WRONG-code-123');
      await expect(wrong.getByTestId('connector-code-error')).toHaveText(t.code.bad);
      await expect(wrong.locator('input').first()).toHaveValue('WRONG-code-123');
      await expect(page.locator('[data-connector-install="fake-keys"]')).toHaveCount(0);
      await noOverflow(page);
      await shot(page, `${lng}-${w}-wrong-code`);
      await wrong.getByRole('button', { name: t.install.cancel }).click();
      const gone = await tryCode('fake-keygone', 'any-code');
      await expect(gone.getByTestId('connector-code-error')).toHaveText(
        fill(t.code.unreachable, { name: 'Fake Keygone' }),
      );
      await expect(gone.locator('input').first()).toHaveValue('any-code');
      await expect(page.locator('[data-connector-install="fake-keygone"]')).toHaveCount(0);
      await gone.getByRole('button', { name: t.install.cancel }).click();
      // a sign-in app that cannot be reached: its own line on the card, nothing under Connected
      await card('fake-gone').getByTestId('connector-action').click();
      await card('fake-gone')
        .getByRole('button', { name: fill(t.signin.go, { name: 'Fake Gone' }) })
        .click();
      await expect(card('fake-gone').getByRole('alert')).toHaveText(
        fill(t.signin.failed, { name: 'Fake Gone' }),
      );
      await expect(page.locator('[data-connector-install="fake-gone"]')).toHaveCount(0);
      await shot(page, `${lng}-${w}-signin-unreachable`);
      const cardsFor = await page.evaluate(async () => {
        const get = (p: string) => fetch(p, { credentials: 'same-origin' }).then((r) => r.json());
        const chats = ((await get('/api/v1/chats')) as { chats?: { id: string }[] }).chats ?? [];
        let all = '';
        for (const c of chats) all += JSON.stringify(await get(`/api/v1/chats/${c.id}/messages`));
        return all;
      });
      for (const slug of ['fake-keys', 'fake-keygone', 'fake-gone'])
        expect(cardsFor, slug).not.toMatch(new RegExp(`slug\\\\?"\\s*:\\s*\\\\?"${slug}"?`));
      // the right code is tested and lands under Connected
      await tryCode('fake-keys', 'good-code');
      await expect(
        page.locator('[data-connector-install="fake-keys"] [data-install-status="ready"]'),
      ).toHaveText(t.status.ready);
    } finally {
      child.stdin?.end();
      child.kill('SIGTERM');
      app.server.close();
      rmSync(catalog, { recursive: true, force: true });
    }
  });
}
