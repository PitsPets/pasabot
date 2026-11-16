/**
 * W4b: Settings → Channels with the reference FakeChannel. Add a binding (write-only token), link the owner by
 * code, an inbound message gets the agent's reply out, a stranger is dropped and counted, a restart in the
 * middle of the conversation sends nothing twice, and the screen has no horizontal overflow at 1440 and 390 px.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, test } from '@playwright/test';
import { boot, claimServer, createFakeAgent, type E2EServer, expect, stop } from './fixtures.js';

const ctl = async <T>(server: E2EServer, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${server.channelControl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  if (!r.ok) throw new Error(`control ${path}: ${r.status}`);
  return (await r.json()) as T;
};
const botTexts = (server: E2EServer, place = 'dm') => ctl<string[]>(server, `/bot?place=${place}`);

async function noOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await expect(page.getByTestId('channels-settings')).toBeVisible();
  const o = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    tiny: [...document.querySelectorAll('[data-testid="channels-settings"] *')].filter((el) => {
      const s = getComputedStyle(el);
      return el.childNodes.length > 0 && el.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
    }).length,
  }));
  expect(o.doc, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
}

test('channels: add binding, link owner, reply goes out, stranger dropped, restart without duplicates', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one run covers both viewports');
  test.setTimeout(120_000);
  const home = mkdtempSync(join(tmpdir(), 'pasabot-e2e-ch-'));
  let { server, child } = await boot({ PASABOT_E2E_HOME: home });
  try {
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/settings/people/channels`);
    const section = page.getByTestId('channels-settings');
    // Technical words off (the default): plain words ("Chat apps", "Secret code from the app", "kept safe")
    await expect(section.getByRole('heading', { name: 'Chat apps' })).toBeVisible();
    await expect(section.getByText('No chat apps yet.')).toBeVisible();

    // add a binding: the token field is a password field and is never shown again
    await section.getByRole('button', { name: 'Add a chat app' }).click();
    const form = page.getByTestId('channel-add-form');
    // the chat apps are tiles to tap, each with its own mark
    await form.getByTestId('channel-kind-fake').click();
    await expect(form.getByRole('radio', { name: 'Test channel' })).toBeChecked();
    await form.getByLabel('Helper that answers').selectOption({ label: 'Tala' });
    await expect(form.getByLabel('Secret code from the app')).toHaveAttribute('type', 'password');
    await form.getByLabel('Secret code from the app').fill('fake-token');
    await form.getByRole('button', { name: 'Add this chat app' }).click();
    const card = page.getByTestId('channel-binding');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('channel-status')).toHaveText('Connected', { timeout: 15_000 });
    await expect(card.getByText('Kept safe on this computer')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('fake-token');

    // link the owner's account with the one-time code, sent in a DM
    await card.getByRole('button', { name: 'Link my account' }).click();
    const command = (await card.getByTestId('channel-link-code').textContent())!;
    expect(command).toMatch(/^\/link [0-9A-Z]{5}-[0-9A-Z]{5}$/);
    await ctl(server, '/deliver', { from: 'owner', place: 'dm', text: command });
    await expect.poll(() => botTexts(server)).toContainEqual(expect.stringMatching(/^Linked\./));
    await expect(card.getByTestId('channel-owner')).toContainText('Dee', { timeout: 10_000 });

    // inbound -> agent reply goes out to the platform
    await ctl(server, '/deliver', { from: 'owner', place: 'dm', text: 'hello from the phone' });
    await expect
      .poll(async () => (await botTexts(server)).join(''), { timeout: 20_000 })
      .toContain('hello from the phone');
    await expect.poll(async () => (await botTexts(server)).join('')).not.toContain('…');

    // a stranger is dropped (no reply, no chat) and counted
    await ctl(server, '/deliver', { from: 'stranger', place: 'strangerDm', text: 'let me in' });
    await expect(card).toContainText('1 message from strangers dropped', { timeout: 10_000 });
    expect(await botTexts(server, 'strangerDm')).toEqual([]);

    // the place's chat shows the conversation
    await card.getByRole('link', { name: 'Open chat' }).click();
    await expect(page.getByText('hello from the phone').first()).toBeVisible();
    await page.goto(`${server.url}/#/settings/people/channels`);

    await noOverflow(page, 1440);
    await noOverflow(page, 390);
    await page.setViewportSize({ width: 1280, height: 800 });

    // restart in the middle of the conversation: the platform redelivers the answered message
    const seen = await ctl<{ text: string }[]>(server, '/seen');
    const answered = seen.find((m) => m.text === 'hello from the phone')!;
    await stop(child);
    ({ server, child } = await boot({ PASABOT_E2E_HOME: home }));
    await ctl(server, '/inject', answered);
    await ctl(server, '/deliver', { from: 'owner', place: 'dm', text: 'second after restart' });
    await expect
      .poll(async () => (await botTexts(server)).join(''), { timeout: 20_000 })
      .toContain('second after restart');
    await page.waitForTimeout(1000);
    const after = (await botTexts(server)).join('');
    expect(after).not.toContain('hello from the phone');
    expect(after.split('second after restart').length - 1).toBe(1);

    // the settings screen still shows the binding connected on the new process
    await page.goto(`${server.url}/#/settings/people/channels`);
    await expect(page.getByTestId('channel-status')).toHaveText('Connected', { timeout: 15_000 });
  } finally {
    await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});
