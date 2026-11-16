/**
 * Layout audit: walks every screen a browser can reach on the e2e server and, at each width and language, checks
 * geometry rather than pixels:
 *   - no visible element's box sticks out of its nearest card / panel / dialog, nor out of the viewport sideways
 *     (1 px tolerance; parts clipped by a scrolling or overflow-hidden region and off-screen / hidden elements are
 *     ignored, since nobody sees them);
 *   - no two interactive elements (buttons, inputs, selects, links, pills) overlap;
 *   - no text is clipped by its own box unless it says so with an ellipsis or a line clamp;
 *   - no sideways page scroll.
 * Every violation is listed with screen, width, locale and selector, and the screen is saved with the offenders
 * outlined into `.qa/layout/`. PASABOT_LAYOUT_SHOTS=1 saves every screen too. The normal `test:e2e` run audits English at 1200 and 390 px; `test:e2e:all` sets
 * PASABOT_LAYOUT_FULL=1 for the whole matrix (1440, 1200, 1024, 768, 390, 360 x en, de, ar).
 * Not covered here: the shop's product card and compare (they need the shop module's fixture store and a real
 * headless browser; modules/shop/e2e checks those for side scroll).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import {
  answerTeamSetup,
  approveTeamSetup,
  QUICK_TEAM_ANSWERS,
  startTeamSetup,
} from '../../../packages/testkit/src/e2e.js';
import { done, type E2EServer, expect, final, PASSWORD, script, test } from './fixtures.js';

const FULL = process.env.PASABOT_LAYOUT_FULL === '1';
/** PASABOT_LAYOUT_SHOTS=1 also saves every screen at every width into `.qa/layout/shots/`, for looking with eyes */
const SHOTS = process.env.PASABOT_LAYOUT_SHOTS === '1';
const WIDTHS = FULL ? [1440, 1200, 1024, 768, 390, 360] : [1200, 390];
const LOCALES = FULL
  ? ([
      { lng: 'en', browser: 'en-US' },
      { lng: 'de', browser: 'de-DE' },
      { lng: 'ar', browser: 'ar-EG' },
    ] as const)
  : ([{ lng: 'en', browser: 'en-US' }] as const);
const OUT = fileURLToPath(new URL('../../../.qa/layout/', import.meta.url));

export interface Violation {
  kind: 'outside-container' | 'outside-viewport' | 'overlap' | 'clipped-text' | 'page-hscroll';
  selector: string;
  other?: string;
  detail: string;
}

