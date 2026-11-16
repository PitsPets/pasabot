/**
 * W38 in the browser, at 1440 and 390 px: a delete outside the agent's own workspace is the third fixed always-ask
 * class. A `trusted` agent calling an outside tool its server marks destructive gets a delete card with its facts
 * (what, where, how many, "not stated" when the call does not say, and the exact request), 44 px buttons on a phone,
 * approve runs it once, deny reaches the agent as a refusal, and Settings → "Always asks" lists the three fixed
 * classes.
 */
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

const ECHO = fileURLToPath(new URL('../../../modules/mcp/src/__fixtures__/echo-mcp.mjs', import.meta.url));
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });

async function owner<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        credentials: 'same-origin',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
      return r.json();
    },
    { method, path, body },
  ) as Promise<T>;
}

async function layoutOk(page: Page, testId: string) {
  const o = await page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`) ?? document.body;
    const phone = window.innerWidth <= 600;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return (
          [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
          s.display !== 'none' &&
          Number.parseFloat(s.fontSize) < 12
        );
      }).length,
      smallTaps: phone
        ? [...root.querySelectorAll('button, select, input, a')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height < 44)
            .map(({ el, r }) => `${el.tagName}:${el.textContent?.slice(0, 20)}:${Math.round(r.height)}`)
        : [],
    };
  }, testId);
  expect(o.doc, `horizontal overflow at ${o.vw}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  expect(o.smallTaps, 'tap targets under 44px').toEqual([]);
}

for (const vp of [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]) {
  test(`delete approvals at ${vp.name}: a destructive outside tool asks a trusted agent with a delete card`, async ({
    page,
    server,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'one run per viewport is enough; the viewport is set here');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala'); // trusted: tier 2 would run without asking
    const chat = page.url();

    // an outside MCP server whose `archive_box` tool is marked destructive by the server itself
    await owner(page, 'POST', '/api/m/mcp/servers', {
      name: 'Boxes',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO],
      env: { ECHO_DESTRUCTIVE: '1' },
      enabled: true,
    });
    await owner(page, 'POST', '/api/m/mcp/servers/boxes/test');
    await owner(page, 'PUT', '/api/m/mcp/servers/boxes/levels', { levels: [{ role: 'all', level: 'use' }] });
    await page.goto(`${server.url}/#/mcp`);
    await expect(page.locator('[data-mcp-classes="boxes"] [data-mcp-class="archive_box"]')).toBeVisible();

    // 1) approve: the delete card names where (the server) and shows "not stated" for what the call does not give
    await page.goto(chat);
    await send(
      page,
      probe('tools_invoke', { tool: 'boxes/archive_box', arguments: { box: 'winter-coats' } }),
    );
    const card = page.getByTestId('approval-card').last();
    await expect(card).toContainText('Deleting: always asks');
    const facts = card.getByTestId('approval-facts');
    await expect(facts).toContainText('Where');
    await expect(facts).toContainText('outside tool: Boxes (boxes');
    await expect(facts).toContainText('How many');
    await expect(facts).toContainText('not stated');
    // the summary could not read what is archived: the call's own arguments say it, in plain lines (Advanced off:
    // no exact-request JSON, no tool name, no path to what the server runs)
    await expect(facts).toContainText('Request details');
    await expect(facts).toContainText('box: winter-coats');
    for (const tech of ['Exact request', 'tools_invoke', 'echo-mcp'])
      await expect(card).not.toContainText(tech);
    await expect(card).toContainText('Only you can approve it here in the app.');
    await page.screenshot({ path: info.outputPath(`delete-card-${vp.name}.png`), fullPage: true });
    await layoutOk(page, 'approval-card');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card.getByTestId('approval-state')).toHaveText('Approved');
    await expect(page.getByTestId('msg-agent').filter({ hasText: 'archived winter-coats' })).toHaveCount(1);

    // 2) deny: the agent is told it was refused, and nothing ran
    await send(page, probe('tools_invoke', { tool: 'boxes/archive_box', arguments: { box: 'photos' } }));
    const second = page.getByTestId('approval-card').last();
    await expect(second.getByTestId('approval-facts')).toContainText('photos');
    await second.getByRole('button', { name: 'Deny' }).click();
    await expect(second.getByTestId('approval-state')).toHaveText('Denied');
    await expect(
      page.getByTestId('msg-agent').filter({ hasText: 'did not approve this delete action' }),
    ).toHaveCount(1);
    await expect(page.getByTestId('msg-agent').filter({ hasText: 'archived photos' })).toHaveCount(0);

    // Settings: the three fixed classes, read-only
    await page.goto(`${server.url}/#/settings/safety/always-asks`);
    const section = page.getByTestId('always-asks');
    for (const c of ['money', 'outbound-message', 'delete'])
      await expect(section.locator(`[data-ask-class="${c}"]`)).toContainText('Always on');
    await expect(section.locator('[data-ask-class="delete"]')).toContainText(
      "Deleting outside the helper's own workspace",
    );
    await expect(section.locator('[data-ask-extra="delete"]')).toHaveCount(0);
    await expect(section.locator('[data-ask-extra="publish"]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`settings-${vp.name}.png`), fullPage: true });
    await layoutOk(page, 'always-asks');
  });
}
