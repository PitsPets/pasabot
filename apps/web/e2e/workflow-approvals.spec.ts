/**
 * W9 leftovers, proven at 1440 px and 390 px: a workflow's approval step is a core approval, so it shows in the
 * pinned decision bar above every screen and in the "needs you" count, and is approved right from the bar; and a
 * routine whose target is a workflow starts a run of it (Run now on the Routines page).
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

const node = (id: string, type: string, data: unknown) => ({ id, type, data, position: { x: 0, y: 0 } });

async function noOverflow(page: Page) {
  const o = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    tiny: [...document.querySelectorAll('main *')].filter((el) => {
      const s = getComputedStyle(el);
      return (
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
        Number.parseFloat(s.fontSize) < 12
      );
    }).length,
  }));
  expect(o.doc, 'horizontal overflow').toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
}

/** owner REST from the signed-in page (same-origin session cookie) */
const rest = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p as string, {
        method: m as string,
        credentials: 'same-origin',
        headers: b ? { 'content-type': 'application/json' } : {},
        ...(b ? { body: JSON.stringify(b) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body] as const,
  );

async function makeFlow(page: Page) {
  const wf = await rest(page, 'POST', '/api/m/workflows/workflows', {
    name: 'Pen order',
    graph: {
      nodes: [
        node('t', 'transform', { template: 'Order 12 pens' }),
        node('ok', 'approval', { message: 'Send the order?' }),
        node('o', 'output', { to: 'notification', title: 'Order sent', template: '{{input}} — done' }),
      ],
      edges: [
        { id: 'e1', source: 't', target: 'ok' },
        { id: 'e2', source: 'ok', target: 'o' },
      ],
    },
  });
  expect(wf.status).toBe(201);
  return wf.body.workflow.id as string;
}

for (const vp of [
  { name: 'desktop 1440', width: 1440, height: 900 },
  { name: 'phone 390', width: 390, height: 844 },
]) {
  test(`decision bar approves a workflow step (${vp.name})`, async ({ page, server }, info) => {
    test.skip(info.project.name !== 'desktop', 'the viewport is set by the test itself');
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    const id = await makeFlow(page);
    const run = await rest(page, 'POST', `/api/m/workflows/workflows/${id}/run`, {});
    expect(run.status).toBe(202);

    // the core approvals list has it, and the shell shows it pinned on any screen
    await expect
      .poll(async () => (await rest(page, 'GET', '/api/v1/approvals?state=pending')).body.approvals.length)
      .toBe(1);
    const bar = page.getByTestId('detached-decisions');
    await expect(bar).toBeVisible();
    await expect(bar.getByTestId('decision-bar')).toContainText('1 decision waiting');
    if (vp.width > 600)
      await expect(bar.getByTestId('decision-bar')).toContainText(
        'Workflow "Pen order" asks: Send the order?',
      );
    await expect(page.getByTestId('count-needs').first()).toContainText(/1 needs? you/);
    const approve = bar.getByRole('button', { name: 'Approve' });
    await expect(bar.getByRole('button', { name: 'Deny' })).toBeVisible();
    if (vp.width <= 600) expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`decision-bar-${vp.width}.png`) });

    await approve.click();
    await expect(bar).toHaveCount(0);
    await page.goto(`${server.url}/#/workflows`);
    const done = page.locator('[data-testid="workflow-run"][data-state="done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await done.getByRole('button', { name: 'Show steps' }).click();
    await expect(done).toContainText('Order 12 pens — done');
    await noOverflow(page);
  });

  test(`a routine that targets a workflow starts a run (${vp.name})`, async ({ page, server }, info) => {
    test.skip(info.project.name !== 'desktop', 'the viewport is set by the test itself');
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    const wf = await rest(page, 'POST', '/api/m/workflows/workflows', {
      name: 'Morning digest',
      graph: {
        nodes: [
          node('t', 'transform', { template: 'digest of: {{input}}' }),
          node('o', 'output', { to: 'notification', title: 'Digest', template: '{{input}}' }),
        ],
        edges: [{ id: 'e1', source: 't', target: 'o' }],
      },
    });
    expect(wf.status).toBe(201);

    await page.goto(`${server.url}/#/routines`);
    await page.getByLabel('Name', { exact: true }).fill('Kick the digest');
    await page.getByLabel('What should the helper do?').fill('Summarise the inbox');
    await page.getByRole('combobox', { name: 'Runs', exact: true }).selectOption('manual');
    await page.getByRole('combobox', { name: 'Where it runs' }).selectOption('workflow');
    await expect(page.getByRole('combobox', { name: 'Workflow', exact: true })).toHaveValue(
      wf.body.workflow.id,
    );
    await noOverflow(page);
    await page.getByRole('button', { name: 'Create routine' }).click();
    const card = page.getByRole('article').filter({ hasText: 'Kick the digest' });
    await expect(card).toContainText('Starts a workflow');
    await card.getByRole('button', { name: 'Run now' }).click();
    await expect(card).toContainText('Done', { timeout: 15_000 });
    await page.screenshot({ path: info.outputPath(`routine-workflow-${vp.width}.png`) });

    await page.goto(`${server.url}/#/workflows`);
    const done = page.locator('[data-testid="workflow-run"][data-state="done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await done.getByRole('button', { name: 'Show steps' }).click();
    await expect(done).toContainText('digest of: Summarise the inbox');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`routine-run-${vp.width}.png`) });
  });
}
