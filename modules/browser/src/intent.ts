/**
 * ARCHITECTURE 7.1 "Always asks" for the managed browser: a deterministic detector over the page's address, its form
 * fields (child frames included, e.g. an embedded card form) and the element the action targets recognises a
 * checkout/payment page or a compose/send form. A click or a typed entry there asks the owner, and the agent must
 * declare the intent (`intent` argument); an undeclared action on a detected page is held for the owner too, and its
 * card says so. The page is read in the renderer (`page.evaluate`); the classification here is a plain word match on
 * the main thread, with no regular expressions.
 */
import { maskPaymentLabel, words } from '@pasabot/core';
import type { ActionClass, ApprovalAsk } from '@pasabot/protocol';
import type { Locator, Page } from 'playwright-core';

export const INTENTS = ['none', 'money', 'outbound-message'] as const;
export type Intent = (typeof INTENTS)[number];

/** one form field as the page shows it (attributes only; a value only for the fields a card shows) */
export interface PageField {
  name: string;
  id: string;
  type: string;
  autocomplete: string;
  placeholder: string;
  label: string;
  tag: string;
  value: string;
  /** index of the field's form in the top document (-1: none, or a field of a child frame) */
  form?: number;
  /** the field is in a child frame (its value is never read) */
  frame?: boolean;
  /**
   * the field is not shown now: `type="hidden"`, not rendered, `visibility: hidden`, zero-size, transparent, or
   * under `[hidden]`, `[inert]` or `aria-hidden` (a later checkout step, a hidden frame)
   */
  hidden?: boolean;
}
/** the element an action targets, read in the renderer just before the action is checked */
export interface PageTarget {
  /** what it says: its own visible text (its text when none is visible), value (buttons), aria-label and title */
  label: string;
  /** what it is: name, id, placeholder and autocomplete */
  attrs: string;
  /** index of its form in the top document, -1 when it is in none */
  form: number;
}
export interface PageCapture {
  url: string;
  fields: PageField[];
  /** text of the first element whose id/class/name says "total" (a checkout's amount), if any */
  total: string;
  /** the element the action targets; absent when not looked up, null when it is not on the page */
  target?: PageTarget | null;
}

const MAX_FRAMES = 20;
const FRAME_WAIT_MS = 2000;

/**
 * The renderer side of `capturePage`, as plain JavaScript source rather than compiled functions: a bundler's helpers
 * (esbuild's `__name` under tsx) do not exist in the page, so a compiled arrow with named inner functions fails
 * there with "__name is not defined". `SHOWN_SRC` is shared by the scripts below.
 */
const SHOWN_SRC = `function shown(el) {
    if (String(el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!el.getClientRects().length) return false;
    var s = getComputedStyle(el);
    if (s.visibility !== 'visible' || Number(s.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 1 || r.height >= 1;
  }`;
