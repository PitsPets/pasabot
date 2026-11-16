/**
 * W13 OAuth2 PKCE sign-in from the Connectors page, against a local mock IdP (no network): the owner installs an
 * OAuth connector with their own client id, taps Sign in, the IdP sends the browser back to the public callback,
 * and the page shows the connector signed in. Runs at 1440 and 390 px (one project each).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const PASSWORD = 'correct horse battery';

test('connectors: sign in with the owner’s OAuth client at a mock IdP', async ({ page }) => {
  const codes = new Map<string, string>();
  const idp = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/authorize') {
        const code = `c${codes.size + 1}`;
        codes.set(code, url.searchParams.get('code_challenge')!);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/token') {
        const f = new URLSearchParams(body);
        const ok =
          f.get('client_id') === 'my-own-client' &&
          createHash('sha256')
            .update(f.get('code_verifier') ?? '')
            .digest('base64url') === codes.get(f.get('code')!);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(
          ok ? JSON.stringify({ access_token: 'e2e-access', expires_in: 3600 }) : '{"error":"invalid_grant"}',
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  const idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  const catalog = mkdtempSync(join(tmpdir(), 'pasabot-e2e-catalog-'));
  mkdirSync(join(catalog, 'mock-sign-in'));
  writeFileSync(
    join(catalog, 'mock-sign-in', '1.0.0.json'),
    JSON.stringify({
      schema: 'pasabot.connector/v1',
      slug: 'mock-sign-in',
      name: 'Mock Sign-in',
      version: '1.0.0',
      category: 'Test',
      summary: 'A local test identity provider.',
      kind: 'oauth-api',
      auth: {
        type: 'oauth2_pkce',
        oauth: {
          authorizeUrl: `${idpUrl}/authorize`,
          tokenUrl: `${idpUrl}/token`,
          scopes: ['read'],
          clientIdFrom: 'owner',
        },
      },
      network: { allowHosts: ['127.0.0.1'] },
    }),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
    cwd: webRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PASABOT_CONNECTORS_CATALOG: catalog },
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
    // the first-run step 1 ("Pick a brain") shows; this test needs no agent, so it goes straight to Connectors
    await expect(page.getByTestId('onb-brain')).toBeVisible();

    await page.goto(`${server.url}/#/connectors`);
    const card = page.locator('[data-connector="mock-sign-in"]');
    await expect(card.getByTestId('connector-action')).toHaveText('Sign in');
    await card.getByTestId('connector-action').click();
    // before anything, one card says what the helper will be able to do
    await expect(card.getByTestId('connector-signin')).toContainText('Your helper will be able to:');
    await expect(card.getByTestId('connector-redirect')).toHaveText(
      `${server.url}/hooks/connectors/oauth/callback`,
    );
    await card.getByLabel('Sign-in app ID').fill('my-own-client');
    await expect(card.getByLabel(/Sign-in app password/)).toHaveAttribute('type', 'password');
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    const installed = page.locator('[data-connector-install="mock-sign-in"]');
    await expect(installed.locator('[data-install-status="needs_auth"]')).toBeVisible();
    await installed.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('oauth-outcome')).toHaveText('Signed in. Mock Sign-in is ready.');
    await expect(installed.locator('[data-install-status="ready"]')).toBeVisible();
    const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(width[0]).toBeLessThanOrEqual(width[1]!);
  } finally {
    child.stdin?.end();
    child.kill('SIGTERM');
    idp.close();
    rmSync(catalog, { recursive: true, force: true });
  }
});
