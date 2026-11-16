/**
 * Always-ask action classes (ARCHITECTURE 7.1): the card facts a call's arguments give, the payment-method mask and
 * the conservative default classifier for outside MCP tools. Pure functions with no regular expressions (they read
 * agent- and server-supplied text on the main thread), so every scan here is a linear character walk.
 */
import { ACTION_CLASS_FIELDS, type ActionClass, type ApprovalAsk } from '@pasabot/protocol';

/** argument names (lowercase, `_`/`-`/space dropped) that give each card fact, best first */
const ALIASES: Record<string, readonly string[]> = {
  recipients: [
    'to',
    'recipients',
    'recipient',
    'cc',
    'bcc',
    'email',
    'emails',
    'emailaddress',
    'address',
    'phone',
    'phonenumber',
    'number',
    'user',
    'userid',
    'username',
    'users',
    'chatid',
    'peer',
    'handle',
    'contact',
    'contacts',
    'attendees',
    'invitees',
    'target',
  ],
  channel: [
    'channel',
    'channelid',
    'channelname',
    'room',
    'conversation',
    'platform',
    'service',
    'via',
    'repo',
  ],
  subject: ['subject', 'title', 'topic', 'headline'],
  text: [
    'text',
    'body',
    'message',
    'content',
    'msg',
    'markdown',
    'html',
    'comment',
    'caption',
    'note',
    'description',
  ],
  items: ['items', 'item', 'lineitems', 'products', 'product', 'sku', 'skus', 'cart', 'plan', 'quantity'],
  merchant: ['merchant', 'store', 'shop', 'seller', 'vendor', 'payee', 'site', 'domain'],
  total: ['total', 'amount', 'price', 'sum', 'cost', 'value', 'grandtotal'],
  currency: ['currency', 'currencycode', 'curr'],
  paymentMethod: [
    'paymentmethod',
    'paymentmethodid',
    'payment',
    'card',
    'cardnumber',
    'method',
    'source',
    'wallet',
    'account',
    'fromaccount',
  ],
  target: [
    'path',
    'paths',
    'file',
    'files',
    'filepath',
    'target',
    'table',
    'id',
    'ids',
    'name',
    'url',
    'slug',
  ],
  where: ['where', 'location', 'server', 'connector', 'scope', 'bucket', 'folder', 'directory', 'dir'],
  count: ['count', 'howmany'],
};

const normKey = (k: string) => {
  let out = '';
  for (const ch of k.toLowerCase()) if (ch !== '_' && ch !== '-' && ch !== ' ' && ch !== '.') out += ch;
  return out;
};

const MAX_FACT = 500;
const MAX_TEXT = 20_000;

/** A value as card text; an object is shown as compact JSON. */
function asText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (Array.isArray(v)) s = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  else s = JSON.stringify(v);
  s = s.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * A payment method as a label, never the number: any run of 12+ digits (spaces and dashes allowed between them)
 * becomes `•••• <last 4>`; a payment object shows its label/brand/type/name and last 4 only, and those label fields
 * are masked the same way (an agent can put a whole card number in `name`); `last4` keeps at most its last 4 digits.
 */
export function maskPaymentLabel(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const rawLabel = asText(o.label ?? o.brand ?? o.type ?? o.name, 200);
    const label = rawLabel ? asText(maskDigitRuns(rawLabel, 6).trim(), 60) : null;
    let lastDigits = '';
    for (const ch of asText(o.last4 ?? o.lastFour ?? o.last_four, 200) ?? '')
      if (isDigit(ch)) lastDigits += ch;
    const last4 = lastDigits.slice(-4);
    const parts = [label, last4 ? `•••• ${last4}` : null].filter(Boolean);
    if (parts.length) return parts.join(' ');
    const num = o.number ?? o.cardNumber ?? o.card_number;
    return num === undefined ? '•••• (details hidden)' : maskPaymentLabel(num);
  }
  const s = asText(v, 200);
  if (!s) return null;
  return maskDigitRuns(s, 6).trim();
}

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
/** a letter in any script (a character with distinct cases, or a non-ASCII one), as opposed to punctuation/space */
const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase() || ch.charCodeAt(0) > 0x7f;

