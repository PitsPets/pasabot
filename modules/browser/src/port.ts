/**
 * The W15 managed browser as a port for other modules' server code (`ModuleHost.browser`, W30 shopping). It reads a
 * page's structured product data, sets an allowed form field, clicks an allowed control and hands the live view to
 * the owner. Every address must be on the caller's `allowedHosts`; card, bank, password and one-time-code fields
 * are never filled; a money action (pay, place order) or anything on a payment page is never clicked. Page data is
 * read in the renderer and bounded; it is untrusted data for the caller. No regular expressions.
 */
import type { BrowserPageData, BrowserPortActor, ManagedBrowserPort, ModuleHost } from '@pasabot/core';
import { urlAllowed } from '@pasabot/protocol';
import type { Page } from 'playwright-core';
import { clickRefusal, elementFacts, findGuidedField, typeRefusal } from './guided.js';
import { capturePage, detectSignals, type PageField } from './intent.js';

/** what the port needs of the BrowserManager (a structural type, so this file does not import server.ts) */
interface Manager {
  resolve(ref?: string): { id: string; logged_in: number } | undefined;
  forTool(ref: string | undefined): Promise<{ id: string; logged_in: number }>;
  open(id: string): Promise<{ page: Page }>;
  markLoggedIn(id: string): void;
  announce(id: string): void;
  withLock<T>(profile: string, fn: () => Promise<T>): Promise<T>;
  create(b: { name: string; color: string }): Promise<{ id: string }>;
  guided(id: string): { hosts: string[]; takenOver: boolean } | undefined;
  startGuided(id: string, url: string, hosts: readonly string[]): Promise<void>;
  takeOverGuided(id: string): void;
  endGuided(id: string): void;
  assertNotTakenOver(id: string): void;
  assertGuidedOnHost(id: string): void;
}

const MAX_JSON_LD = 20;
const MAX_JSON_LD_CHARS = 50_000;
const MAX_PAIRS = 200;
const MAX_VALUE = 2_000;
const MAX_SELECTORS = 12;

/** the one allow-list matcher (`@pasabot/protocol`), shared with store packs and the Shop page */
const hostOk = (raw: string, patterns: readonly string[]) => urlAllowed(raw, patterns);

const words = (s: string) => {
  const out: string[] = [];
  let w = '';
  for (const ch of s.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) w += ch;
    else if (w) {
      out.push(w);
      w = '';
    }
  }
  if (w) out.push(w);
  return out;
};
/** words of a field that is not the agent's or the server's to type into */
const SECRET_FIELD = new Set([
  'card',
  'cardnumber',
  'ccnumber',
  'cvc',
  'cvv',
  'csc',
  'expiry',
  'iban',
  'account',
  'accountnumber',
  'routing',
  'bank',
  'password',
  'passcode',
  'otp',
  'pin',
  'onetime',
  'verification',
  'code',
]);
const secretAttrs = (attrs: string) => {
  const low = attrs.toLowerCase();
  return (
    low.includes('cc-') ||
    low.includes('one-time-code') ||
    low.includes('current-password') ||
    low.includes('new-password') ||
    words(attrs).some((w) => SECRET_FIELD.has(w))
  );
};
const isSecretField = (f: PageField) =>
  f.type.toLowerCase() === 'password' ||
  secretAttrs(`${f.name} ${f.id} ${f.autocomplete} ${f.placeholder} ${f.label}`);

/**
 * Reads the page's structured data in the renderer (bounded). The script is plain JavaScript source, not a compiled
 * function: a bundler's helpers (esbuild's `__name` under tsx) do not exist in the page.
 */