export const TOP_FIELDS_SRC = `(function () {
  ${SHOWN_SRC}
  function cut(s, n) { return String(s == null ? '' : s).slice(0, n || 200); }
  var forms = Array.prototype.slice.call(document.forms);
  var els = Array.prototype.slice.call(
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]'), 0, 200);
  var out = els.map(function (e) {
    var id = e.id || '';
    var esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.split('"').join('');
    var labEl = id ? document.querySelector('label[for="' + esc + '"]') : null;
    var editable = e.getAttribute('contenteditable') === 'true';
    var f = e.closest('form');
    return {
      name: cut(e.getAttribute('name')),
      id: cut(id),
      type: cut(e.getAttribute('type') || ''),
      autocomplete: cut(e.getAttribute('autocomplete') || ''),
      placeholder: cut(e.getAttribute('placeholder') || ''),
      label: cut(e.getAttribute('aria-label') || (labEl ? labEl.textContent : '') || ''),
      tag: e.tagName.toLowerCase(),
      value: cut(editable ? e.textContent : (e.value == null ? '' : e.value), 20000),
      form: f ? forms.indexOf(f) : -1,
      hidden: !shown(e)
    };
  });
  var t = document.querySelector('[id*="total" i], [class*="total" i], [name*="total" i], [data-total]');
  return { url: location.href, fields: out, total: cut(t && t.textContent ? t.textContent.trim() : '', 80) };
})()`;
export const FRAME_FIELDS_SRC = `(function () {
  ${SHOWN_SRC}
  function cut(s) { return String(s == null ? '' : s).slice(0, 200); }
  return Array.prototype.slice.call(document.querySelectorAll('input, select'), 0, 50).map(function (e) {
    return {
      name: cut(e.getAttribute('name')),
      id: cut(e.id),
      type: cut(e.getAttribute('type') || ''),
      autocomplete: cut(e.getAttribute('autocomplete') || ''),
      placeholder: cut(e.getAttribute('placeholder') || ''),
      label: cut(e.getAttribute('aria-label') || ''),
      tag: e.tagName.toLowerCase(),
      hidden: !shown(e)
    };
  });
})()`;
/** the target element's facts; a function made from source at run time (it gets the element), never compiled */
export const TARGET_SRC = `
  var a = function (k) { return el.getAttribute(k) || ''; };
  var button = el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && ['submit', 'button'].indexOf(el.type) >= 0);
  var f = el.closest('form');
  var text = String(el.innerText || '').trim() || String(el.textContent || '').trim();
  return {
    label: [text, button ? el.value || '' : '', a('aria-label'), a('title')].join(' ').slice(0, 400),
    attrs: [a('name'), el.id || '', a('placeholder'), a('autocomplete')].join(' ').slice(0, 400),
    form: f ? Array.prototype.indexOf.call(document.forms, f) : -1
  };`;
// built from source at run time (Playwright passes it the element): no bundler helper can be in it
const targetFn = new Function('el', TARGET_SRC) as (el: Element) => PageTarget;

/**
 * Reads the page's address and fields in the renderer (bounded: 200 fields, short strings), the card-like fields of
 * its child frames (cross-origin card forms such as embedded payment fields; never their values), and the element
 * `target` names, without waiting for it to appear. Each field says whether it is shown now (`hidden`); a field of
 * a hidden frame is hidden.
 */
export async function capturePage(page: Page, target?: Locator): Promise<PageCapture> {
  const top = (await page.evaluate(TOP_FIELDS_SRC)) as PageCapture;

  // child frames: attributes of their fields only (a card number typed into a payment frame is never read)
  for (const fr of page.frames().slice(0, MAX_FRAMES + 1)) {
    if (fr === page.mainFrame()) continue;
    const got = await Promise.race([
      fr.evaluate(FRAME_FIELDS_SRC).catch(() => []) as Promise<Omit<PageField, 'value'>[]>,
      new Promise<[]>((r) => setTimeout(() => r([]), FRAME_WAIT_MS)),
    ]);
    const frameShown = got.length
      ? await fr
          .frameElement()
          .then((h) => h.isVisible())
          .catch(() => true)
      : true;
    for (const f of got)
      top.fields.push({ ...f, value: '', form: -1, frame: true, hidden: !!f.hidden || !frameShown });
  }

  if (target) {
    top.target = null;
    try {
      if ((await target.count()) > 0)
        top.target = (await target.first().evaluate(targetFn, undefined, { timeout: 1000 })) as PageTarget;
    } catch {
      top.target = null;
    }
  }
  return top;
}

