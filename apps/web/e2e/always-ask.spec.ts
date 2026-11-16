/**
 * 7.1 "Always asks" in the browser, at 1440 and 390 px: a `trusted` agent (no asking for tier 2) still asks before
 * an outside MCP tool the owner classed as a message to other people, and before one classed as money; each card
 * shows exactly what the call would do (recipients, channel, subject, full text; merchant, total, masked card, and
 * "not stated" for what the call did not say), the pinned decision bar carries it, money needs the password
 * re-auth, a denial reaches the agent as a refusal, and Settings shows the read-only "Always asks" section.
 */
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, PASSWORD, send, test } from './fixtures.js';

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
  test(`always asks at ${vp.name}: money and messages ask a trusted agent, with the real arguments`, async ({
    page,
    server,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'one run per viewport is enough; the viewport is set here');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala'); // trusted: tier 2 would run without asking
    const chat = page.url();

    // an outside MCP server every agent may use; the owner classes two of its tools
    await owner(page, 'POST', '/api/m/mcp/servers', {
      name: 'Echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO],
      env: { ECHO_EXTRA: '1' },
      enabled: true,
    });
    await owner(page, 'POST', '/api/m/mcp/servers/echo/test');
    await owner(page, 'PUT', '/api/m/mcp/servers/echo/levels', { levels: [{ role: 'all', level: 'use' }] });
    await owner(page, 'PUT', '/api/m/mcp/servers/echo/classes', {
      tools: { echo_text: 'outbound-message', add_numbers: 'money' },
    });
    // the MCP page shows the owner's classes per tool
    await page.goto(`${server.url}/#/mcp`);
    const echo = page.locator('[data-mcp-classes="echo"]');
    await expect(echo.locator('[data-mcp-class="echo_text"]')).toHaveValue('outbound-message');
    await expect(echo.getByText('Always asks').first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mcp-classes-${vp.name}.png`), fullPage: true });
    await layoutOk(page, 'mcp-page');

    // 1) a message to someone else: asks even at trusted; the card shows the call's own arguments
    await page.goto(chat);
    await send(
      page,
      probe('tools_invoke', {
        tool: 'echo/send_message',
        arguments: { text: 'See you at 6. Bring the keys.', to: 'ana@example.test' },
      }),
    );
    const card = page.getByTestId('approval-card').last();
    await expect(card).toContainText('Message to other people: always asks');
    const facts = card.getByTestId('approval-facts');
    await expect(facts).toContainText('ana@example.test');
    await expect(facts).toContainText('Echo');
    await expect(facts).toContainText('See you at 6. Bring the keys.');
    await expect(facts).toContainText('not stated'); // no subject in the call
    // Advanced off (the default): plain facts only, no tool name, no exact-request JSON, no path to what it runs
    for (const tech of ['Tool', 'tools_invoke', 'Exact request', 'echo-mcp', 'node'])
      await expect(card).not.toContainText(tech);
    await expect(page.locator('[data-testid="detached-decisions"]')).toContainText('1 decision waiting');
    // one decision, one bar: the chat's own bar does not repeat what the pinned bar shows
    await expect(page.getByTestId('decision-bar')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`message-card-${vp.name}.png`), fullPage: true });
    await layoutOk(page, 'approval-card');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card.getByTestId('approval-state')).toHaveText('Approved');
    await expect(page.getByTestId('msg-agent').filter({ hasText: 'SEE YOU AT 6' })).toHaveCount(1);

    // 2) money: the card names merchant, total and a masked card; approving needs the password again
    await send(
      page,
      probe('tools_invoke', {
        tool: 'echo/pay_order',
        arguments: {
          merchant: 'Tindahan ni Aling Nena',
          amount: '250.00',
          currency: 'PHP',
          card: '4242 4242 4242 4242',
        },
      }),
    );
    const money = page.getByTestId('approval-card').last();
    await expect(money).toContainText('Money: always asks');
    await expect(money.getByTestId('approval-facts')).toContainText('Tindahan ni Aling Nena');
    await expect(money.getByTestId('approval-facts')).toContainText('250.00 PHP');
    await expect(money.getByTestId('approval-facts')).toContainText('•••• 4242');
    await expect(money).not.toContainText('4242 4242');
    for (const tech of ['Tool', 'tools_invoke', 'Exact request']) await expect(money).not.toContainText(tech);
    // the pinned bar opens the same card in a sheet
    await page.locator('[data-testid="detached-decisions"]').getByRole('button', { name: 'Review' }).click();
    const sheet = page.getByRole('dialog', { name: 'Review' });
    await expect(sheet.getByTestId('approval-facts')).toContainText('•••• 4242');
    await page.screenshot({ path: info.outputPath(`money-sheet-${vp.name}.png`), fullPage: true });
    await sheet.getByRole('button', { name: 'Approve' }).click();
    const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
    await expect(reauth).toBeVisible();
    // a real password input (the Screen Helper never types into secure input, so it cannot fake this re-auth)
    await expect(reauth.getByLabel('Password')).toHaveAttribute('type', 'password');
    await expect(reauth.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
    await reauth.getByLabel('Password').fill(PASSWORD);
    await reauth.getByRole('button', { name: 'Confirm and approve' }).click();
    await expect(money.getByTestId('approval-state')).toHaveText('Approved');
    await expect(
      page.getByTestId('msg-agent').filter({ hasText: 'paid Tindahan ni Aling Nena' }),
    ).toHaveCount(1);

    // 3) deny: the agent is told it was refused
    await page.keyboard.press('Escape').catch(() => {});
    await send(
      page,
      probe('tools_invoke', {
        tool: 'echo/send_message',
        arguments: { text: 'second', to: 'bo@example.test' },
      }),
    );
    const third = page.getByTestId('approval-card').last();
    await expect(third.getByTestId('approval-facts')).toContainText('bo@example.test');
    await third.getByRole('button', { name: 'Deny' }).click();
    await expect(third.getByTestId('approval-state')).toHaveText('Denied');
    await expect(
      page.getByTestId('msg-agent').filter({ hasText: 'did not approve this outbound-message' }),
    ).toHaveCount(1);

    // Advanced on: the technical block is back (the tool, the exact request and what the server runs)
    await page.goto(`${server.url}/#/settings`);
    await page.getByTestId('settings-advanced').click();
    await expect(page.getByTestId('settings-advanced')).toHaveAttribute('aria-checked', 'true');
    await page.goto(chat);
    const advCard = page.getByTestId('approval-card').filter({ hasText: 'bo@example.test' });
    await expect(advCard).toContainText('Exact request');
    await expect(advCard).toContainText('tools_invoke');
    await expect(advCard).toContainText('echo-mcp');
    await page.goto(`${server.url}/#/settings`);
    await page.getByTestId('settings-advanced').click();
    await expect(page.getByTestId('settings-advanced')).toHaveAttribute('aria-checked', 'false');

    // Settings: the read-only "Always asks" section
    await page.goto(`${server.url}/#/settings/safety/always-asks`);
    const section = page.getByTestId('always-asks');
    await expect(section).toContainText('Always asks');
    await expect(section.locator('[data-ask-class="money"]')).toContainText('Always on');
    await expect(section.locator('[data-ask-class="outbound-message"]')).toContainText('Always on');
    await expect(section.locator('[data-ask-class="delete"]')).toContainText('Always on');
    await section.locator('[data-ask-extra="publish"]').check();
    await expect(section.locator('[data-ask-extra="publish"]')).toBeChecked();
    // the known limit, said plainly (owner decision 2026-11-14); with Advanced off it reads the glossary words
    await expect(section.getByTestId('always-asks-limit')).toContainText(
      'A helper that may run commands on your computer can do anything those commands can. These cards cover what PasaBot can see',
    );
    await expect(section.getByTestId('always-asks-limit')).toContainText(
      'turn on "Ask before computer commands and direct web requests"',
    );
    await page.screenshot({ path: info.outputPath(`settings-${vp.name}.png`), fullPage: true });
    await layoutOk(page, 'always-asks');
  });
}