/**
 * Linear walk that collapses digit runs that may be card or account numbers: any non-letter, non-digit characters
 * between digits (space, `-`, `.`, `/`, …) count as part of the run, so `4111.1111.1111.1111` is one run. A run of
 * 12+ digits becomes `•••• <last 4>`; with `short` set, a run of `short`..11 digits becomes `••<last 2>`.
 */
export function maskDigitRuns(s: string, short = 0): string {
  return maskRuns(s, (digits) =>
    digits.length >= 12
      ? `•••• ${digits.slice(-4)}`
      : short && digits.length >= short
        ? `••${digits.slice(-2)}`
        : null,
  );
}

/** Luhn check of a digit string (what every payment card number passes) */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let k = 0; k < digits.length; k++) {
    let d = digits.charCodeAt(digits.length - 1 - k) - 48;
    if (k % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
const isCardDigits = (digits: string) => digits.length >= 13 && digits.length <= 19 && luhn(digits);

/**
 * Only the digit runs that are payment card numbers (13 to 19 digits that pass the Luhn check, separated as
 * `maskDigitRuns` allows) become `•••• <last 4>`. An amount, a smallest-unit amount, an IBAN or an account number
 * the owner must see stays as written.
 */
export function maskCardRuns(s: string): string {
  return maskRuns(s, (digits) => (isCardDigits(digits) ? `•••• ${digits.slice(-4)}` : null));
}

/** the walk of `maskDigitRuns`: each digit run is replaced by what `mask` returns, or kept when it returns null */
function maskRuns(s: string, mask: (digits: string) => string | null): string {
  let out = '';
  let digits = '';
  let raw = ''; // the run as written, separators included (kept when the run is not masked)
  let pending = ''; // separators seen after the run's last digit
  const flush = () => {
    out += (digits ? mask(digits) : null) ?? raw;
    out += pending;
    digits = '';
    raw = '';
    pending = '';
  };
  for (const ch of s) {
    if (isDigit(ch)) {
      digits += ch;
      raw += pending + ch;
      pending = '';
    } else if (digits && !isLetter(ch)) pending += ch;
    else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

/** argument names whose value is a card number: masked whatever its digits (`maskPaymentLabel`) */
const CARD_KEYS = new Set(['card', 'cardnumber', 'creditcard', 'debitcard', 'ccnumber', 'pan']);
/** a card's security code or PIN: never shown at all */
const CODE_KEYS = new Set(['cvc', 'cvv', 'cvc2', 'cvv2', 'csc', 'securitycode', 'pin']);
/** objects that hold a payment instrument: inside them `number` is the card number too */
const PAYMENT_KEYS = new Set([...CARD_KEYS, 'payment', 'paymentmethod', 'paymentdetails', 'paymentinfo']);
/** amounts and their units: never masked when the value is an amount (outside a payment object) */
const AMOUNT_KEYS = new Set([...ALIASES.total!, ...ALIASES.currency!, 'quantity', 'qty']);
/**
 * who gets the money: a recipient, payee, merchant or their account/IBAN. Never card-masked, decided by key name
 * (outside a payment object), so the owner always sees where the money goes; only payment instruments are masked.
 */
const RECIPIENT_KEYS = new Set([
  'to',
  'recipient',
  'recipients',
  'recipientaccount',
  'recipientiban',
  'recipientname',
  'payee',
  'payeeaccount',
  'payeeiban',
  'payeename',
  'beneficiary',
  'beneficiaryaccount',
  'beneficiaryiban',
  'beneficiaryname',
  'iban',
  'toiban',
  'toaccount',
  'destination',
  'destinationaccount',
  'bic',
  'swift',
  'swiftcode',
  'routingnumber',
  'sortcode',
  'accountholder',
  ...ALIASES.merchant!,
]);
/** card facts that name who gets the money: never card-masked */
const RECIPIENT_FACTS = new Set(['merchant', 'recipients']);

const AMOUNT_SEPARATORS = new Set([',', '.', ' ', '\u00a0', '\u202f', "'", '_']);
const CURRENCY_SYMBOLS = new Set([...'$€£¥₱₹₩₽₺₫₦₴₪฿¢₿₡₲₵₸₭₮₼₾﷼']);
const isUpper = (ch: string) => ch >= 'A' && ch <= 'Z';
/** smallest units and crypto codes that are not 3-letter ISO codes (compared lowercase) */
const CURRENCY_UNITS = new Set([
  'sat',
  'sats',
  'msat',
  'msats',
  'satoshi',
  'satoshis',
  'wei',
  'gwei',
  'lamports',
]);
const CURRENCY_CODES4 = new Set(['USDT', 'USDC', 'DOGE']);
/**
 * a currency next to an amount: a 3-letter ISO code (`PHP`), a known unit (`sats`, `wei`), or a symbol with at most
 * 3 capital letters before it (`₱`, `US$`). Any other word (`card`, `Visa`) is not, so `card 4111…` is no amount.
 */
const isCurrencyToken = (s: string) => {
  if (CURRENCY_UNITS.has(s.toLowerCase()) || CURRENCY_CODES4.has(s)) return true;
  if (s.length === 3 && [...s].every(isUpper)) return true;
  const chars = [...s];
  const sym = chars[chars.length - 1]!;
  return CURRENCY_SYMBOLS.has(sym) && chars.length <= 4 && chars.slice(0, -1).every(isUpper);
};

/** digit groups that read as one integer: 1-3 digits, then groups of 2 or 3 (lakh style allowed), ending in 3 */
const isGrouped = (groups: string[]) =>
  groups.length === 1 ||
  (groups[0]!.length >= 1 &&
    groups[0]!.length <= 3 &&
    groups.slice(1, -1).every((g) => g.length === 2 || g.length === 3) &&
    groups[groups.length - 1]!.length === 3);

/**
 * Whether a value reads as a money amount: an optional sign and currency (code or symbol, before or after), then
 * plain digits or thousands-grouped digits with one kind of separator, and an optional decimal part. `49.00 USD`,
 * `₱1,299.50`, `250000000000 sats` and `1.000.000,00 €` are amounts; `4111 1111 1111 1111`, `card 4111…` and any
 * other text are not. A linear walk, no regular expression.
 */
export function isMoneyAmount(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  let s = v.trim();
  if (!s || s.length > 80) return false;
  // currency before and after (with or without a space), then a sign
  const stripCurrency = (fromStart: boolean) => {
    let k = fromStart ? 0 : s.length;
    if (fromStart)
      while (k < s.length && !isDigit(s[k]!) && s[k] !== '-' && s[k] !== '+' && s[k] !== ' ') k++;
    else while (k > 0 && !isDigit(s[k - 1]!) && s[k - 1] !== ' ') k--;
    const tok = fromStart ? s.slice(0, k) : s.slice(k);
    if (!tok) return true;
    if (!isCurrencyToken(tok)) return false;
    s = (fromStart ? s.slice(k) : s.slice(0, k)).trim();
    return true;
  };
  if (s[0] === '-' || s[0] === '+') s = s.slice(1).trim();
  if (!stripCurrency(true)) return false;
  if (s[0] === '-' || s[0] === '+') s = s.slice(1).trim();
  if (!stripCurrency(false)) return false;
  if (!s || !isDigit(s[0]!) || !isDigit(s[s.length - 1]!)) return false;
  const groups: string[] = [];
  const seps: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (isDigit(ch)) cur += ch;
    else if (AMOUNT_SEPARATORS.has(ch) && cur) {
      groups.push(cur);
      seps.push(ch);
      cur = '';
    } else return false;
  }
  groups.push(cur);
  if (groups.length === 1) return true;
  const same = (xs: string[]) => xs.every((x) => x === xs[0]);
  // no decimal part: one kind of separator between thousands groups
  if (same(seps) && isGrouped(groups)) return true;
  // a decimal part: `.` or `,` before the last group, different from the thousands separator (if any)
  const dec = seps[seps.length - 1]!;
  if (dec !== '.' && dec !== ',') return false;
  const intSeps = seps.slice(0, -1);
  if (intSeps.length && (!same(intSeps) || intSeps[0] === dec)) return false;
  return isGrouped(groups.slice(0, -1));
}

/**
 * A money card's summary fact as stored and served: the total stays as given only when it reads as an amount
 * (`isMoneyAmount`), otherwise it is masked like any other fact; who gets the money (`merchant`) is never masked;
 * the payment method is masked as a label (`maskDigitRuns`); other facts mask card numbers (`maskCardRuns`).
 */
export function maskMoneyFact(key: string, v: string): string {
  if (key === 'total' && isMoneyAmount(v)) return v;
  if (RECIPIENT_FACTS.has(key)) return v;
  if (key === 'paymentMethod') return maskDigitRuns(v);
  return maskCardRuns(v);
}

/**
 * A money call's arguments as an always-ask approval stores and serves them: a payment instrument never reaches the
 * approvals row or the clients in clear, and what the owner approves stays readable. By key: a card number argument
 * (`card`, `cardNumber`, `pan`, or `number` inside a payment object) shows a label and its last 4, a security code
 * or PIN shows `•••`. Anywhere else a card number (Luhn-valid, 13 to 19 digits, `maskCardRuns`) is masked, except
 * under an amount key (`total`, `amount`, `price`, `currency`, …) whose value is an amount (`isMoneyAmount`: a
 * 12-digit total, an amount in sats or wei), and under a recipient key (`to`, `payee`, `iban`, `merchant`, …),
 * which is never masked: the payee's IBAN or account number stays as the call gives it.
 */
export function maskCardNumbersDeep<T>(v: T): T {
  // mode: 'payment' inside a payment object, 'recipient' under a recipient key (values kept, payment keys masked)
  type Mode = 'plain' | 'payment' | 'recipient';
  const walk = (x: unknown, depth: number, mode: Mode): unknown => {
    if (typeof x === 'string') return mode === 'recipient' ? x : maskCardRuns(x);
    if (typeof x === 'number' && Number.isInteger(x)) {
      if (mode === 'recipient') return x;
      const s = String(Math.abs(x));
      return isCardDigits(s) ? maskCardRuns(String(x)) : x;
    }
    if (depth > 20 || !x || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1, mode));
    const out: Record<string, unknown> = {};
    const inPayment = mode === 'payment';
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
      const n = normKey(k);
      if (CODE_KEYS.has(n)) out[k] = y === undefined || y === null || y === '' ? y : '•••';
      else if (CARD_KEYS.has(n) || (inPayment && n === 'number'))
        out[k] =
          y && typeof y === 'object'
            ? walk(y, depth + 1, 'payment')
            : y === undefined || y === null
              ? y
              : (maskPaymentLabel(y) ?? y);
      else if (PAYMENT_KEYS.has(n)) out[k] = walk(y, depth + 1, 'payment');
      else if (!inPayment && RECIPIENT_KEYS.has(n)) out[k] = walk(y, depth + 1, 'recipient');
      else if (!inPayment && AMOUNT_KEYS.has(n) && (!y || typeof y !== 'object') && (!y || isMoneyAmount(y)))
        out[k] = y;
      else out[k] = walk(y, depth + 1, mode);
    }
    return out;
  };
  return walk(v, 0, 'plain') as T;
}

/**
 * First argument (top level, then one object level down) whose name is one of `names`. `used` collects exactly what
 * was read, as a JSON path (`["to"]`, or `["envelope","to"]` for a nested one, never ambiguous), so the siblings of a nested
 * fact (an `envelope.bcc` next to the `envelope.to` the card shows) still count as not shown.
 */
function pick(
  input: Record<string, unknown>,
  names: readonly string[],
  used?: Set<string>,
  shows?: ReadonlySet<string>,
): unknown {
  const top = new Map<string, { v: unknown; from: string[] }>();
  const nested = new Map<string, { v: unknown; from: string[] }>();
  for (const [k, v] of Object.entries(input)) {
    top.set(normKey(k), { v, from: [k] });
    if (v && typeof v === 'object' && !Array.isArray(v))
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const n = normKey(k2);
        if (!nested.has(n)) nested.set(n, { v: v2, from: [k, k2] });
      }
  }
  for (const map of [top, nested])
    for (const n of names) {
      const hit = map.get(n);
      if (hit && hit.v !== undefined && hit.v !== '') {
        // a fact that shows only some fields of an object (`shows`, e.g. a card's label and last digits) reads just
        // those: the object's other fields stay "not shown"
        if (shows && hit.v && typeof hit.v === 'object' && !Array.isArray(hit.v))
          for (const k3 of Object.keys(hit.v)) {
            if (shows.has(k3)) used?.add(JSON.stringify([...hit.from, k3]));
          }
        else used?.add(JSON.stringify(hit.from));
        return hit.v;
      }
    }
  return undefined;
}

