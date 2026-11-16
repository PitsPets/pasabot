import type { Page } from '@playwright/test';
import { claimServer, expect, PASSWORD, test } from './fixtures.js';

test('passkey: register, sign out, sign in with a virtual authenticator', async ({ page, server }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await claimServer(page, server, server.localUrl);
  await page.goto(`${server.localUrl}/#/devices`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  await expect(page.getByTestId('passkey-row')).toHaveCount(1);

  await page.goto(`${server.localUrl}/#/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByRole('button', { name: 'Other ways to sign in' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Start your team' })).toBeVisible();

  // password still works too
  await page.goto(`${server.localUrl}/#/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  // Settings → Machines has its own password field; wait for the sign-in page first.
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start your team' })).toBeVisible();
});

test('the tagline: setup and sign-in show the original line, English adds its translation, Filipino does not', async ({
  page,
  server,
}) => {
  const original = 'Sabihin mo lang. Ako na bahala.';
  const english = "Just say it. I'll take care of it.";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.setupLink);
  const tag = page.getByTestId('tagline');
  await expect(tag).toContainText(original);
  await expect(tag).toContainText(english);
  await page.locator('[data-testid="lang-select"]:visible').first().selectOption('fil');
  await expect(tag).toHaveText(original);
  await page.locator('[data-testid="lang-select"]:visible').first().selectOption('en');
  await expect(tag).toContainText(english);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await claimServer(page, server);
  await page.goto(`${server.url}/#/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(tag).toContainText(original);
  await expect(tag).toContainText(english);
});

test('pairing by QR code value: the phone claims, the owner confirms, the phone is signed in', async ({
  page,
  browser,
  server,
}) => {
  await claimServer(page, server);
  await page.goto(`${server.url}/#/devices`);
  await page.getByRole('button', { name: 'Pair a phone' }).click();
  await expect(page.getByTestId('pair-qr')).toBeVisible();
  const link = await page.getByTestId('pair-code').getAttribute('data-link');
  expect(link).toContain('#/pair?code=');

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  await p.goto(link!);
  await p.getByLabel('Name for this device').fill('Test phone');
  await p.getByRole('button', { name: 'Pair', exact: true }).click();
  const fp = await p.getByTestId('pair-fingerprint').textContent();
  expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);

  const claim = page.getByTestId('pair-claim');
  await expect(claim).toContainText('Test phone');
  await claim.getByRole('button', { name: 'Confirm' }).click();
  await expect(p.getByRole('heading', { name: 'Start your team' })).toBeVisible();
  await expect(page.getByText('Test phone')).toBeVisible();
  await phone.close();
});

test('manifest is valid and installable', async ({ page, server }) => {
  const res = await page.request.get(`${server.url}/manifest.webmanifest`);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: 'PasaBot', start_url: '/', display: 'standalone' });
  const sizes = (m.icons as { sizes: string; type: string; src: string }[]).map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const i of m.icons as { src: string }[])
    expect((await page.request.get(`${server.url}${i.src}`)).ok()).toBe(true);
  await page.goto(server.url);
  // Chrome's own installability check (manifest + icons + service worker)
  const cdp = await page.context().newCDPSession(page);
  await expect
    .poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.length, {
      timeout: 15_000,
    })
    .toBe(0);
});

// app.md open question: a first-timer opened from the desktop app or from the printed setup link never sees or types
// the setup code; only someone who reaches an unclaimed server without it is asked, with one line on where to get it
test('setup code: never asked through the link or the app window, asked only without it', async ({
  page,
  server,
}) => {
  const token = new URL(server.setupLink.replace('/#/', '/')).searchParams.get('token')!;
  expect(token).toBeTruthy();
  const code = page.getByTestId('setup-code');

  // a stranger on the network reaching the bare address: the field and where to get the code
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: 'Claim your PasaBot' })).toBeVisible();
  await expect(code).toBeVisible();
  await expect(page.getByText("It's in the setup link PasaBot showed when it started")).toBeVisible();
  // and plainly how to get a new one (someone reaching a self-hosted server in a browser)
  await expect(page.getByText('For a new one, open the PasaBot app on that computer')).toContainText(
    '`pasabot setup-link`',
  );
  // without the code the server stays unclaimed
  await code.fill('not-the-code');
  await page.getByLabel('Your name').fill('Stranger');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByText('This setup code is used up or expired.')).toBeVisible();
  await expect(code).toHaveValue('');

  // the desktop window loads the setup link after the bare address (a hash change, no reload): the field goes away
  // and the code from the link is the one sent
  await page.evaluate((t) => {
    location.hash = `#/setup?token=${t}`;
  }, token);
  await expect(code).toHaveCount(0);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();

  // once claimed, the old link (signed out) is the sign-in page, never a claim page that cannot work
  await page.context().clearCookies();
  await page.goto('about:blank');
  await page.goto(server.setupLink);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

