/**
 * The Screen Helper's own guard, as a reference in TypeScript (the fake helper of the tests and the e2e run uses
 * it; ScreenHelper.swift implements the same checks in the same order). It never trusts the server: a request is
 * refused unless it carries a fresh, single-use grant signed for exactly that verb and those arguments, the rate is
 * low enough, control was not stopped, and the screen is not in a state the helper never touches (a password box
 * has the keyboard, a protected window such as System Settings or a keychain prompt is under the pointer).
 */
import {
  ACTION_VERBS,
  type ActionVerb,
  GRANT_MAX_AHEAD_MS,
  type Grant,
  grantMessage,
  hmacHex,
  type RefusalCode,
  sameHex,
  type WireRequest,
} from './protocol.js';

export interface GuardProbes {
  /** macOS: IsSecureEventInputEnabled() or a focused AXSecureTextField */
  secureInput(): boolean;
  /** the window the action lands on (point) or the focused one belongs to a protected app */
  protectedTarget(r: WireRequest): boolean;
  screenRecording(): boolean;
  accessibility(): boolean;
}

export interface GuardOptions {
  now?(): number;
  /** input actions (move/click/type/key) per window; default 8 per 2 s */
  inputBurst?: number;
  inputWindowMs?: number;
  /** screenshots per window; default 6 per 2 s (the live view asks about once a second) */
  shotBurst?: number;
  shotWindowMs?: number;
}

export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

const INPUT = new Set<string>(['move', 'click', 'type', 'key']);
const TYPING = new Set<string>(['type', 'key']);

export class HelperGuard {
  private readonly used = new Map<string, number>();
  private readonly inputTimes: number[] = [];
  private readonly shotTimes: number[] = [];
  stopped = false;

  constructor(
    private readonly key: Buffer,
    private readonly probes: GuardProbes,
    private readonly o: GuardOptions = {},
  ) {}
  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** throws a Refusal, or returns once the request may run (the grant is then spent) */
  check(r: WireRequest, grant: Grant | undefined | null): void {
    if (!(ACTION_VERBS as readonly string[]).includes(r.verb))
      throw new Refusal('bad_request', 'this verb is not one the helper knows');
    const verb = r.verb as ActionVerb;
    const now = this.now();
    // 1. the grant: present, well formed, signed for this exact request, fresh, never used before
    if (
      !grant ||
      typeof grant.id !== 'string' ||
      typeof grant.mac !== 'string' ||
      typeof grant.exp !== 'number'
    )
      throw new Refusal('grant_missing', 'no approval came with this request');
    if (grant.id.length < 8 || grant.id.length > 64)
      throw new Refusal('grant_invalid', 'the approval is not valid');
    const want = hmacHex(this.key, grantMessage(grant.id, grant.exp, r));
    if (!sameHex(want, grant.mac))
      throw new Refusal('grant_invalid', 'the approval does not match this action');
    if (grant.exp <= now) throw new Refusal('grant_expired', 'the approval ran out of time');
    if (grant.exp - now > GRANT_MAX_AHEAD_MS) throw new Refusal('grant_invalid', 'the approval is not valid');
    for (const [id, exp] of this.used) if (exp <= now) this.used.delete(id);
    if (this.used.has(grant.id)) throw new Refusal('grant_replayed', 'this approval was already used');
    this.used.set(grant.id, grant.exp);
    if (verb === 'resume') {
      this.stopped = false;
      return;
    }
    // 2. a stop holds until the owner lifts it
    if (this.stopped) throw new Refusal('stopped', 'control was stopped; the owner has to allow it again');
    // 3. permissions (the helper's own, never the server's)
    if (!this.probes.screenRecording() && (verb === 'screenshot' || verb === 'displays'))
      throw new Refusal('no_screen_recording', 'Screen Recording is off for PasaBot Screen Helper');
    if (INPUT.has(verb) && !this.probes.accessibility())
      throw new Refusal('no_accessibility', 'Accessibility is off for PasaBot Screen Helper');
    // 4. rate
    const isShot = verb === 'screenshot' || verb === 'displays';
    const times = isShot ? this.shotTimes : this.inputTimes;
    const win = isShot ? (this.o.shotWindowMs ?? 2000) : (this.o.inputWindowMs ?? 2000);
    const burst = isShot ? (this.o.shotBurst ?? 6) : (this.o.inputBurst ?? 8);
    while (times.length > 0 && times[0]! <= now - win) times.shift();
    if (times.length >= burst) throw new Refusal('rate_limited', 'too many actions in a short time');
    times.push(now);
    // 5. what the helper never touches
    if (TYPING.has(verb) && this.probes.secureInput())
      throw new Refusal('secure_input', 'a password box has the keyboard: type it yourself');
    if (INPUT.has(verb) && this.probes.protectedTarget(r))
      throw new Refusal('protected_window', 'that is a protected window (settings, a password prompt)');
  }

  stop() {
    this.stopped = true;
  }
}