/** the fields of a payment object the card shows (`maskPaymentLabel`): its other fields are named as not shown */
const PAYMENT_SHOWN: ReadonlySet<string> = new Set([
  'label',
  'brand',
  'type',
  'name',
  'last4',
  'lastFour',
  'last_four',
  'number',
  'cardNumber',
  'card_number',
]);

/** at most this many argument names in the "more details not shown" warning */
const MAX_UNSHOWN = 20;

/**
 * The card of an always-ask call read from its own arguments: every field of the class, `null` when the call does
 * not state it (the card then says "not stated"). `known` adds what the server knows itself (e.g. `channel` = the
 * MCP server's name and host); it never replaces a value the arguments give: the card shows both. These facts are a
 * summary only: the gateway also puts the tool and the full (masked, redacted) arguments on every always-ask card.
 */
export function askFromArgs(
  cls: ActionClass,
  input: unknown,
  known: Partial<Record<string, string>> = {},
): ApprovalAsk {
  const i = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<
    string,
    unknown
  >;
  const used = new Set<string>();
  const fields = ACTION_CLASS_FIELDS[cls].map((key) => {
    const fromArgs = (): string | null => {
      if (key === 'paymentMethod')
        return maskPaymentLabel(pick(i, ALIASES.paymentMethod!, used, PAYMENT_SHOWN));
      if (key === 'total') {
        const total = asText(pick(i, ALIASES.total!, used), 60);
        const cur = asText(pick(i, ALIASES.currency!, used), 12);
        return total ? (cur ? `${total} ${cur}` : total) : null;
      }
      return asText(pick(i, ALIASES[key] ?? [key], used), key === 'text' ? MAX_TEXT : MAX_FACT);
    };
    const arg = fromArgs();
    const k = known[key];
    return { key, value: k && arg ? `${arg} (${k})` : (k ?? arg) };
  });
  // arguments the summary did not read: named explicitly ("more details not shown"), never silently left out. An
  // object the summary read one field from names its other fields (`envelope › bcc`), not the whole object as read.
  const rest: string[][] = [];
  for (const [k, v] of Object.entries(i)) {
    if (v === undefined || used.has(JSON.stringify([k]))) continue;
    const read = (k2: string) => used.has(JSON.stringify([k, k2]));
    const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
    if (!keys.some(read)) rest.push([k]);
    else
      for (const k2 of keys)
        if ((v as Record<string, unknown>)[k2] !== undefined && !read(k2)) rest.push([k, k2]);
  }
  const unshown = rest
    .slice(0, MAX_UNSHOWN)
    .map((path) =>
      path
        .map((k) => asText(maskDigitRuns(k, 6), 40) ?? '')
        .filter(Boolean)
        .join(' › '),
    )
    .filter(Boolean);
  if (rest.length > MAX_UNSHOWN) unshown.push(`+${rest.length - MAX_UNSHOWN}`);
  return { class: cls, fields, ...(unshown.length ? { unshown } : {}) };
}