const EXTRACT_SRC = `(function (arg) {
  var sel = arg.sel, lim = arg.lim;
  function cut(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function readOf(el) {
    var v = el.getAttribute('content');
    if (v == null) v = el.getAttribute('src');
    if (v == null) v = el.getAttribute('href');
    if (v == null && el instanceof HTMLInputElement) v = el.value;
    if (v == null) v = el.textContent;
    return v;
  }
  var jsonLd = Array.prototype.slice.call(document.querySelectorAll('script[type="application/ld+json"]'), 0, lim.jsonLd)
    .map(function (s) { return cut(s.textContent, lim.jsonLdChars); });
  var meta = [];
  Array.prototype.slice.call(document.querySelectorAll('meta'), 0, lim.pairs * 2).forEach(function (m) {
    var key = m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop');
    var value = m.getAttribute('content');
    if (key && value != null && meta.length < lim.pairs) meta.push({ key: cut(key, 100), value: cut(value, lim.value) });
  });
  var microdata = [];
  Array.prototype.slice.call(document.querySelectorAll('[itemprop]'), 0, lim.pairs).forEach(function (el) {
    if (el.tagName === 'META') return;
    microdata.push({ prop: cut(el.getAttribute('itemprop'), 100), value: cut(readOf(el), lim.value) });
  });
  var selected = {};
  Object.keys(sel).forEach(function (k) {
    var el = null;
    try { el = document.querySelector(sel[k]); } catch (e) { el = null; }
    selected[k] = el ? cut(readOf(el), lim.value) : null;
  });
  var captcha = Array.prototype.some.call(document.querySelectorAll('iframe'), function (f) {
    var src = low(f.getAttribute('src'));
    return src.indexOf('captcha') >= 0 || src.indexOf('challenges.cloudflare') >= 0 || src.indexOf('turnstile') >= 0;
  }) || Array.prototype.slice.call(document.querySelectorAll('[id],[class],[name]'), 0, 2000).some(function (el) {
    return low(el.getAttribute('id')).indexOf('captcha') >= 0 || low(el.getAttribute('class')).indexOf('captcha') >= 0 ||
      low(el.getAttribute('name')).indexOf('captcha') >= 0;
  });
  var signIn = !!document.querySelector('input[type="password"]');
  var cardField = Array.prototype.slice.call(document.querySelectorAll('input, select'), 0, 400).some(function (el) {
    var ac = low(el.getAttribute('autocomplete'));
    var words = low([el.getAttribute('name'), el.id, el.getAttribute('placeholder')].join(' ')).split(/[^a-z0-9]+/);
    return ac.indexOf('cc-') === 0 || words.some(function (w) {
      return ['card', 'cardnumber', 'ccnumber', 'cvc', 'cvv', 'iban'].indexOf(w) >= 0;
    });
  });
  return { title: cut(document.title, 300), jsonLd: jsonLd, meta: meta, microdata: microdata, selected: selected,
    captcha: captcha, signIn: signIn, cardField: cardField };
})`;
interface Extracted {
  title: string;
  jsonLd: string[];
  meta: { key: string; value: string }[];
  microdata: { prop: string; value: string }[];
  selected: Record<string, string | null>;
  captcha: boolean;
  signIn: boolean;
  cardField: boolean;
}
async function extract(page: Page, selectors: Record<string, string>): Promise<Extracted> {
  const arg = {
    sel: selectors,
    lim: { jsonLd: MAX_JSON_LD, jsonLdChars: MAX_JSON_LD_CHARS, pairs: MAX_PAIRS, value: MAX_VALUE },
  };
  return (await page.evaluate(`${EXTRACT_SRC}(${JSON.stringify(arg)})`)) as Extracted;
}

