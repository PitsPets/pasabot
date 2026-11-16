/**
 * The guided email setup (ws/email) as a server-side state machine: "connect my own email" (pick the service, type
 * the address, make an app password, paste it, choose what helpers may do, a tiny test) and "make a new email" (the
 * main helper's checklist: address ideas, the owner signs up at Gmail in their own browser, then the same connect
 * steps). The state lives on the server so a reload, a second tab or an app restart resumes at the same step; it
 * never holds a password or code (the code goes from the connect route straight to the vault).
 *
 * Also the plain reason for a failed sign-in check: what the mail server said, mapped to a few things an owner can
 * act on. The server's own words are matched here and never shown, stored or logged.
 */
import { addressIdeas, isNamedService, looksLikeAddress, SERVICE_IDS, type ServiceId } from './providers.js';

export type GuideMode = 'new' | 'connect';
export type GuideStep =
  | 'service'
  | 'ideas'
  | 'signup'
  | 'address'
  | 'guide'
  | 'code'
  | 'manual'
  | 'access'
  | 'test'
  | 'done';
export type Access = 'read' | 'draft' | 'send';
export const ACCESS: readonly Access[] = ['read', 'draft', 'send'];

export interface Guide {
  id: string;
  mode: GuideMode;
  step: GuideStep;
  service: ServiceId | null;
  address: string | null;
  /** address ideas for a new Gmail, from the business or team name the owner typed (ideas only: nothing checks
   *  whether one is free) */
  ideas: string[];
  /** the business or team name the ideas came from (typed by the owner on the ideas step) */
  teamName?: string | null;
  /** the chat the helper's checklist card is in, and the helper that posted it */
  chatId: string | null;
  agentId: string | null;
  messageId: string | null;
  access: Access | null;
  connectedAt: number | null;
  /**
   * The tiny test: a word the owner puts in the subject of a mail they send to the mailbox, and when the test step
   * opened. Only a mail with that word, dated after that, counts as theirs (a newsletter that happens to arrive does
   * not). Set by the server when the guide reaches the test step.
   */
  testWord?: string | null;
  testSince?: number | null;
  /**
   * W43 "Do it with me": the main helper's own browser has the service's sign-up page open with the names and the
   * address idea the owner confirmed filled in (`yours`: the owner's turn for the password and the phone check;
   * `taken`: the owner drives it). No name, password or code is kept here.
   */
  withMe?: { profileId: string; state: 'yours' | 'taken'; idea: string; cardId: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

export type GuideAction =
  | { do: 'next' }
  | { do: 'back' }
  | { do: 'service'; service: string }
  | { do: 'address'; address: string }
  | { do: 'access'; access: string }
  /** the ideas step: the business or team name to make address ideas from */
  | { do: 'name'; name: string }
  /** server only: the sign-in check passed (code step) or the manual form was saved (manual step) */
  | { do: 'connected' };

export class GuideError extends Error {
  constructor(
    readonly code: 'bad_step' | 'bad_address' | 'bad_service' | 'bad_access' | 'bad_name',
    message: string,
  ) {
    super(message);
  }
}

/** the steps one guide walks, in order (the path depends on the mode and the service) */
export function path(g: Pick<Guide, 'mode' | 'service'>): GuideStep[] {
  const tail: GuideStep[] = ['access', 'test', 'done'];
  if (g.mode === 'new') return ['ideas', 'signup', 'address', 'guide', 'code', ...tail];
  if (g.service === 'other') return ['service', 'manual', ...tail];
  return ['service', 'address', 'guide', 'code', ...tail];
}

export function newGuide(o: {
  id: string;
  mode: GuideMode;
  now: number;
  chatId?: string | null;
  agentId?: string | null;
}): Guide {
  return {
    id: o.id,
    mode: o.mode,
    step: o.mode === 'new' ? 'ideas' : 'service',
    service: o.mode === 'new' ? 'gmail' : null,
    address: null,
    ideas: [],
    teamName: null,
    chatId: o.chatId ?? null,
    agentId: o.agentId ?? null,
    messageId: null,
    access: null,
    connectedAt: null,
    testWord: null,
    testSince: null,
    createdAt: o.now,
    updatedAt: o.now,
  };
}

/** One step of the guide; throws GuideError when the action does not fit the step it is on. */
export function advanceGuide(g: Guide, a: GuideAction, now: number): Guide {
  const steps = path(g);
  const at = steps.indexOf(g.step);
  const to = (step: GuideStep, patch: Partial<Guide> = {}): Guide => ({
    ...g,
    ...patch,
    step,
    updatedAt: now,
  });
  const wrong = () => new GuideError('bad_step', `"${a.do}" does not fit the step "${g.step}"`);
  switch (a.do) {
    case 'service': {
      // on the address step too: "that looks like a Yahoo address, switch?" picks the other service in place
      if (g.step !== 'service' && !(g.step === 'address' && g.mode === 'connect')) throw wrong();
      if (!SERVICE_IDS.includes(a.service as ServiceId))
        throw new GuideError('bad_service', 'not a mail service PasaBot knows');
      const service = a.service as ServiceId;
      return to(service === 'other' ? 'manual' : 'address', { service });
    }
    case 'address': {
      if (g.step !== 'address') throw wrong();
      if (!looksLikeAddress(a.address)) throw new GuideError('bad_address', 'not an email address');
      return to('guide', { address: a.address.trim().toLowerCase() });
    }
    case 'next': {
      // only the steps whose whole job is reading and doing something outside PasaBot move on with "Done"
      if (g.step === 'ideas' || g.step === 'signup' || g.step === 'guide' || g.step === 'test')
        return to(steps[at + 1]!);
      throw wrong();
    }
    case 'connected': {
      if (g.step !== 'code' && g.step !== 'manual') throw wrong();
      return to('access', { connectedAt: now });
    }
    case 'name': {
      if (g.step !== 'ideas') throw wrong();
      const name = a.name.normalize('NFC').trim();
      const control = [...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
      if (!name || [...name].length > 60 || control || /[<>{}`]/.test(name))
        throw new GuideError('bad_name', 'not a name');
      return to('ideas', { teamName: name, ideas: addressIdeas([name]) });
    }
    case 'access': {
      if (g.step !== 'access') throw wrong();
      if (!ACCESS.includes(a.access as Access)) throw new GuideError('bad_access', 'not a choice');
      return to('test', { access: a.access as Access, testSince: now });
    }
    case 'back': {
      // the helper's browser is open on the sign-up: Done (or I'll do it myself) closes that first
      if (g.withMe) return g;
      // once the mailbox is connected the way back stops at "what helpers may do"; before that, one step back
      if (at <= 0 || g.step === 'access' || g.step === 'done') return g;
      const prev = steps[at - 1]!;
      // back to the service tiles from the manual form or the address: the service is picked again
      if (prev === 'service') return to('service', { service: null });
      return to(prev);
    }
  }
}

/**
 * Whether a helper's send tool may get as far as an approval card. Fails closed: only the owner's own explicit
 * "send after I approve" lets it through; read only, read and draft, and anything unknown or missing (`null`) do not.
 */
export const maySend = (access: Access | null | undefined): boolean => access === 'send';

/** the tiny test's word: two short words run together, letters only (easy on a phone, never masked as a code) */
const TEST_FIRST = ['blue', 'red', 'green', 'sunny', 'happy', 'lucky', 'little', 'big'] as const;
const TEST_LAST = ['mango', 'papaya', 'banana', 'lemon', 'guava', 'melon', 'coconut', 'kiwi'] as const;
export function testWordFrom(rand: () => number = Math.random): string {
  const pick = <X>(xs: readonly X[]) => xs[Math.floor(rand() * xs.length) % xs.length]!;
  return `${pick(TEST_FIRST)}${pick(TEST_LAST)}`;
}
/** a received mail is the owner's test mail when its subject or text carries the word (any case, spaces ignored) */
export function carriesTestWord(word: string, subject: string, text: string): boolean {
  const w = word.toLowerCase();
  const flat = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  return flat(subject).includes(w) || flat(text.slice(0, 4000)).includes(w);
}

// ---------- why a sign-in check failed ----------

export type ConnectReason = 'wrong_code' | 'two_step_off' | 'imap_off' | 'no_internet' | 'server_trouble';

const NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ETIMEDOUT',
  'timeout',
]);

/**
 * A failed IMAP or SMTP sign-in check as one plain reason. `serverText` is what the server answered with its refusal
 * (e.g. an IMAP `NO [AUTHENTICATIONFAILED] ...`); network errors carry a Node or safe-net code.
 */
export function reasonFor(e: unknown): ConnectReason {
  const code = String((e as { code?: unknown })?.code ?? '');
  if (NET_CODES.has(code)) return 'no_internet';
  // safe-net wraps a socket error on the way to TLS (`tls_failed`); its words still say the network failed
  const msg = String((e as { message?: unknown })?.message ?? '');
  if (
    /\b(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(msg)
  )
    return 'no_internet';
  if (code === 'auth_failed') {
    const said = String((e as { serverText?: unknown }).serverText ?? '');
    if (/not enabled for imap|imap (access )?(is )?(disabled|turned off|not enabled)|enable imap/i.test(said))
      return 'imap_off';
    if (
      /webalert|log ?in via your web browser|web login required|two[- ]step|2[- ]step|less secure|turn on 2/i.test(
        said,
      )
    )
      return 'two_step_off';
    return 'wrong_code';
  }
  return 'server_trouble';
}

/** a service id from a request, when it is one of the named ones */
export const namedOrNull = (id: unknown) => (isNamedService(id) ? id : null);