/** Fields every always-ask card ends with: the tool the call names and its full arguments, as compact JSON. */
export function callFacts(tool: string, input: unknown): ApprovalAsk['fields'] {
  let args: string;
  try {
    args = JSON.stringify(input ?? {}, null, 1) ?? '{}';
  } catch {
    args = String(input);
  }
  return [
    { key: 'tool', value: tool },
    { key: 'arguments', value: args.length > MAX_TEXT ? `${args.slice(0, MAX_TEXT)}…` : args },
  ];
}

/** lowercase words of a tool name or description: splits on anything not a letter/digit and on camelCase */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let prevLower = false;
  for (const ch of s.slice(0, 4000)) {
    const lower = ch >= 'a' && ch <= 'z';
    const upper = ch >= 'A' && ch <= 'Z';
    const digit = ch >= '0' && ch <= '9';
    if (upper && prevLower && cur) {
      out.push(cur);
      cur = '';
    }
    if (lower || upper || digit) cur += ch.toLowerCase();
    else if (cur) {
      out.push(cur);
      cur = '';
    }
    prevLower = lower;
  }
  if (cur) out.push(cur);
  return out;
}

const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'read',
  'find',
  'fetch',
  'describe',
  'query',
  'view',
  'show',
  'lookup',
  'count',
  'check',
  'preview',
  'estimate',
  'quote',
]);
const MONEY = new Set([
  'pay',
  'payment',
  'payout',
  'purchase',
  'buy',
  'checkout',
  'charge',
  'transfer',
  'refund',
  'subscribe',
  'subscription',
  'donate',
  'tip',
  'withdraw',
  'deposit',
  'swap',
  'trade',
  'crypto',
  'bitcoin',
  'invoice',
]);
const MONEY_PHRASES: [string, string][] = [
  ['place', 'order'],
  ['create', 'order'],
  ['submit', 'order'],
  ['send', 'money'],
  ['send', 'funds'],
  ['send', 'payment'],
];
const MESSAGE = new Set([
  'send',
  'reply',
  'forward',
  'post',
  'email',
  'mail',
  'sms',
  'dm',
  'message',
  'comment',
  'tweet',
  'invite',
  'notify',
  'share',
  'publish',
  'broadcast',
]);
const DELETE = new Set(['delete', 'remove', 'drop', 'destroy', 'erase', 'purge', 'trash', 'rm', 'wipe']);