/** Runs in the page. Pure geometry; returns every violation on the current screen. */
function auditInPage(): Violation[] {
  const TOL = 1;
  const vw = document.documentElement.clientWidth;
  const out: Violation[] = [];
  const CONTAINER =
    '.bk-card, .panel, dialog, [role="dialog"], .bk-sheet, .bk-ask, .bk-decide, [data-layer="popover"]';
  const INTERACTIVE =
    'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="tab"], [role="switch"], .bk-badge, .pill';

  const selector = (el: Element): string => {
    const part = (e: Element) => {
      let s = e.tagName.toLowerCase();
      const tid = e.getAttribute('data-testid');
      if (tid) return `${s}[data-testid="${tid}"]`;
      if (e.id && !/^:|^_r_|^r\d|«/.test(e.id)) return `${s}#${e.id}`;
      const cls = [...e.classList].filter((c) => !c.startsWith('layout-audit')).slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      return s;
    };
    const parts: string[] = [];
    let e: Element | null = el;
    while (e && e !== document.body && parts.length < 4) {
      parts.unshift(part(e));
      if (e.getAttribute('data-testid')) break;
      e = e.parentElement;
    }
    return parts.join(' > ');
  };

  const shown = (el: Element) => {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return false;
    if (el.closest('[aria-hidden="true"]') && el.tagName.toLowerCase() === 'svg') return true;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (Number.parseFloat(s.opacity) === 0) return false;
    if (s.clipPath && s.clipPath !== 'none') return false; // visually hidden labels
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    // whole element off-screen sideways (skip links, slide-away drawers)
    if (r.right <= 0 || r.left >= vw) return false;
    // inside a closed <details>/<dialog> or a hidden ancestor
    if ((el as HTMLElement).offsetParent === null && s.position !== 'fixed' && el.tagName !== 'BODY') {
      if (!el.closest('dialog[open]')) return false;
    }
    // the folded part of a closed <details> (Chromium lays it out but skips painting it, so offsetParent is set)
    const shut = el.parentElement?.closest('details:not([open])');
    if (shut && !shut.querySelector(':scope > summary')?.contains(el)) return false;
    return true;
  };

  type Box = { l: number; t: number; r: number; b: number };
  const box = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const clipsX = (s: CSSStyleDeclaration) => s.overflowX !== 'visible';
  const clipsY = (s: CSSStyleDeclaration) => s.overflowY !== 'visible';
  const scrolls = (s: CSSStyleDeclaration) =>
    ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY);

  /** The part of `el` the user can see: its box cut by every clipping ancestor up to `stop` (the page's own body never
   counts: it hides overflow, so content cut by the window edge would otherwise pass). */
  const visibleBox = (el: Element, stop: Element | null): Box | null => {
    let b = box(el.getBoundingClientRect());
    for (
      let a = el.parentElement;
      a && a !== document.body && a !== document.documentElement;
      a = a.parentElement
    ) {
      const s = getComputedStyle(a);
      // the container's own edge only counts as a clip when it scrolls (a scrolling side list); a card that
      // merely hides overflow would hide the very fault this audit looks for
      if (a === stop && !scrolls(s)) break;
      const last = a === stop;
      if (!clipsX(s) && !clipsY(s)) {
        if (last) break;
        continue;
      }
      const r = a.getBoundingClientRect();
      if (clipsX(s)) b = { ...b, l: Math.max(b.l, r.left), r: Math.min(b.r, r.right) };
      if (clipsY(s)) b = { ...b, t: Math.max(b.t, r.top), b: Math.min(b.b, r.bottom) };
      if (b.r - b.l <= 0 || b.b - b.t <= 0) return null;
      if (last) break;
    }
    return b;
  };

  // 1. no sideways page scroll
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > vw + TOL)
    out.push({ kind: 'page-hscroll', selector: 'html', detail: `scrollWidth ${sw} > viewport ${vw}` });

  const all = [...document.body.querySelectorAll('*')].filter(shown);

  for (const el of all) {
    // 2. inside the nearest card/panel/dialog
    const container = el.parentElement?.closest(CONTAINER) ?? null;
    if (container && shown(container)) {
      const vb = visibleBox(el, container);
      const c = container.getBoundingClientRect();
      if (
        vb &&
        (vb.l < c.left - TOL || vb.r > c.right + TOL || vb.t < c.top - TOL || vb.b > c.bottom + TOL)
      ) {
        // only the outermost offender: skip when the parent already sticks out the same way
        const p = el.parentElement;
        const pvb = p && p !== container ? visibleBox(p, container) : null;
        const parentOut =
          pvb &&
          (pvb.l < c.left - TOL || pvb.r > c.right + TOL || pvb.t < c.top - TOL || pvb.b > c.bottom + TOL);
        if (!parentOut)
          out.push({
            kind: 'outside-container',
            selector: selector(el),
            other: selector(container),
            detail: `box ${Math.round(vb.l)}..${Math.round(vb.r)} x ${Math.round(vb.t)}..${Math.round(vb.b)} vs container ${Math.round(c.left)}..${Math.round(c.right)} x ${Math.round(c.top)}..${Math.round(c.bottom)}`,
          });
      }
    }
    // 3. inside the viewport sideways
    const vb = visibleBox(el, null);
    if (vb && (vb.l < -TOL || vb.r > vw + TOL)) {
      const p = el.parentElement;
      const pvb = p && p !== document.body ? visibleBox(p, null) : null;
      if (!(pvb && (pvb.l < -TOL || pvb.r > vw + TOL)))
        out.push({
          kind: 'outside-viewport',
          selector: selector(el),
          detail: `x ${Math.round(vb.l)}..${Math.round(vb.r)} vs viewport 0..${vw}`,
        });
    }
    // 4. text clipped by its own box without an ellipsis / line clamp
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
    const tag = el.tagName.toLowerCase();
    if (own && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      const s = getComputedStyle(el);
      const he = el as HTMLElement;
      const cutX = clipsX(s) && he.scrollWidth > he.clientWidth + TOL && s.textOverflow !== 'ellipsis';
      const clamp = s.getPropertyValue('-webkit-line-clamp');
      const cutY =
        clipsY(s) &&
        s.overflowY !== 'auto' &&
        s.overflowY !== 'scroll' &&
        he.scrollHeight > he.clientHeight + 2 &&
        (!clamp || clamp === 'none');
      if ((cutX && s.overflowX !== 'auto' && s.overflowX !== 'scroll') || cutY)
        out.push({
          kind: 'clipped-text',
          selector: selector(el),
          detail: `scroll ${he.scrollWidth}x${he.scrollHeight} > client ${he.clientWidth}x${he.clientHeight}: "${(el.textContent ?? '').trim().slice(0, 40)}"`,
        });
    }
  }

  // 5. interactive elements never overlap one another
  const inter = all
    .filter((el) => el.matches(INTERACTIVE))
    // a control wrapped by another control (a pill that is a button) counts once, as the outer one
    .filter((el) => !el.parentElement?.closest(INTERACTIVE))
    .map((el) => ({ el, b: visibleBox(el, null) }))
    .filter((x): x is { el: Element; b: Box } => x.b !== null);
  for (let i = 0; i < inter.length; i++)
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i]!;
      const b = inter[j]!;
      // a modal dialog makes everything behind it inert, and an open menu (popover or bottom sheet) is a layer of its
      // own over the page: only controls in the same layer can collide
      const LAYER = 'dialog[open], [data-layer="popover"]';
      if (a.el.closest(LAYER) !== b.el.closest(LAYER)) continue;
      const w = Math.min(a.b.r, b.b.r) - Math.max(a.b.l, b.b.l);
      const h = Math.min(a.b.b, b.b.b) - Math.max(a.b.t, b.b.t);
      if (w <= TOL || h <= TOL) continue;
      // a control painted over another in a different layer (a sticky bar over the scrolled log) is only an
      // overlap when the user can see it: check which one is on top at the shared area's middle
      const x = (Math.max(a.b.l, b.b.l) + Math.min(a.b.r, b.b.r)) / 2;
      const y = (Math.max(a.b.t, b.b.t) + Math.min(a.b.b, b.b.b)) / 2;
      const top = document.elementFromPoint(x, y);
      if (top && !a.el.contains(top) && !b.el.contains(top)) continue;
      out.push({
        kind: 'overlap',
        selector: selector(a.el),
        other: selector(b.el),
        detail: `overlap ${Math.round(w)}x${Math.round(h)} px`,
      });
    }
  return out;
}

