import { claimServer, expect, test } from './fixtures.js';

/**
 * Settings home > "This app": Quit PasaBot and Open at sign-in, drawn only when the desktop launcher offers them
 * (Windows and Linux). The e2e server has no launcher, so the offer is played here; the server side (owner only, the
 * parent channel) is apps/server/src/host/desktop-bridge.test.ts, the launcher side apps/desktop/src/launcher.test.ts.
 */
test('no launcher: nothing is drawn', async ({ page, server }) => {
  await claimServer(page, server);
  await page.goto(`${server.url}/#/settings`);
  await expect(page.getByTestId('settings-home')).toBeVisible();
  await expect(page.getByTestId('settings-app')).toHaveCount(0);
});

test('a launcher offers them: open at sign-in turns on, and Quit asks the launcher', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  let view = { quit: true, autostart: false, autostartAvailable: true };
  const asked: string[] = [];
  await page.route('**/api/v1/desktop', (r) => r.fulfill({ json: view }));
  await page.route('**/api/v1/desktop/autostart', async (r) => {
    const { on } = r.request().postDataJSON() as { on: boolean };
    asked.push(`autostart:${on}`);
    view = { ...view, autostart: on };
    await r.fulfill({ json: view });
  });
  await page.route('**/api/v1/desktop/quit', async (r) => {
    asked.push('quit');
    await r.fulfill({ json: { quitting: true } });
  });
  await page.goto(`${server.url}/#/settings`);
  const card = page.getByTestId('settings-app');
  await expect(card).toBeVisible();
  const signIn = card.getByRole('switch', { name: 'Open at sign-in' });
  await expect(signIn).toHaveAttribute('aria-checked', 'false');
  await signIn.click();
  await expect(signIn).toHaveAttribute('aria-checked', 'true');
  await card.getByRole('button', { name: 'Quit PasaBot' }).click();
  await expect(card.getByText('PasaBot is quitting. You can close this window.')).toBeVisible();
  expect(asked).toEqual(['autostart:true', 'quit']);
});
