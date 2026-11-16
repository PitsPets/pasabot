/**
 * Devices with an old session (the server restarted, so the session's last re-auth is gone): "Pair a phone",
 * "Confirm" and "Add a passkey" each get 401 `reauth_required`. Each shows the re-auth sheet ("Confirm it's you"),
 * and after the password the same action runs again and goes through; closing the sheet says it was not done.
 * Nothing fails silently.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { boot, claimServer, expect, PASSWORD, stop, test } from './fixtures.js';

type Booted = Awaited<ReturnType<typeof boot>>;
const stopBooted = async (b: Booted | undefined) => {
  if (b) await stop(b.child);
};
const confirmItsYou = async (page: Page) => {
  const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(sheet).toBeHidden();
};

test('an old session: Pair a phone, Confirm and Add a passkey ask to confirm it is you, then go through', async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name === 'phone', 'one width is enough for the re-auth round trips');
  test.setTimeout(120_000);
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
  const home = mkdtempSync(join(tmpdir(), 'pasabot-e2e-reauth-'));
  let cur: Booted | undefined = await boot({ PASABOT_E2E_HOME: home });
  /** restart on the same home: the session (cookie, database) survives, its re-auth does not */
  const restart = async () => {
    await stopBooted(cur);
    cur = await boot({ PASABOT_E2E_HOME: home });
    await page.goto(`${cur.server.localUrl}/#/devices`);
    await expect(page.getByRole('heading', { name: 'Devices & sign-in' })).toBeVisible();
    return cur.server;
  };
  try {
    // a fresh session makes a pairing code (stored, so it outlives the restart)
    await claimServer(page, cur.server, cur.server.localUrl);
    await page.goto(`${cur.server.localUrl}/#/devices`);
    await page.getByRole('button', { name: 'Pair a phone' }).click();
    const link = new URL((await page.getByTestId('pair-code').getAttribute('data-link'))!);

    // 1) Confirm on an old session: the phone claims the code, the owner confirms through the re-auth sheet
    let s = await restart();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await phone.newPage();
    await p.goto(`${s.localUrl}/${link.hash}`);
    await p.getByLabel('Name for this device').fill('Test phone');
    await p.getByRole('button', { name: 'Pair', exact: true }).click();
    const claim = page.getByTestId('pair-claim');
    await expect(claim).toContainText('Test phone');
    await claim.getByRole('button', { name: 'Confirm' }).click();
    await confirmItsYou(page);
    await expect(p.getByRole('heading', { name: 'Start your team' })).toBeVisible();
    await expect(page.getByText('Test phone')).toBeVisible();
    await phone.close();

    // 2) Pair a phone on an old session: closing the sheet says it was not done; confirming shows the QR
    s = await restart();
    await page.getByRole('button', { name: 'Pair a phone' }).click();
    const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('pair-status')).toHaveText(
      'Not done: this needs your password or passkey again.',
    );
    await expect(page.getByTestId('pair-qr')).toHaveCount(0);
    await page.getByRole('button', { name: 'Pair a phone' }).click();
    await confirmItsYou(page);
    await expect(page.getByTestId('pair-qr')).toBeVisible();
    await expect(page.getByTestId('pair-status')).toHaveCount(0);

    // 3) Add a passkey on an old session
    s = await restart();
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await confirmItsYou(page);
    await expect(page.getByText('Passkey added.')).toBeVisible();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
    expect(s.localUrl).toContain('localhost');
  } finally {
    await stopBooted(cur);
    rmSync(home, { recursive: true, force: true });
  }
});