/**
 * The macOS app window installs one message handler (`pasabotSetup`); here a stand-in plays the window: on
 * "need-setup-link" it moves the page to a fresh link in place (`location.replace`, as the window does), or never
 * answers. It also records whether the code field was ever on the page.
 */
async function fakeDesktopWindow(page: Page, freshLink: string | null, saysNone = false) {
  await page.addInitScript(
    ({ fresh, none }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__asks = 0;
      w.__codeSeen = false;
      w.webkit = {
        messageHandlers: {
          pasabotSetup: {
            postMessage(m: unknown) {
              if (m !== 'need-setup-link') return;
              w.__asks = (w.__asks as number) + 1;
              if (fresh) setTimeout(() => location.replace(fresh), 50);
              // the window's answer when the launcher has no link (an owner exists, no server): one event, no data
              else if (none) setTimeout(() => window.dispatchEvent(new Event('pasabot:no-setup-link')), 50);
            },
          },
        },
      };
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="setup-code"]')) w.__codeSeen = true;
      }).observe(document, { childList: true, subtree: true });
    },
    { fresh: freshLink, none: saysNone },
  );
}

test('desktop app: a code that ran out while the window sat open is never asked for; a fresh link finishes the claim', async ({
  page,
  server,
}) => {
  await fakeDesktopWindow(page, server.setupLink);
  // the window opened hours ago on a link whose code has since run out (the server refuses it)
  await page.goto(`${server.url}/#/setup?token=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'Claim your PasaBot' })).toBeVisible();
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  // refused -> the page asks the window -> the fresh link comes in place -> the claim goes again on its own
  await expect(page.getByTestId('onb-brain')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codeSeen: boolean }).__codeSeen)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __asks: number }).__asks)).toBeGreaterThanOrEqual(
    1,
  );
  await expect(page.locator('body')).not.toContainText('This setup code is used up or expired');
  // what was typed before the link changed is what the owner got
  const me = await page.evaluate(() => fetch('/api/v1/me').then((r) => r.json()));
  expect(me.user?.displayName ?? me.displayName).toBe('Diwa');
});

test('desktop app: no code in the address (a reload of the bare address) -> a fresh link, never the field', async ({
  page,
  server,
}) => {
  await fakeDesktopWindow(page, server.setupLink);
  await page.goto(server.url);
  await expect(page).toHaveURL(/#\/setup\?token=/);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __codeSeen: boolean }).__codeSeen)).toBe(false);
});

test('desktop app: when no fresh link comes, a calm wait, then one plain line to reopen the app (never the field)', async ({
  page,
  server,
}) => {
  await page.clock.install();
  await fakeDesktopWindow(page, null);
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: 'Claim your PasaBot' })).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('setup-waiting')).toHaveText('Getting things ready…');
  await page.getByLabel('Your name').fill('Diwa');
  await page.clock.runFor(9000);
  await expect(page.getByTestId('setup-reopen')).toHaveText('Close and reopen PasaBot.');
  await expect(page.getByTestId('setup-waiting')).toHaveCount(0);
  await expect(page.getByLabel('Your name')).toHaveValue('Diwa');
  expect(await page.evaluate(() => (window as unknown as { __codeSeen: boolean }).__codeSeen)).toBe(false);
});

test('desktop app: when the window says no link will come, the reopen line shows at once, not after the wait', async ({
  page,
  server,
}) => {
  await page.clock.install();
  await fakeDesktopWindow(page, null, true);
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: 'Claim your PasaBot' })).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.getByTestId('setup-reopen')).toHaveText('Close and reopen PasaBot.');
  await expect(page.getByTestId('setup-waiting')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __codeSeen: boolean }).__codeSeen)).toBe(false);
});

test('a plain browser (no desktop window) still asks for the code when the link ran out', async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/#/setup?token=${'x'.repeat(43)}`);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByTestId('setup-code')).toBeVisible();
  await expect(page.getByText('This setup code is used up or expired.')).toBeVisible();
  await expect(page.getByTestId('setup-waiting')).toHaveCount(0);
});