/**
 * Conservative default class of an outside tool from its server-given name and description, run when the tool list
 * is fetched (install/test time), stored, and correctable by the owner; never re-run on agent text at call time.
 * Tools whose name starts with a read verb (get/list/search…) are not classed; otherwise money wins over a message,
 * which wins over a delete.
 */
export function classifyToolText(name: string, description = ''): ActionClass | undefined {
  const n = words(name);
  if (n.length && READ_VERBS.has(n[0]!)) return undefined;
  // description words with a plain plural/3rd-person "s" dropped ("sends" -> "send", "emails" -> "email")
  const d = words(description)
    .slice(0, 60)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  const has = (set: Set<string>, ws: string[]) => ws.some((w) => set.has(w));
  const phrase = (ws: string[]) =>
    MONEY_PHRASES.some(([a, b]) => ws.some((w, k) => w === a && ws.slice(k + 1, k + 3).includes(b)));
  if (has(MONEY, n) || phrase(n) || phrase(d)) return 'money';
  if (has(MESSAGE, n)) return n.includes('publish') ? 'publish' : 'outbound-message';
  // a neutral name whose description says it sends something to someone
  if (d.includes('send') && (d.includes('email') || d.includes('message') || d.includes('sms')))
    return 'outbound-message';
  if (has(DELETE, n)) return 'delete';
  return undefined;
}
