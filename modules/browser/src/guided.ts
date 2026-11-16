/**
 * W43 "Do it with me": a guided sign-up on one browser profile (the inbox's new-email checklist). While a profile is
 * in a guided flow, the server fills only the fields the flow names (first name, last name, the chosen address), and
 * every other hand on that browser, a helper's tools and the module port alike, is held to these rules in code:
 *
 * - nothing types into a password, a one-time code, a phone number or any OTP-like field
 *   (`input[type=password]`, `autocomplete` new-password / current-password / one-time-code / tel*, `type=tel`,
 *   `inputmode=tel|numeric` with a code word, or a name/id/label word such as otp, code, verification, phone, pin);
 * - nothing clicks a submit-like control (a submit button, a button inside a form with no type, or a control whose
 *   words say next, continue, create, sign up, agree, verify, send, …) and nothing presses Enter to submit;
 * - pages open only on the flow's own sign-up hosts (its allow-list; the guard proxy's safe-net vetting still runs);
 * - once the owner takes over, helpers cannot act in that browser at all and its frames are neither kept nor read.
 *
 * Page content is untrusted: these checks read the element the action targets in the renderer, never what the page
 * says it is in text meant for a reader. No regular expressions on page text (word lists only).
 */
import type { ElementHandle, Page } from 'playwright-core';

/** what an element is, read in the renderer right before an action on it */
export interface ElementFacts {
  tag: string;
  type: string;
  autocomplete: string;
  inputmode: string;
  name: string;
  id: string;
  role: string;
  /** its label: aria-label, a <label for>, an enclosing label, its placeholder and its own text */
  label: string;
  /** a button with no type inside a form (it submits) */
  inForm: boolean;
}

/** the body of a function of the element, plain JavaScript source (a bundler's helpers do not exist in the page) */
const FACTS_SRC = `
  function cut(s) { return String(s == null ? '' : s).slice(0, 300); }
  function a(n) { return cut(e.getAttribute(n)); }
  var lab = '';
  if (e.id) { var l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) lab = l.textContent; }
  if (!lab && e.closest) { var p = e.closest('label'); if (p) lab = p.textContent; }
  var text = e.tagName === 'INPUT' ? (e.value || '') : (e.textContent || '');
  return {
    tag: e.tagName.toLowerCase(),
    type: a('type').toLowerCase(),
    autocomplete: a('autocomplete').toLowerCase(),
    inputmode: a('inputmode').toLowerCase(),
    name: a('name'),
    id: cut(e.id),
    role: a('role').toLowerCase(),
    label: cut([a('aria-label'), cut(lab), a('placeholder'), a('title'), cut(text)].join(' ')),
    inForm: !!(e.form || (e.closest && e.closest('form')))
  };`;
// built from source at run time (Playwright passes it the element)
const factsFn = new Function('e', FACTS_SRC) as (e: Element) => ElementFacts;

export async function elementFacts(el: ElementHandle): Promise<ElementFacts> {
  return (await el.evaluate(factsFn)) as ElementFacts;
}

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
/** words that make a field a password, code or phone field (any of them in its name, id, label or autocomplete) */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passcode',
  'pass',
  'pwd',
  'otp',
  'totp',
  'onetime',
  'code',
  'verification',
  'verify',
  'pin',
  'phone',
  'tel',
  'telephone',
  'mobile',
  'sms',
  'cell',
  'cc',
  'card',
  'cvc',
  'cvv',
]);
/** words of a control that submits, accepts or moves the sign-up on (en, plus the fil words the owner may see) */
const SUBMIT_WORDS = new Set([
  'submit',
  'next',
  'continue',
  'create',
  'signup',
  'register',
  'join',
  'agree',
  'accept',
  'verify',
  'confirm',
  'send',
  'finish',
  'done',
  'ok',
  'start',
  'susunod',
  'ituloy',
  'gumawa',
  'sumang',
]);

/** why typing into this element is refused in a guided flow, or null */
export function typeRefusal(f: ElementFacts): string | null {
  const ac = f.autocomplete;
  if (f.type === 'password') return 'a password field is only ever the owner’s to fill';
  if (
    ac.includes('new-password') ||
    ac.includes('current-password') ||
    ac.includes('one-time-code') ||
    ac.startsWith('tel') ||
    ac.includes(' tel') ||
    ac.startsWith('cc-')
  )
    return 'a password, code or phone field is only ever the owner’s to fill';
  if (f.type === 'tel') return 'a phone number field is only ever the owner’s to fill';
  if (f.inputmode === 'tel') return 'a phone number field is only ever the owner’s to fill';
  const w = words(`${f.name} ${f.id} ${f.label} ${ac}`);
  // "sign up" pages split words oddly ("signUpPassword", "otpCode"): camelCase parts count too
  const camel = words(`${f.name} ${f.id}`.replace(/([a-z])([A-Z])/g, '$1 $2'));
  if ([...w, ...camel].some((x) => SECRET_WORDS.has(x)))
    return 'a password, code or phone field is only ever the owner’s to fill';
  if (f.inputmode === 'numeric' && f.tag === 'input') return 'a code field is only ever the owner’s to fill';
  return null;
}

/** why clicking this element is refused in a guided flow, or null */
export function clickRefusal(f: ElementFacts): string | null {
  if (f.tag === 'input' && (f.type === 'submit' || f.type === 'image'))
    return 'submitting the sign-up is only ever the owner’s to do';
  if (f.tag === 'button' && (f.type === 'submit' || (f.type === '' && f.inForm)))
    return 'submitting the sign-up is only ever the owner’s to do';
  const w = words(`${f.label} ${f.name} ${f.id}`.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const joined = w.join('');
  if (w.some((x) => SUBMIT_WORDS.has(x)) || joined.includes('signup') || joined.includes('iagree'))
    return 'submitting the sign-up is only ever the owner’s to do';
  return null;
}

/** the fields "Do it with me" may fill, and nothing else */
export type GuidedFieldKind = 'givenName' | 'familyName' | 'username';

/**
 * Where each field is on the service's known sign-up page: fixed selectors first (the page's own names and
 * autocomplete tokens), then a label. A candidate is used only when it is a visible text-like input that no rule
 * above refuses.
 */
const FIELD_SELECTORS: Record<GuidedFieldKind, string[]> = {
  givenName: ['input[name="firstName"]', 'input[autocomplete="given-name"]', 'input[name="given-name"]'],
  familyName: ['input[name="lastName"]', 'input[autocomplete="family-name"]', 'input[name="family-name"]'],
  username: ['input[name="Username"]', 'input[name="username"]', 'input[autocomplete="username"]'],
};
const FIELD_LABELS: Record<GuidedFieldKind, string[]> = {
  givenName: ['First name'],
  familyName: ['Last name', 'Surname'],
  username: ['Username', 'Create a Gmail address'],
};
const TEXTLIKE = new Set(['', 'text', 'email']);

export async function findGuidedField(page: Page, kind: GuidedFieldKind): Promise<ElementHandle | null> {
  const candidates = [
    ...FIELD_SELECTORS[kind].map((s) => page.locator(s)),
    ...FIELD_LABELS[kind].map((l) => page.getByLabel(l, { exact: false })),
  ];
  for (const loc of candidates) {
    const el = await loc
      .first()
      .elementHandle({ timeout: 300 })
      .catch(() => null);
    if (!el) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const f = await elementFacts(el).catch(() => null);
    if (!f || f.tag !== 'input' || !TEXTLIKE.has(f.type) || typeRefusal(f)) continue;
    return el;
  }
  return null;
}