interface Found extends Violation {
  screen: string;
  width: number;
  locale: string;
  shot: string;
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      ),
  );

/** Audits the current screen at every width; restores the first width afterwards. */
async function auditScreen(page: Page, screen: string, locale: string, found: Found[]) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await settle(page);
    await page.waitForTimeout(80);
    const v = await page.evaluate(auditInPage);
    if (SHOTS) {
      mkdirSync(`${OUT}shots/`, { recursive: true });
      await page.screenshot({ path: `${OUT}shots/${screen}-${width}-${locale}.png` });
    }
    if (!v.length) continue;
    mkdirSync(OUT, { recursive: true });
    const shot = `${OUT}${screen}-${width}-${locale}.png`;
    await page.evaluate(
      (sels) => {
        for (const s of sels)
          for (const el of document.querySelectorAll(s))
            (el as HTMLElement).style.outline = '2px solid #ff00aa';
      },
      v.flatMap((x) => [x.selector]),
    );
    await page.screenshot({ path: shot, fullPage: false });
    await page.evaluate(
      (sels) => {
        for (const s of sels)
          for (const el of document.querySelectorAll(s)) (el as HTMLElement).style.outline = '';
      },
      v.map((x) => x.selector),
    );
    for (const x of v) found.push({ ...x, screen, width, locale, shot });
  }
  await page.setViewportSize({ width: WIDTHS[0]!, height: 900 });
}

const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        credentials: 'same-origin',
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    },
    { method, path, body },
  );

const sendText = async (page: Page, text: string) => {
  const c = page.getByTestId('composer');
  await c.fill(text);
  await c.press('Enter');
};