/** address words that mean the page itself takes money (a cart or an order-history page does not, by itself) */
const MONEY_URL = new Set([
  'checkout',
  'payment',
  'payments',
  'pay',
  'billing',
  'purchase',
  'buy',
  'placeorder',
  'subscribe',
  'subscription',
  'donate',
]);
/** field words of card / bank-account entry (not `cc`: that is a compose form's copy line) */
const MONEY_FIELD = new Set(['card', 'cardnumber', 'ccnumber', 'cvc', 'cvv', 'csc', 'expiry', 'iban']);
/** words of an element whose own action takes money ("Buy now", "Pay", "Subscribe") */
const MONEY_ACTION = new Set(['buy', 'pay', 'purchase', 'checkout', 'subscribe', 'donate', 'placeorder']);
/** two-word money actions: "Place your order", "Confirm purchase", "Start subscription" */
const MONEY_PHRASE_A = new Set(['place', 'submit', 'confirm', 'complete', 'start']);
const MONEY_PHRASE_B = new Set(['order', 'purchase', 'payment', 'subscription', 'trial']);
const MESSAGE_URL = new Set(['compose', 'send', 'message', 'messages', 'reply', 'dm']);
const MESSAGE_ACTION = new Set(['send', 'post', 'tweet', 'publish']);
const TO_FIELD = new Set(['to', 'recipient', 'recipients', 'cc', 'bcc']);
const BODY_FIELD = new Set(['body', 'message', 'text', 'content', 'compose']);

const fieldWords = (f: PageField) =>
  words(`${f.name} ${f.id} ${f.autocomplete} ${f.placeholder} ${f.label}`).filter(Boolean);

function urlWords(url: string): string[] {
  try {
    const u = new URL(url);
    return words(`${u.pathname} ${u.hash}`);
  } catch {
    return [];
  }
}

const ACTION_WORDS = 4;
/** the autocomplete tokens of card entry (a bare `cc` field is a compose form's copy line, not a card) */
const CC_TOKENS = ['cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-type'];
const moneyPhrase = (ws: string[]) =>
  ws.some((w, k) => MONEY_PHRASE_A.has(w) && ws.slice(k + 1, k + 3).some((x) => MONEY_PHRASE_B.has(x)));

/** Both signals of a page, separately: it takes money, and/or it sends a message. */
export function detectSignals(c: PageCapture): { money: boolean; message: boolean } {
  const uw = urlWords(c.url);
  // the target's own words count as an action only when short, like a button ("Place your order", "Send"), not a
  // headline link that happens to contain "buy" or "post"
  const lw = c.target ? words(c.target.label) : [];
  const tw = lw.length <= ACTION_WORDS ? lw : [];
  const aw = c.target ? words(c.target.attrs) : [];
  const card = (f: PageField) =>
    f.autocomplete.toLowerCase().startsWith('cc-') || fieldWords(f).some((w) => MONEY_FIELD.has(w));
  // a card field the page shows makes it a payment page; a hidden or later-step one does not (a product page's
  // hidden card input never blocks "Add to cart"), unless it holds a value the target's form would submit
  const inTargetForm = (f: PageField) => !!c.target && c.target.form >= 0 && f.form === c.target.form;
  const money =
    c.fields.some((f) => card(f) && (!f.hidden || (!f.frame && !!f.value.trim() && inTargetForm(f)))) ||
    uw.some((w) => MONEY_URL.has(w)) ||
    tw.some((w) => MONEY_ACTION.has(w)) ||
    moneyPhrase(tw) ||
    CC_TOKENS.some((t) => (c.target?.attrs ?? '').toLowerCase().includes(t)) ||
    aw.some((w) => MONEY_FIELD.has(w));
  // a compose form: recipients plus a body, in the target's own form when it is in one
  const scope = c.target && c.target.form >= 0 ? c.fields.filter((f) => f.form === c.target!.form) : c.fields;
  const fw = scope.map(fieldWords);
  const to = fw.some((ws) => ws.some((w) => TO_FIELD.has(w)));
  const body = scope.some(
    (f, k) =>
      f.tag === 'textarea' ||
      (f.tag !== 'input' && f.tag !== 'select') ||
      fw[k]!.some((w) => BODY_FIELD.has(w)),
  );
  const message =
    (to && body) || (body && uw.some((w) => MESSAGE_URL.has(w))) || tw.some((w) => MESSAGE_ACTION.has(w));
  return { money, message };
}

