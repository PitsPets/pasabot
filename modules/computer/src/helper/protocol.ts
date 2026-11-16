/**
 * The private channel between the PasaBot server and "PasaBot Screen Helper" (macOS), the separate app that alone
 * owns Screen Recording and Accessibility. The Swift helper (apps/desktop/macos/ScreenHelper.swift) implements the
 * same rules; `GRANT_VECTOR` below is checked by both test suites so the two never drift.
 *
 * Transport: a unix socket `$PASABOT_HOME/run/screen.sock` (0600, in a 0700 folder; no TCP port), one JSON object
 * per line. Both ends read the per-launch secret from `$PASABOT_HOME/run/screen.key` (0600, 64 hex characters),
 * written fresh by the desktop launcher every time PasaBot starts; agent sandboxes cannot read `$PASABOT_HOME`.
 *
 * 1. The helper greets: `{"hello":"<nonce hex>","v":1}`; the server answers `{"auth":"<hmac hex>"}` with
 *    HMAC-SHA256(key, "hello|<nonce>"). A wrong answer closes the connection. The key never crosses the socket.
 * 2. Requests: `{"id":1,"verb":"click","args":{"x":10,"y":20,"button":"left"},"grant":{...}}`. Answers:
 *    `{"id":1,"ok":true,...}` or `{"id":1,"ok":false,"code":"secure_input","message":"..."}`.
 * 3. Every verb that sees or touches the screen (`ACTION_VERBS`) needs a grant: `{ id, exp, mac }` where `mac` is
 *    HMAC-SHA256(key, canonical) over `grant|<id>|<exp>|<verb>|<args>` (see `canonicalArgs`). The server mints one
 *    only after the owner approved that one action (a tier-3 card, a take-over click, the "Try it" button), it is
 *    good for 30 s and for ONE use: the helper refuses a missing, expired, replayed or mismatched grant.
 * 4. Grant-free verbs only report or reduce: `status` (permission ticks), `stop` (cut control now), `open_settings`
 *    (open one of two fixed System Settings panes). `resume` (lift a stop) needs a grant like an action.
 * The helper also pushes `{"event":"stopped","by":"key"|"menu"|"server"}` when control was cut.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
/** a grant is good for this long after it is minted */
export const GRANT_TTL_MS = 30_000;
/** the helper refuses a grant whose expiry is further out than this (a server clock trick) */
export const GRANT_MAX_AHEAD_MS = 60_000;
/** screenshots are at most this wide (screen points scaled down); actions use screenshot pixels */
export const SHOT_MAX_WIDTH = 1600;

export const ACTION_VERBS = ['screenshot', 'displays', 'move', 'click', 'type', 'key', 'resume'] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];
export const FREE_VERBS = ['status', 'stop', 'open_settings'] as const;
export type FreeVerb = (typeof FREE_VERBS)[number];
export type Verb = ActionVerb | FreeVerb;

export type WireRequest =
  | { verb: 'screenshot'; args: Record<string, never> }
  | { verb: 'displays'; args: Record<string, never> }
  | { verb: 'resume'; args: Record<string, never> }
  | { verb: 'move'; args: { x: number; y: number } }
  | { verb: 'click'; args: { x: number; y: number; button: 'left' | 'right' } }
  | { verb: 'type'; args: { text: string } }
  | { verb: 'key'; args: { keys: string } };

export interface Grant {
  id: string;
  /** ms since the epoch */
  exp: number;
  mac: string;
}

/** why the helper said no; the server turns each into plain words for the owner and the agent */
export type RefusalCode =
  | 'grant_missing'
  | 'grant_invalid'
  | 'grant_expired'
  | 'grant_replayed'
  | 'rate_limited'
  | 'stopped'
  | 'secure_input'
  | 'protected_window'
  /** a long type/key action stopped part-way: the keyboard moved to another app (or the keys would switch apps) */
  | 'focus_moved'
  | 'no_screen_recording'
  | 'no_accessibility'
  | 'bad_request';

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hmacHex = (key: Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('hex');

/** The signed form of a request's arguments: plain fields joined by `|`; typed text only as its SHA-256. */
export function canonicalArgs(r: WireRequest): string {
  switch (r.verb) {
    case 'move':
      return `${r.args.x}|${r.args.y}`;
    case 'click':
      return `${r.args.x}|${r.args.y}|${r.args.button}`;
    case 'type':
      return sha256Hex(r.args.text);
    case 'key':
      return r.args.keys;
    default:
      return '';
  }
}
export const grantMessage = (id: string, exp: number, r: WireRequest) =>
  `grant|${id}|${exp}|${r.verb}|${canonicalArgs(r)}`;
export const helloMessage = (nonce: string) => `hello|${nonce}`;

export function signGrant(key: Buffer, id: string, exp: number, r: WireRequest): Grant {
  return { id, exp, mac: hmacHex(key, grantMessage(id, exp, r)) };
}

/** constant-time compare of two hex strings */
export function sameHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return timingSafeEqual(x, y);
}

/** a key file holds 64 hex characters (32 random bytes) */
export function parseKey(text: string): Buffer {
  const t = text.trim();
  if (t.length !== 64) throw new Error('the screen helper key is not 64 hex characters');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) throw new Error('the screen helper key is not hex');
  }
  return Buffer.from(t, 'hex');
}

/**
 * Shared test vector: the Swift helper's `--selftest` checks the same key, grant and request give this exact mac,
 * so both sides sign the same bytes.
 */
export const GRANT_VECTOR = {
  key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  id: 'g-vector-1',
  exp: 1_900_000_000_000,
  request: { verb: 'type', args: { text: 'héllo' } } as WireRequest,
  message: '',
  mac: '',
};
GRANT_VECTOR.message = grantMessage(GRANT_VECTOR.id, GRANT_VECTOR.exp, GRANT_VECTOR.request);
GRANT_VECTOR.mac = hmacHex(Buffer.from(GRANT_VECTOR.key, 'hex'), GRANT_VECTOR.message);

/** the two System Settings panes the helper may open (it only opens them; the owner flips the switch) */
export const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const;
export type SettingsPane = keyof typeof SETTINGS_PANES;

export interface HelperStatus {
  screenRecording: boolean;
  accessibility: boolean;
  /** control was cut (Esc held, the menu, Stop all) and waits for the owner */
  stopped: boolean;
  /** an action happened in the last few seconds: the border and the menu-bar dot are showing */
  controlling: boolean;
  version: string;
}
