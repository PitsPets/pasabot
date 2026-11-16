/**
 * `{{secret:NAME}}` placeholders inside `tools_invoke` arguments (ARCHITECTURE 7.3): an agent names a secret the
 * owner granted to it, and the gateway fills the value in server side, through the run's agent-scoped vault only.
 * A name that is not granted to this agent (or does not exist, or is malformed) fails closed before the outside
 * tool is called. The filled values are redacted back out of whatever the tool returns, and the caller's own
 * arguments (what approvals, events and logs see) keep the placeholder, never the value.
 *
 * Placeholders are found with a plain linear scan (no regex over agent text).
 */
import type { ScopedVault } from '@pasabot/core';

const OPEN = '{{secret:';
const CLOSE = '}}';
const MAX_NAME = 64;
/** at most this many different secrets in one call */
const MAX_REFS = 16;
/** deepest argument nesting walked (arguments are JSON from the agent) */
const MAX_DEPTH = 64;
/**
 * A value shorter than this is never filled in: a short value is too likely to occur by chance in a tool's
 * result, and redacting it there would both mangle the result and point at the value. Every value that does get
 * filled in therefore has every derived form redacted, with no length filter.
 */
export const MIN_SECRET_LENGTH = 8;

export class SecretArgError extends Error {}

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameCode = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 46 || c === 45; // [A-Za-z0-9_.-]
/** the vault's name rule: a letter, then up to 63 of [A-Za-z0-9_.-] */
function validName(n: string): boolean {
  if (n.length === 0 || n.length > MAX_NAME || !isAlpha(n.charCodeAt(0))) return false;
  for (let i = 1; i < n.length; i++) if (!isNameCode(n.charCodeAt(i))) return false;
  return true;
}

/** Every `{{secret:…}}` in one string: [start, end, name] (end exclusive). */
function scan(s: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  let from = 0;
  for (;;) {
    const at = s.indexOf(OPEN, from);
    if (at < 0) return out;
    const close = s.indexOf(CLOSE, at + OPEN.length);
    if (close < 0) return out;
    out.push([at, close + CLOSE.length, s.slice(at + OPEN.length, close)]);
    from = close + CLOSE.length;
  }
}

function walk(v: unknown, depth: number, onString: (s: string) => string): unknown {
  if (depth > MAX_DEPTH) throw new SecretArgError('the arguments are nested too deeply');
  if (typeof v === 'string') return onString(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, onString));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1, onString);
    return out;
  }
  return v;
}

/**
 * The forms a value may take on its way back (as is, JSON-escaped, URL-encoded, base64, base64url). No length
 * filter: values are at least `MIN_SECRET_LENGTH` long, so no form is ever empty or trivially short.
 */
function forms(v: string): string[] {
  const b64 = Buffer.from(v, 'utf8').toString('base64');
  const all = [
    v,
    JSON.stringify(v).slice(1, -1),
    encodeURIComponent(v),
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(v, 'utf8').toString('base64url'),
  ];
  return [...new Set(all)].filter((f) => f.length > 0);
}

export interface FilledArgs {
  /** a fresh copy with every placeholder filled in; the input is never changed */
  args: Record<string, unknown>;
  /** names that were filled in (for the audit trail and the tool result) */
  names: string[];
  /** replaces every filled value (and its encoded forms) with `[secret:NAME]` in a string */
  redact(text: string): string;
  /** the same, through a JSON-able value */
  redactDeep<T>(value: T): T;
}

/**
 * Fill `{{secret:NAME}}` placeholders in tool arguments from the agent's own vault scope. Throws `SecretArgError`
 * (nothing is filled, nothing is sent) for a malformed name or one this agent is not granted.
 */
export async function fillSecretArgs(args: Record<string, unknown>, vault: ScopedVault): Promise<FilledArgs> {
  const wanted = new Set<string>();
  walk(args, 0, (s) => {
    for (const [, , name] of scan(s)) wanted.add(name);
    return s;
  });
  const identity: FilledArgs = {
    args,
    names: [],
    redact: (t) => t,
    redactDeep: (x) => x,
  };
  if (wanted.size === 0) return identity;
  if (wanted.size > MAX_REFS) throw new SecretArgError(`too many secrets in one call (at most ${MAX_REFS})`);

  const values = new Map<string, string>();
  for (const name of wanted) {
    if (!validName(name))
      throw new SecretArgError(
        `"${OPEN}${name.slice(0, MAX_NAME)}${CLOSE}" is not a valid secret name; nothing was sent`,
      );
    let value: string;
    try {
      value = await vault.resolve(`${OPEN}${name}${CLOSE}`);
    } catch {
      // unknown and not granted read the same: the agent learns nothing about other agents' secrets
      throw new SecretArgError(
        `no secret named "${name}" is granted to you; ask the owner to grant it in Settings → Vault (nothing was sent)`,
      );
    }
    if (value.length < MIN_SECRET_LENGTH)
      throw new SecretArgError(
        `the secret "${name}" is too short to send safely (under ${MIN_SECRET_LENGTH} characters); ask the owner to store a longer value for it in Settings → Vault (nothing was sent)`,
      );
    values.set(name, value);
  }

  const filled = walk(args, 0, (s) => {
    const hits = scan(s);
    if (hits.length === 0) return s;
    let out = '';
    let last = 0;
    for (const [start, end, name] of hits) {
      out += s.slice(last, start) + values.get(name)!;
      last = end;
    }
    return out + s.slice(last);
  }) as Record<string, unknown>;

  const pairs: [string, string][] = [];
  for (const [name, v] of values) for (const f of forms(v)) pairs.push([f, `[secret:${name}]`]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const redact = (text: string) => {
    let out = text;
    for (const [f, label] of pairs) if (out.includes(f)) out = out.split(f).join(label);
    return out;
  };
  return {
    args: filled,
    names: [...values.keys()],
    redact,
    // as JSON text, so any nesting depth is covered (a label never breaks the JSON: no quotes or backslashes)
    redactDeep: <T>(x: T) => {
      if (x === undefined) return x;
      const text = redact(JSON.stringify(x));
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    },
  };
}