/** What the page is, by its address, fields and the target element: money first, then a message, or neither. */
export function detectPage(c: PageCapture): ActionClass | undefined {
  const s = detectSignals(c);
  return s.money ? 'money' : s.message ? 'outbound-message' : undefined;
}

/** The class a browser action has: what the agent declared, what the page is, money first. */
export function browserClass(intent: Intent, detected: ActionClass | undefined): ActionClass | undefined {
  if (intent === 'money' || detected === 'money') return 'money';
  if (intent === 'outbound-message' || detected === 'outbound-message') return 'outbound-message';
  return undefined;
}

/**
 * The card for a browser action, from the page the server read (never the agent's summary). A page that both takes
 * money and sends a message gets a money card that also shows the message facts.
 */
export function browserAsk(
  cls: ActionClass,
  c: PageCapture,
  o: { intent: Intent; detected: ActionClass | undefined; typed?: string },
): ApprovalAsk {
  let host: string | null = null;
  try {
    host = new URL(c.url).host || null;
  } catch {
    host = null;
  }
  const by = (set: Set<string>) =>
    c.fields
      .filter((f) => !f.frame && fieldWords(f).some((w) => set.has(w)) && f.value.trim())
      .map((f) => f.value.trim());
  const undeclared = !!o.detected && o.intent !== o.detected;
  const subject = c.fields.find((f) => !f.frame && fieldWords(f).includes('subject') && f.value.trim());
  const bodyText =
    by(BODY_FIELD)[0] ?? c.fields.find((f) => f.tag === 'textarea' && !f.frame && f.value.trim())?.value;
  const messageFacts = (typed: boolean) => [
    { key: 'recipients', value: by(TO_FIELD).join(', ') || null },
    { key: 'channel', value: host },
    { key: 'subject', value: subject?.value.trim() || null },
    { key: 'text', value: ((typed ? o.typed : undefined) ?? bodyText ?? '') || null },
  ];
  if (cls === 'money') {
    const cardField = cardFieldOf(c);
    const alsoMessage = o.intent === 'outbound-message' || detectSignals(c).message;
    return {
      class: 'money',
      fields: [
        { key: 'items', value: null },
        { key: 'merchant', value: host },
        { key: 'total', value: c.total || null },
        { key: 'paymentMethod', value: cardField?.value ? maskPaymentLabel(cardField.value) : null },
        // the message facts too (recipients, subject, text); the typed text is never shown on a money card
        ...(alsoMessage ? messageFacts(false).filter((f) => f.key !== 'channel') : []),
      ],
      ...(undeclared ? { undeclared } : {}),
    };
  }
  return {
    class: cls,
    fields: cls === 'outbound-message' ? messageFacts(true) : [{ key: 'target', value: c.url }],
    ...(undeclared ? { undeclared } : {}),
  };
}

/** the card number field of the top document (a money card shows its label; its value is never read in a frame) */
const cardFieldOf = (c: PageCapture) =>
  c.fields.find(
    (f) => !f.frame && (f.autocomplete.toLowerCase() === 'cc-number' || fieldWords(f).includes('cardnumber')),
  );

/**
 * Everything the always-ask card of this page says (`browserAsk`), with the card number field in full rather than
 * masked: the re-check right before the click or entry compares it with the page the owner approved, so a changed
 * recipient, subject, body, total, merchant or card refuses the action (7.1).
 */
export function askBasis(
  cls: ActionClass,
  c: PageCapture,
  o: { intent: Intent; detected: ActionClass | undefined; typed?: string },
): string {
  return JSON.stringify([browserAsk(cls, c, o).fields, cardFieldOf(c)?.value.trim() ?? null]);
}