export function createBrowserPort(m: Manager, app: Pick<ModuleHost, 'log' | 'notifier' | 'killSwitch'>) {
  const check = (actor: BrowserPortActor) => {
    if (
      !actor ||
      (actor.kind !== 'user' && actor.kind !== 'agent' && actor.kind !== 'system') ||
      (actor.kind === 'system' ? !actor.reason : !actor.id)
    )
      throw new Error('the browser port needs an actor');
  };
  const halted = () => {
    if (app.killSwitch.isStopped()) throw new Error('everything is stopped');
  };
  const session = async (actor: BrowserPortActor, profile?: string, approvedTier?: number) => {
    check(actor);
    halted();
    const r = await m.forTool(profile);
    // W43: a guided sign-up the owner took over is the owner's alone, whoever the caller is
    m.assertNotTakenOver(r.id);
    m.assertGuidedOnHost(r.id);
    // an agent's use of a profile that may hold the owner's sign-ins is tier 3 (as the browser tools' own tierFor):
    // the caller says what its action was cleared at, read against the profile as it is now
    if (actor.kind === 'agent' && r.logged_in === 1 && (approvedTier ?? 0) < 3)
      throw new Error(
        'this browser profile may hold the owner’s sign-ins, so an agent needs the owner’s approval to use it',
      );
    const s = await m.open(r.id);
    app.log.info('browser port', {
      profile: r.id,
      actor: actor.kind === 'system' ? `system:${actor.reason}` : `${actor.kind}:${actor.id}`,
    });
    return { r, s };
  };
  const onHosts = (page: Page, hosts: readonly string[]) => {
    if (!hostOk(page.url(), hosts)) throw new Error('the page is not on an allowed address');
  };
  /** the checked element itself, so the action cannot land on a page that loads after the check */
  const pinned = async (page: Page, target: ReturnType<Page['locator']>, checkedUrl: string) => {
    const handle = await target.elementHandle({ timeout: 1000 }).catch(() => null);
    if (!handle) throw new Error('that element is not on the page now');
    if (page.url() !== checkedUrl) throw new Error('the page changed; read it again before retrying');
    return handle;
  };
  const port: ManagedBrowserPort = {
    profileInfo(o) {
      const r = m.resolve(o?.profile);
      return r ? { id: r.id, loggedIn: r.logged_in === 1 } : null;
    },
    async read(actor, o) {
      const { r, s } = await session(actor, o.profile, o.approvedTier);
      // under the profile's page lock: a navigation never lands between a browser tool's check and its click
      return m.withLock(r.id, async () => {
        halted();
        if (o.url !== undefined) {
          if (!hostOk(o.url, o.allowedHosts)) throw new Error('that address is not allowed');
          await s.page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        }
        onHosts(s.page, o.allowedHosts);
        const sel = Object.fromEntries(Object.entries(o.selectors ?? {}).slice(0, MAX_SELECTORS));
        const x = await extract(s.page, sel);
        const data: BrowserPageData = {
          url: s.page.url(),
          title: x.title,
          jsonLd: x.jsonLd,
          meta: x.meta,
          microdata: x.microdata,
          selected: x.selected,
          signals: { captcha: x.captcha, cardField: x.cardField, signIn: x.signIn },
        };
        return data;
      });
    },
    async fill(actor, o) {
      const { r, s } = await session(actor, o.profile, o.approvedTier);
      // the check and the entry are one step under the profile's page lock
      await m.withLock(r.id, async () => {
        halted();
        onHosts(s.page, o.allowedHosts);
        const target = s.page.locator(o.selector).first();
        const cap = await capturePage(s.page, target);
        if (!cap.target) throw new Error('that field is not on the page');
        const t = cap.target;
        const field = cap.fields.find(
          (f) => secretAttrs(`${f.name} ${f.id}`) && t.attrs.includes(f.name || f.id),
        );
        if (secretAttrs(t.attrs) || secretAttrs(t.label) || (field && isSecretField(field)))
          throw new Error('card, bank, password and one-time-code fields are only ever the owner’s to fill');
        const type = (await target.getAttribute('type'))?.toLowerCase() ?? '';
        if (type === 'password') throw new Error('password fields are only ever the owner’s to fill');
        const el = await pinned(s.page, target, cap.url);
        if (m.guided(r.id)) {
          const why = typeRefusal(await elementFacts(el));
          if (why) throw new Error(why);
        }
        await el.fill(o.value, { timeout: 5000 });
      });
    },
    async click(actor, o) {
      const { r, s } = await session(actor, o.profile, o.approvedTier);
      // the money check and the click are one step under the profile's page lock
      await m.withLock(r.id, async () => {
        halted();
        onHosts(s.page, o.allowedHosts);
        const target = s.page.locator(o.selector).first();
        const cap = await capturePage(s.page, target);
        if (!cap.target) throw new Error('that control is not on the page');
        if (detectSignals(cap).money)
          throw new Error(
            'paying, placing an order or anything on a payment page is only ever the owner’s to do',
          );
        const el = await pinned(s.page, target, cap.url);
        if (m.guided(r.id)) {
          const why = clickRefusal(await elementFacts(el));
          if (why) throw new Error(why);
        }
        await el.click({ timeout: 5000 });
        await s.page.waitForLoadState('domcontentloaded').catch(() => {});
        onHosts(s.page, o.allowedHosts);
      });
    },
    async handOver(actor, o) {
      const { r } = await session(actor, o.profile, o.approvedTier);
      m.markLoggedIn(r.id);
      m.announce(r.id);
      await app.notifier
        .notify({
          level: 'info',
          title: 'Your turn in the browser',
          body: o.reason,
          href: '#/browser',
          msg: { title: { key: 'browser:server.yourTurn' } },
          // W40: a card with the live picture and Take over (in the pinned decision bar until the owner is done)
          card: {
            variant: 'ok',
            title: { key: 'browser:server.yourTurn' },
            ...(o.reason ? { text: { text: o.reason.slice(0, 1000) } } : {}),
            actions: [
              {
                id: 'take',
                label: { key: 'core:card.action.takeOver' },
                style: 'primary',
                href: '#/browser',
              },
              { id: 'done', label: { key: 'core:card.action.imDone' }, style: 'secondary', settle: 'done' },
            ],
            needsAnswer: true,
            ref: `browser:${r.id}`,
            source: 'browser',
            visual: { kind: 'browser', profileId: r.id },
          },
        })
        .catch(() => {});
      return { profileId: r.id };
    },
    // W43 "Do it with me": the caller's server flow fills only the named fields; never a click, never a secret
    guided: {
      async start(actor, o) {
        check(actor);
        halted();
        const name = o.profileName.trim().slice(0, 60);
        const r = m.resolve(name) ?? (await m.create({ name, color: '#0ea5e9' }));
        await m.startGuided(r.id, o.url, o.allowedHosts);
        app.log.info('browser guided flow started', {
          profile: r.id,
          actor: actor.kind === 'system' ? `system:${actor.reason}` : `${actor.kind}:${actor.id}`,
        });
        return { profileId: r.id };
      },
      async fill(actor, o) {
        check(actor);
        halted();
        const g = m.guided(o.profileId);
        if (!g) throw new Error('no guided sign-up is open in that browser');
        m.assertNotTakenOver(o.profileId);
        const s = await m.open(o.profileId);
        const filled: string[] = [];
        await m.withLock(o.profileId, async () => {
          halted();
          m.assertGuidedOnHost(o.profileId);
          if (!hostOk(s.page.url(), g.hosts)) throw new Error('the page is not the sign-up page');
          for (const f of o.fields) {
            const el = await findGuidedField(s.page, f.kind);
            if (!el) continue;
            // the same rule as every other hand on this browser, read on the element itself
            if (typeRefusal(await elementFacts(el))) continue;
            await el.fill(f.value.slice(0, 100), { timeout: 5000 });
            filled.push(f.kind);
          }
        });
        return { filled };
      },
      takeOver(o) {
        m.takeOverGuided(o.profileId);
        m.announce(o.profileId);
      },
      end(o) {
        m.endGuided(o.profileId);
      },
      state(profileId) {
        const g = m.guided(profileId);
        return { active: !!g, takenOver: !!g?.takenOver };
      },
    },
  };
  return port;
}
