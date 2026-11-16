/**
 * Shared bits of the agent verbs (W21): argv flags, the local automation-token store and the automation HTTP calls.
 * Not a verb itself (no default export), so the command loader skips it.
 *
 * Tokens live in `$XDG_CONFIG_HOME/pasabot/automation.json` (0600, folder 0700), keyed by server URL + agent slug,
 * never in argv. `PASABOT_AUTOMATION_TOKEN` overrides the store (a script on another machine with a `remote_ok`
 * token). Automation requests never send an `Origin` header: the server refuses a token that carries one.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSession, serverUrl } from '../../command.js';

export interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}
/** `--name value`, `--name=value` and bare `--switch` (names listed in `bool`); the rest are positionals. */
export function parseFlags(args: string[], bool: string[] = []): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) out[name] = a.slice(eq + 1);
    else if (bool.includes(name)) out[name] = true;
    else {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
      out[name] = v;
      i++;
    }
  }
  return out;
}

export const baseUrl = () => readSession()?.url ?? serverUrl();

/**
 * Text from someone else (a phone's device name) made safe to print on a terminal: control characters (C0, DEL,
 * C1), format characters (bidi overrides, zero-width) and line/paragraph separators become a visible `\u{…}`, so
 * the text can never move the cursor, clear or redraw a line, retitle the terminal or plant a link. Capped at 120.
 */
export function safeText(s: unknown, max = 120): string {
  const t = String(s ?? '').replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
  );
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** True when the URL's host is this machine (a phone cannot open it). */
export function isLoopbackUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === '::' ||
    /^127\.\d+\.\d+\.\d+$/.test(h)
  );
}

interface StoredToken {
  url: string;
  slug: string;
  id: string;
  token: string;
}
const storePath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pasabot', 'automation.json');
export function readTokens(): StoredToken[] {
  try {
    const j = JSON.parse(readFileSync(storePath(), 'utf8')) as { tokens?: StoredToken[] };
    return Array.isArray(j.tokens) ? j.tokens : [];
  } catch {
    return [];
  }
}
export function writeTokens(tokens: StoredToken[]) {
  mkdirSync(dirname(storePath()), { recursive: true, mode: 0o700 });
  writeFileSync(storePath(), JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
  chmodSync(storePath(), 0o600);
}
export function saveToken(t: StoredToken) {
  writeTokens([...readTokens().filter((x) => !(x.url === t.url && x.slug === t.slug)), t]);
}
export function forgetToken(id: string) {
  writeTokens(readTokens().filter((x) => x.id !== id));
}
/** The token to use for an agent: the environment's, else the stored one for this server. */
export function tokenFor(slug: string): { token: string; url: string } | null {
  const env = process.env.PASABOT_AUTOMATION_TOKEN;
  if (env) return { token: env, url: process.env.PASABOT_URL ? serverUrl() : baseUrl() };
  const url = baseUrl();
  const t =
    readTokens().find((x) => x.slug === slug && x.url === url) ?? readTokens().find((x) => x.slug === slug);
  return t ? { token: t.token, url: t.url } : null;
}

/** One automation request: bearer only, no Origin, JSON in and out. */
export async function automationApi(
  t: { token: string; url: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const r = await fetch(`${t.url}/api/m/automation${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json, headers: r.headers };
}

/** A plain-words reason for a refused automation request. */
export function refusal(status: number, json: any): string {
  if (status === 401)
    return 'the server refused the token (revoked, expired, or not allowed from this address)';
  if (status === 429)
    return `this token's run budget is used up; try again in ${json?.retryAfterSec ?? '?'} s`;
  if (json?.error === 'automation_off') return 'automation is off for this agent (Settings → Automation)';
  return json?.message ?? json?.error ?? `HTTP ${status}`;
}
