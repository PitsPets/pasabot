/**
 * W14: Settings → Vault at 1440 and 390 px. A Fake agent asks for a key through its tool, the owner fills it from
 * the request card (write-only field), the agent is granted the reference, a pasted value is shown only as
 * `[secret:NAME]`, the owner rotates the vault key, and the panel has no horizontal scroll, no text under 12 px
 * and 44 px tap targets.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
// built at runtime so secret scanners do not flag the fixture value
const VALUE = ['wx', 'e2e', 'fixture', '5521'].join('-');

async function panelChecks(page: Page, phone: boolean) {
  const o = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="vault"]')!;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return el.childNodes.length > 0 && el.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
      }).length,
      small: [...root.querySelectorAll('button, select, input')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height < 44).length,
    };
  });
  expect(o.doc, 'horizontal overflow').toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  // 44 px tap targets are the phone rule; desktop inputs may be denser
  if (phone) expect(o.small, 'tap targets under 44px').toBe(0);
}

test('vault: agent asks for a key, owner fills it, reference granted, value redacted, key rotated', async ({
  page,
  server,
}, info) => {
  test.setTimeout(90_000);
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();

  // the agent asks through its tool; nothing is granted yet
  await send(page, probe('vault_request_secret', { name: 'WEATHER_KEY', reason: 'to read the forecast' }));
  await expect(page.getByTestId('chat-log').getByText(/tool said: .*"state":"pending"/)).toBeVisible();

  await page.goto(chatUrl.replace(/#.*$/, '#/settings/safety/vault'));
  const vault = page.getByTestId('vault');
  // with Technical words off (the default) the vault says its plain name
  await expect(vault.getByRole('heading', { name: 'Saved secrets', exact: true }).first()).toBeVisible();
  // helpers, never "agents", ask for a key (QA r7)
  await expect(vault.getByRole('heading', { name: 'Helpers asking for a key', exact: true })).toBeVisible();
  await expect(vault).not.toContainText(/\bagents?\b/i);
  const card = vault.getByTestId('vault-request');
  await expect(card).toContainText('Tala asks for WEATHER_KEY');
  await expect(card).toContainText('to read the forecast');
  await expect(card.getByLabel('Value', { exact: true })).toHaveAttribute('type', 'password');
  await panelChecks(page, info.project.name === 'phone');
  await card.getByLabel('Value', { exact: true }).fill(VALUE);
  await card.getByRole('button', { name: 'Give the key' }).click();
  await expect(vault.getByRole('status')).toHaveText('Tala can now use {{secret:WEATHER_KEY}}.');
  const listed = vault.getByTestId('vault-secret').filter({ hasText: 'WEATHER_KEY' });
  await expect(listed).toContainText('For Tala · {{secret:WEATHER_KEY}}');
  await expect(page.locator('body')).not.toContainText(VALUE);

  // the only key rotation: asks once, then re-encrypts every secret
  await vault.getByRole('button', { name: 'Rotate key' }).click();
  await expect(vault.getByText('Re-encrypt every secret with a new key now?')).toBeVisible();
  await panelChecks(page, info.project.name === 'phone');
  await vault.getByRole('button', { name: 'Rotate now' }).click();
  await expect(vault.getByRole('status')).toHaveText(/Re-encrypted \d+ secrets with a new key\./);
  await expect(vault.getByText(/Last rotated/)).toBeVisible();

  // back in the chat: the agent sees the reference, and a pasted value is never shown
  await page.goto(chatUrl);
  await send(page, probe('vault_list_secrets', {}));
  await expect(
    page.getByTestId('chat-log').getByText(/tool said: .*\{\{secret:WEATHER_KEY\}\}/),
  ).toBeVisible();
  await send(page, `the key is ${VALUE}`);
  await expect(page.getByTestId('chat-log').getByText('echo: the key is [secret:WEATHER_KEY]')).toBeVisible();
  // the chats list (beside the chat, wider than a phone) previews the last message once the agent is free,
  // redacted like the chat itself
  if (test.info().project.name !== 'phone')
    await expect(page.getByTestId('chat-preview')).toHaveText('echo: the key is [secret:WEATHER_KEY]');
  await expect(page.locator('body')).not.toContainText(VALUE);
});

test('vault: a password manager whose CLI the server user could swap shows as turned off', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  // the e2e server's own CLIs depend on the machine, so its overview is marked the way a server that refused a
  // user-writable `bw` at boot answers it (the refusal itself is proven in modules/vault's unit tests)
  await page.route('**/api/m/vault/overview', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { backends: { id: string; disabled?: string | null }[] };
    for (const b of body.backends) b.disabled = b.id === 'bitwarden' ? 'unsafe_bin' : null;
    await route.fulfill({ response: res, json: body });
  });
  await claimServer(page, server);
  await page.goto(page.url().replace(/#.*$/, '#/settings/safety/vault'));
  const vault = page.getByTestId('vault');
  const bw = vault.getByTestId('vault-backend-bitwarden');
  await expect(bw).toContainText('Turned off (unsafe tool location)');
  await expect(bw.getByRole('note')).toContainText("this server's user can change the tool's file");
  await expect(vault.getByTestId('vault-backend-1password')).not.toContainText('Turned off');
  await panelChecks(page, info.project.name === 'phone');
});