const go = async (page: Page, server: E2EServer, hash: string) => {
  await page.goto(`${server.url}/#${hash}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await settle(page);
};

async function signedOut(browser: Browser, browserLocale: string, url: string) {
  const ctx = await browser.newContext({
    locale: browserLocale,
    viewport: { width: WIDTHS[0]!, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(url);
  return { ctx, page };
}

for (const loc of LOCALES)
  test(`layout audit (${loc.lng}): no overlap, nothing sticks out, no clipped text, no side scroll`, async ({
    browser,
    server,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'runs every width itself');
    test.setTimeout(FULL ? 900_000 : 300_000);
    const found: Found[] = [];
    const ctx = await browser.newContext({
      locale: loc.browser,
      viewport: { width: WIDTHS[0]!, height: 900 },
    });
    const page = await ctx.newPage();
    const audit = (screen: string) => auditScreen(page, screen, loc.lng, found);

    // signed out: claim (first run)
    await page.goto(server.setupLink);
    await expect(page.locator('input[autocomplete="name"]')).toBeVisible();
    await audit('claim');
    await page.locator('input[autocomplete="name"]').fill('Diwa');
    await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
    await page.locator('form button[type="submit"]').click();

    // first run: step 1 (pick a brain), then the team builder's full-screen Stage: the hello, the plan, the team;
    // then the main helper's chat with its summary, and a new helper's empty chat with its starter ideas
    await expect(page.getByTestId('onb-brain')).toBeVisible();
    await settle(page);
    await audit('onboarding-brain');
    await startTeamSetup(page);
    await settle(page);
    await audit('onboarding-question');
    await answerTeamSetup(page, QUICK_TEAM_ANSWERS);
    await settle(page);
    await audit('onboarding-plan');
    await approveTeamSetup(page);
    await expect(page.getByTestId('orch-team')).toBeVisible();
    await settle(page);
    await audit('onboarding-team');
    await page.getByTestId('orch-team-agent').first().click();
    await expect(page.getByTestId('starters')).toBeVisible();
    await settle(page);
    await audit('chat-starters');
    await go(page, server, '/agents/new');
    await expect(page.locator('form.bk-card')).toBeVisible();
    await audit('agent-new');
    await page.getByTestId('agent-more-toggle').click();
    await settle(page);
    await audit('agent-new-more');

    // two agents asking before they act, so two decisions wait
    const agents: { id: string; chatId: string }[] = [];
    for (const name of ['Tala', 'Kidlat']) {
      const r = await call(page, 'POST', '/api/v1/agents', {
        name,
        instructions: 'Handles purchasing. Asks before ordering.',
        providerId: 'fake',
        model: null,
        trustLevel: 'standard',
      });
      expect(r.status).toBeLessThan(300);
      agents.push({ id: (r.json.agent as { id: string }).id, chatId: r.json.chatId as string });
    }

    // chat with messages, a tool card, and an approval card
    await go(page, server, `/chats/${agents[0]!.chatId}`);
    await expect(page.getByTestId('composer')).toBeVisible();
    await sendText(page, 'Kumusta! Can you check the order for the kettles before Friday?');
    await expect(page.getByTestId('msg-agent').last())
      .toHaveAttribute('data-status', /done|complete|final/, {
        timeout: 20_000,
      })
      .catch(() => {});
    await sendText(
      page,
      script([
        {
          callTool: {
            name: 'memory_remember',
            args: { text: 'Bukas ang tindahan', key: 'shop', confidence: 'high' },
          },
        },
        final('Saved it.'),
        done,
      ]),
    );
    await page.waitForTimeout(1500);
    await sendText(
      page,
      'A long word for wrapping: Donaudampfschifffahrtsgesellschaftskapitänsmütze '.repeat(3),
    );
    await page.waitForTimeout(1500);
    await audit('chat');
    for (const a of agents) {
      await go(page, server, `/chats/${a.chatId}`);
      await expect(page.getByTestId('composer')).toBeVisible();
      await sendText(
        page,
        script([
          { expectPermission: { tool: 'Bash', input: { command: 'touch order.txt' }, decision: 'allow' } },
          final('done'),
          done,
        ]),
      );
      await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 20_000 });
    }
    await go(page, server, `/chats/${agents[0]!.chatId}`);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await audit('chat-approval-decisions');

    // signed out: sign in, and the join page of an invite
    const inv = await call(page, 'POST', '/api/m/people/invites', {
      kind: 'guest',
      chats: [{ chatId: agents[0]!.chatId, role: 'member' }],
    });
    expect(inv.status).toBeLessThan(300);
    {
      const o = await signedOut(browser, loc.browser, `${server.url}/#/login`);
      await expect(o.page.locator('input[type="password"]').first()).toBeVisible();
      await auditScreen(o.page, 'sign-in', loc.lng, found);
      await o.page.goto(`${server.url}${inv.json.path as string}`);
      await expect(o.page.getByTestId('people-join')).toBeVisible();
      await auditScreen(o.page, 'join-invite', loc.lng, found);
      await o.ctx.close();
    }

    // every page in the menu
    for (const [screen, hash] of [
      ['settings', '/settings'],
      ['skills', '/skills'],
      ['budget', '/budget'],
      ['people', '/people'],
      ['inbox', '/inbox'],
      ['devices', '/devices'],
      ['machines', '/machines'],
      ['browser', '/browser'],
      ['routines', '/routines'],
      ['workflows', '/workflows'],
      ['memory', '/memory'],
      ['mcp', '/mcp'],
      ['data', '/data'],
      ['usage', '/usage'],
      ['connectors', '/connectors'],
      ['collab', '/collab'],
      ['sites', '/sites'],
      ['search', '/search'],
      ['templates', '/templates'],
      ['computer', '/computer'],
      ['admin', '/admin'],
      ['procs', '/procs'],
      ['menu', '/menu'],
      ['agent-edit', `/agents/${agents[0]!.id}/edit`],
      ['brains', '/settings/agents/brains'],
    ] as const) {
      await go(page, server, hash);
      await audit(screen);
    }

    // Settings (Simplify): the group list, every group page, a search, a core feature page
    for (const g of [
      'agents',
      'tools',
      'automations',
      'safety',
      'spending',
      'people',
      'machines',
      'shopping',
      'inbox',
      'memory',
      'look',
      'advanced',
    ]) {
      await go(page, server, `/settings/${g}`);
      await audit(`settings-${g}`);
    }
    await go(page, server, '/settings?q=rout');
    await audit('settings-search');
    await go(page, server, '/settings/look/language');
    await audit('settings-language');
    // the sidebar with pinned features, then the account and More menus open (desktop, then phone)
    const pins = await call(page, 'PUT', '/api/v1/me/prefs/ui.pins', {
      value: ['routines', 'inbox', 'memory', 'safety'],
    });
    expect(pins.status).toBe(200);
    await go(page, server, `/chats/${agents[0]!.chatId}`);
    await page.reload();
    await expect(page.getByTestId('pinned').first()).toBeAttached();
    await audit('chat-pinned');
    for (const [screen, width, btn] of [
      ['account-menu', 1200, '.top [data-testid="account-menu"]'],
      ['more-menu', 1200, '[data-testid="chat-more-btn"]'],
      ['account-menu-phone', 390, '.ptop [data-testid="account-menu"]'],
      ['more-menu-phone', 390, '[data-testid="phone-chat-more-btn"]'],
      // the chat header's model picker (polish B): a popover on desktop, a bottom sheet on a phone
      ['model-picker', 1200, '.ch [data-testid="model-pill"]'],
      ['model-picker-phone', 390, '.ptop [data-testid="model-pill"]'],
    ] as const) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await go(
        page,
        server,
        screen.startsWith('account') && width < 600 ? '/' : `/chats/${agents[0]!.chatId}`,
      );
      await page.locator(btn).click();
      await audit(screen);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: WIDTHS[0]!, height: 900 });

    // the Brains page with a test result open, then a brain's steps sheet open
    await go(page, server, '/settings/agents/brains');
    const fakeTile = page.locator('[data-testid="brain-tile"][data-brain="fake"]');
    await fakeTile.locator('[data-action="test"]').click();
    await expect(fakeTile.getByTestId('brain-test-result')).toBeVisible({ timeout: 20_000 });
    await audit('brains-test-result');
    await page.locator('[data-testid="brain-tile"][data-brain="claude"] [data-action="install"]').click();
    await expect(page.getByTestId('brain-steps')).toBeVisible();
    await audit('brains-steps');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('brain-steps')).toHaveCount(0);

    // safety: the page, a receipt, then the stop report (resumed with the password afterwards)
    await go(page, server, '/safety');
    await audit('safety');
    const receipt = page.getByTestId('receipt-list').getByRole('button').first();
    if (await receipt.count()) {
      await receipt.click();
      await expect(page.getByTestId('receipt-detail')).toBeVisible();
      await audit('safety-receipt');
    }
    await page.locator('[data-testid="stop-all"]:visible').first().click();
    await expect(page.locator('dialog[open]').getByTestId('stop-report')).toBeVisible();
    await audit('safety-stop-report');
    await page
      .locator('dialog[open]')
      .getByTestId('stop-report')
      .locator('.bk-btn--primary, button')
      .last()
      .click();
    const form = page.locator('dialog[open]').getByTestId('resume-form');
    if (await form.count()) {
      await form.locator('input[type="password"]').fill(PASSWORD);
      await form.locator('button[type="submit"]').click();
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}report-${loc.lng}.json`, JSON.stringify(found, null, 2));
    const lines = found.map(
      (f) =>
        `${f.screen} @${f.width} ${f.locale} ${f.kind}: ${f.selector}${f.other ? ` | ${f.other}` : ''} (${f.detail}) -> ${f.shot}`,
    );
    expect(lines, `layout violations (${found.length})`).toEqual([]);
    await ctx.close();
  });
