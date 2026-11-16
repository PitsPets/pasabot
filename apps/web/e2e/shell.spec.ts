/**
 * Simplify shell at 1200 and 390 px, in English and Arabic: the main screen shows only the chats (no feature list),
 * every feature is in Settings (12 groups with icons, searchable), a feature pinned to the sidebar stays pinned
 * after a reload (kept on the server), the owner can hide an optional feature ("Not using this") and show it again
 * from Advanced, old routes open inside Settings, the chat's details are closed until asked for, and the language
 * lives in the account menu. Nothing scrolls sideways.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, expectAllSettingsGroups, test } from './fixtures.js';

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`).first();

for (const lng of ['en', 'ar'] as const)
  test(`simplified shell (${lng}): chats only, Settings home, pins, hide, menus`, async ({
    page,
    server,
  }, info) => {
    const phone = info.project.name === 'phone';
    test.setTimeout(120_000);
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1200, height: 860 });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    const chatUrl = page.url();
    const at = (hash: string) => page.goto(chatUrl.replace(/#.*$/, `#${hash}`));

    // the language moved into the account menu
    if (phone) await at('/');
    await visible(page, 'account-menu').click();
    await visible(page, 'account-language').click();
    if (lng === 'ar') {
      await page.locator('[role="menuitemradio"][lang="ar"]:visible').click();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    } else {
      await expect(page.locator('[role="menuitemradio"][lang="en"]:visible')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await page.keyboard.press('Escape');
    }

    // the chat: details closed by default; More opens them
    await page.goto(chatUrl);
    await expect(page.getByTestId('composer')).toBeVisible();
    await expect(page.locator('aside.det')).toHaveCount(0);
    await visible(page, phone ? 'phone-chat-more-btn' : 'chat-more-btn').click();
    // "Edit Tala" comes first, then the details; a phone menu also ends with Settings
    const items = page.locator('[role="menuitem"]:visible');
    await expect(items.first()).toHaveAccessibleName(/Tala/);
    if (phone) await expect(items.last()).toHaveAttribute('data-testid', 'more-settings');
    await page.getByTestId('more-details').click();
    await expect(page.locator('aside.det')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await page.locator('aside.det .hero button').click();
    await expect(page.locator('aside.det')).toHaveCount(0);

    // the main screen lists chats and Settings, never the old feature list
    if (phone) await at('/');
    const list = visible(page, 'chats-list');
    await expect(list.getByTestId('roster-agent')).toHaveCount(1);
    await expect(list.getByTestId('nav-settings')).toBeVisible();
    await expect(list.getByTestId('pinned')).toHaveCount(0);
    for (const old of ['/routines', '/memory', '/skills', '/budget'])
      await expect(list.locator(`a[href="#${old}"]`)).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);

    // Settings: the groups, each with its icon; a search finds a feature
    await list.getByTestId('nav-settings').click();
    const home = page.getByTestId('settings-home');
    await expect(home).toBeVisible();
    // one search field on screen at any width (the sidebar's, or the page's on a phone)
    await expect(page.locator('[data-testid="settings-search"]:visible')).toHaveCount(1);
    // every group from the start, in three sections (polish B): the home lists them at every width
    const groups = visible(page, 'settings-home-groups').locator('.bk-row');
    await expect(page.getByTestId('settings-advanced')).toHaveAttribute('aria-checked', 'false');
    await expectAllSettingsGroups(visible(page, 'settings-home-groups'));
    await expect(visible(page, 'settings-home-groups').locator('.set-sec')).toHaveCount(3);
    await expect(visible(page, 'settings-home-groups').getByTestId('settings-group-safety')).toBeVisible();
    await expect(visible(page, 'settings-home-groups').getByTestId('settings-group-tools')).toBeVisible();
    // "Technical words" only changes wording: the same groups with it on, kept after a reload (a per-person
    // setting kept by the server)
    const all = await groups.count();
    await page.getByTestId('settings-advanced').click();
    await expect(page.getByTestId('settings-advanced')).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.getByTestId('settings-advanced')).toHaveAttribute('aria-checked', 'true');
    await expect(groups).toHaveCount(all);
    for (let i = 0; i < (await groups.count()); i++)
      await expect(groups.nth(i).locator('svg.bk-icon').first()).toBeAttached();
    // search by the feature's name in this language
    await at('/settings/automations');
    const routines = (await page.getByTestId('feature-routines').locator('.bk-row__label').textContent())!;
    await at('/settings');
    await visible(page, 'settings-search').fill(routines.slice(0, 4));
    await expect(page.getByTestId('settings-hit-routines')).toBeVisible();
    await expect(page.locator('[data-testid="settings-search"]:visible')).toHaveCount(1);
    // ...or by its keywords in this language, every word anywhere (Routines: schedule, timer, every day)
    await visible(page, 'settings-search').fill(lng === 'en' ? 'timer daily' : 'مؤقت يومي');
    await expect(page.getByTestId('settings-hit-routines')).toBeVisible();
    await visible(page, 'settings-search').fill('zzzz');
    await expect(page.getByTestId('settings-results').getByRole('status')).toContainText('zzzz');
    expect(await noSideScroll(page)).toBe(true);

    // pin Routines; it shows in the sidebar (the home list on a phone) and stays after a reload
    await at('/settings/automations');
    const pin = page.getByTestId('pin-routines');
    await expect(pin).toHaveAttribute('aria-checked', 'false');
    await pin.click();
    await expect(pin).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.getByTestId('pin-routines')).toHaveAttribute('aria-checked', 'true');
    await at(phone ? '/' : chatUrl.replace(/^.*#/, ''));
    const pinned = visible(page, 'pinned-routines');
    await expect(pinned).toBeVisible();
    await expect(pinned.locator('svg[data-icon="clock"]')).toBeAttached();
    // an old route opens inside Settings with its group selected
    await pinned.locator('a.room').click();
    await expect(page.locator('.set-crumbs')).toBeVisible();
    await expect(page.locator('.set-crumb-here svg[data-icon="clock"]')).toBeAttached();
    // unpin from the pinned row's menu
    await at(phone ? '/' : chatUrl.replace(/^.*#/, ''));
    await visible(page, 'pinned-routines').locator('.pin-more').click();
    await page.locator('[role="menuitem"]:visible').last().click();
    await expect(page.locator('[data-testid="pinned-routines"]:visible')).toHaveCount(0);

    // the hide dialog says what is still on and will keep running (one routine here)
    const made = await page.evaluate(async () => {
      const a = (await (await fetch('/api/v1/agents')).json()) as { agents: { id: string }[] };
      const r = await fetch('/api/m/routines/routines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: a.agents[0]!.id,
          name: 'Morning check',
          prompt: 'Check the inbox.',
          trigger: { kind: 'schedule', spec: { cron: '0 9 * * *', tz: 'UTC' } },
        }),
      });
      return r.status;
    });
    expect(made).toBe(201);
    await at('/routines');
    await page.getByTestId('hide-feature').click();
    await expect(page.getByTestId('hide-running')).toBeVisible();
    await expect(page.getByTestId('hide-running')).toContainText(
      lng === 'en' ? '1 routine is still on' : 'روتين واحد',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('hide-running')).toBeHidden();

    // "Not using this": the owner hides Shopping for everyone, then brings it back from Advanced
    await at('/settings/shopping/shop');
    await page.getByTestId('hide-feature').click();
    await page.getByTestId('hide-confirm').click();
    await at('/settings/shopping');
    await expect(page.getByTestId('feature-shop')).toHaveCount(0);
    await at('/settings/advanced/hidden-features');
    await page.getByTestId('show-shop').click();
    await at('/settings/shopping');
    await expect(page.getByTestId('feature-shop')).toBeVisible();

    // the old menu page is now Settings
    await at('/menu');
    await expect(page).toHaveURL(/#\/settings$/);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`shell-${lng}.png`), fullPage: true });
  });
