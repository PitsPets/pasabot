/**
 * A stand-in `ManagedBrowserPort` for W30 tests (the real one, in the browser module, runs Chromium and is proven in
 * `modules/browser/src/port.test.ts`). It loads the local fixture store's pages over loopback HTTP, reads their
 * JSON-LD, meta tags and `#id` selectors with plain string scans, keeps the port's contract (allowedHosts before and
 * after navigation; refuses card/password fields and money controls) and records every call. Test-only code.
 */
import type { BrowserPageData, BrowserPortActor, ManagedBrowserPort } from '@pasabot/core';

const between = (s: string, a: string, b: string, from = 0): [string, number] | null => {
  const i = s.indexOf(a, from);
  if (i < 0) return null;
  const j = s.indexOf(b, i + a.length);
  if (j < 0) return null;
  return [s.slice(i + a.length, j), j + b.length];
};
const attr = (tag: string, name: string) => between(tag, `${name}="`, '"')?.[0] ?? null;

function hostOk(raw: string, patterns: readonly string[]) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const h = u.hostname;
  return patterns.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
}

export class FakeBrowser implements ManagedBrowserPort {
  url = 'about:blank';
  html = '';
  readonly calls: { op: string; actor: BrowserPortActor; arg?: string }[] = [];
  readonly fields = new Map<string, string>();
  /** a test may hold every read here (e.g. to stop everything while a Buy runs) */
  gate: Promise<void> | null = null;
  /** the profile may hold the owner's sign-ins (the real port's `logged_in`) */
  loggedIn = false;

  profileInfo() {
    return { id: 'fake-profile', loggedIn: this.loggedIn };
  }
  /** the real port's rule: an agent on a signed-in profile needs the call cleared at tier 3 */
  private gateAgent(actor: BrowserPortActor, approvedTier?: number) {
    if (actor.kind === 'agent' && this.loggedIn && (approvedTier ?? 0) < 3)
      throw new Error(
        'this browser profile may hold the owner’s sign-ins, so an agent needs the owner’s approval to use it',
      );
  }

  private async load(url: string, init?: RequestInit) {
    let next = url;
    let opts = init;
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(next, { ...opts, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        next = new URL(r.headers.get('location')!, next).href;
        opts = undefined;
        continue;
      }
      this.url = next;
      this.html = await r.text();
      return;
    }
    throw new Error('too many redirects');
  }
  private data(selectors: Record<string, string>): BrowserPageData {
    const h = this.html;
    const jsonLd: string[] = [];
    let at = 0;
    for (;;) {
      const m = between(h, '<script type="application/ld+json">', '</script>', at);
      if (!m) break;
      jsonLd.push(m[0]);
      at = m[1];
    }
    const meta: { key: string; value: string }[] = [];
    at = 0;
    for (;;) {
      const m = between(h, '<meta ', '>', at);
      if (!m) break;
      const key = attr(m[0], 'property') ?? attr(m[0], 'name');
      const value = attr(m[0], 'content');
      if (key && value !== null) meta.push({ key, value });
      at = m[1];
    }
    const selected: Record<string, string | null> = {};
    for (const [k, css] of Object.entries(selectors)) {
      const id = css.startsWith('#') ? css.slice(1) : null;
      const m = id ? between(h, `id="${id}"`, '<') : null;
      selected[k] = m ? m[0].slice(m[0].indexOf('>') + 1).trim() : null;
    }
    const title = between(h, '<title>', '</title>')?.[0] ?? '';
    return {
      url: this.url,
      title,
      jsonLd,
      meta,
      microdata: [],
      selected,
      signals: {
        captcha: h.includes('captcha'),
        cardField: h.includes('cc-number'),
        signIn: h.includes('type="password"'),
      },
    };
  }
  async read(actor: BrowserPortActor, o: Parameters<ManagedBrowserPort['read']>[1]) {
    this.calls.push({ op: 'read', actor, ...(o.url ? { arg: o.url } : {}) });
    this.gateAgent(actor, o.approvedTier);
    if (this.gate) await this.gate;
    if (o.url !== undefined) {
      if (!hostOk(o.url, o.allowedHosts)) throw new Error('that address is not allowed');
      await this.load(o.url);
    }
    if (!hostOk(this.url, o.allowedHosts)) throw new Error('the page is not on an allowed address');
    return this.data(o.selectors ?? {});
  }
  async fill(actor: BrowserPortActor, o: Parameters<ManagedBrowserPort['fill']>[1]) {
    this.calls.push({ op: 'fill', actor, arg: `${o.selector}=${o.value}` });
    this.gateAgent(actor, o.approvedTier);
    if (!hostOk(this.url, o.allowedHosts)) throw new Error('the page is not on an allowed address');
    const id = o.selector.slice(1);
    const tag = between(this.html, `id="${id}"`, '>')?.[0] ?? '';
    if (tag.includes('cc-') || tag.includes('password') || tag.includes('card'))
      throw new Error('card, bank, password and one-time-code fields are only ever the owner’s to fill');
    this.fields.set(attr(`x ${tag}`, 'name') ?? id, o.value);
  }
  async click(actor: BrowserPortActor, o: Parameters<ManagedBrowserPort['click']>[1]) {
    this.calls.push({ op: 'click', actor, arg: o.selector });
    this.gateAgent(actor, o.approvedTier);
    if (!hostOk(this.url, o.allowedHosts)) throw new Error('the page is not on an allowed address');
    const id = o.selector.slice(1);
    const label = between(this.html, `id="${id}"`, '</')?.[0] ?? '';
    if (label.toLowerCase().includes('place order') || label.toLowerCase().includes('pay'))
      throw new Error(
        'paying, placing an order or anything on a payment page is only ever the owner’s to do',
      );
    // the fixture's add-to-cart form
    const form = between(this.html, '<form method="post" action="', '"')?.[0];
    if (!form) throw new Error('that control is not on the page');
    const body = new URLSearchParams([...this.fields.entries()]);
    await this.load(new URL(form, this.url).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }
  async handOver(actor: BrowserPortActor, o: { profile?: string; reason: string; approvedTier?: number }) {
    this.gateAgent(actor, o.approvedTier);
    this.calls.push({ op: 'handOver', actor, arg: o.reason });
    // as the real port: a handed-over profile counts as owner-driven from now on
    this.loggedIn = true;
    return { profileId: 'fake-profile' };
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
}
