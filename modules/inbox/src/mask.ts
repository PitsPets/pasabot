/**
 * No OTP helper (W35): one-time codes, verification links and sign-in codes are masked before the agent sees a mail.
 * One linear pass over the text (no regex, no user- or agent-written pattern):
 *  - a run of 4–8 digits standing alone (spaces or dashes inside allowed, e.g. "123 456", "12-34-56"),
 *  - a 5–10 character code of capital letters and digits with at least two digits (e.g. "G7K-29Q", "AB12CD"),
 *  - short groups (1–3 characters) split by spaces, tabs or up to two line breaks count as one code, so a code laid out
 *    one digit per box or per HTML table cell ("4\n8\n1\n9\n0\n2", "1 2 3 4 5 6") is masked whole,
 *  - on a line that names a code (code, OTP, verification, PIN, passcode, password, token, one-time) or the line after
 *    one, also a 4–10 character all-capital code ("KQZ-WRT") and a mixed letter-and-digit one in any case ("a7k2p9"),
 *  - a link whose text mentions verify/confirm/token/code/otp/magic/login/signin/activate/reset/auth/password.
 * The owner sees the mail unmasked on the Inbox page; only what reaches an agent is masked.
 */
export const CODE_MASK = '[code hidden]';
export const LINK_MASK = '[link hidden]';

const LINK_WORDS = [
  'verif',
  'confirm',
  'token',
  'code',
  'otp',
  'magic',
  'login',
  'signin',
  'sign-in',
  'sign_in',
  'activat',
  'reset',
  'auth',
  'password',
  'passcode',
  'unlock',
];

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isUpper = (c: string | undefined) => c !== undefined && c >= 'A' && c <= 'Z';
const isLower = (c: string | undefined) => c !== undefined && c >= 'a' && c <= 'z';
const isWordChar = (c: string | undefined) => isDigit(c) || isUpper(c) || isLower(c) || c === '_';
const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === undefined;

function linkEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (isSpace(c) || c === '<' || c === '>' || c === '"' || c === "'" || c === ')' || c === ']') break;
    i++;
  }
  // trailing punctuation is not part of the link
  while (i > start && '.,;:!?'.includes(text[i - 1]!)) i--;
  return i;
}

function startsLink(text: string, i: number): boolean {
  const head = text.slice(i, i + 8).toLowerCase();
  return head.startsWith('http://') || head.startsWith('https://') || head.startsWith('www.');
}

const KEYWORDS = ['code', 'otp', 'verif', 'pin', 'passcode', 'password', 'token', 'one-time'];
const SHORT_GROUP = 3;
const isLetter = (c: string | undefined) => isUpper(c) || isLower(c);
const isCodeChar = (c: string | undefined) => isDigit(c) || isUpper(c);
const isBlankChar = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n';

/** Whether a (lower-case) line names a code: a keyword at a word start ("pin"/"otp" also at a word end). */
function namesCode(line: string): boolean {
  for (const w of KEYWORDS) {
    let at = line.indexOf(w);
    while (at >= 0) {
      const whole = w === 'pin' || w === 'otp';
      if (!isLetter(line[at - 1]) && (!whole || !isLetter(line[at + w.length]))) return true;
      at = line.indexOf(w, at + 1);
    }
  }
  return false;
}
const hasKeyword = (token: string) => {
  const t = token.toLowerCase();
  return KEYWORDS.some((w) => t.includes(w));
};

/**
 * Per line of `text`: its start offset, and whether codes there are "in context" (the line names a code, or the last
 * non-blank line before it does). One pass over the text.
 */
function codeContext(text: string): { starts: number[]; ctx: boolean[] } {
  const lower = text.toLowerCase();
  const starts: number[] = [];
  const ctx: boolean[] = [];
  let prevNamed = false;
  let from = 0;
  while (from <= lower.length) {
    let nl = lower.indexOf('\n', from);
    if (nl < 0) nl = lower.length;
    const line = lower.slice(from, nl);
    const named = namesCode(line);
    starts.push(from);
    ctx.push(named || prevNamed);
    if (line.trim()) prevNamed = named;
    from = nl + 1;
  }
  return { starts, ctx };
}

/** Length of the run of capitals and digits at `k`, or -1 when the run carries on into a lower-case word. */
function groupAt(text: string, k: number): number {
  let e = k;
  while (isCodeChar(text[e])) e++;
  return isLower(text[e]) || text[e] === '_' ? -1 : e - k;
}

/** Masks codes and verification links; returns the text and how many it hid. */
export function maskSecrets(text: string): { text: string; hidden: number } {
  const { starts, ctx } = codeContext(text);
  let line = 0;
  const inContext = (at: number) => {
    while (line + 1 < starts.length && starts[line + 1]! <= at) line++;
    return ctx[line] === true;
  };
  let out = '';
  let hidden = 0;
  let i = 0;
  const hide = (end: number) => {
    out += CODE_MASK;
    hidden++;
    i = end;
  };
  while (i < text.length) {
    const c = text[i]!;
    const prev = i > 0 ? text[i - 1] : undefined;
    // links
    if (!isWordChar(prev) && startsLink(text, i)) {
      const end = linkEnd(text, i);
      const link = text.slice(i, end);
      const lower = link.toLowerCase();
      if (LINK_WORDS.some((w) => lower.includes(w))) {
        out += LINK_MASK;
        hidden++;
      } else out += link;
      i = end;
      continue;
    }
    const tokenStart = !isWordChar(prev) && prev !== '-' && prev !== '.';
    const named = tokenStart && (isDigit(c) || isLetter(c)) && inContext(i);
    /** Would the token `text[i, end)` with these counts be a code? */
    const isCode = (end: number, digits: number, letters: number) => {
      const next = text[end];
      // a decimal number or an amount ("1234.50") is not a code
      if (isWordChar(next) || (next === '.' && isDigit(text[end + 1]))) return false;
      const len = digits + letters;
      if (letters === 0 && digits >= 4 && digits <= 8) return true;
      if (letters > 0 && digits >= 2 && len >= 5 && len <= 10) return true;
      // on a line about a code: an all-capital or a letter-and-digit code of 4–10 (never the keyword itself)
      return named && letters > 0 && len >= 4 && len <= 10 && !hasKeyword(text.slice(i, end));
    };
    // codes: a token of digits/capitals, possibly with single spaces or dashes between groups, or short groups
    // split by blank space (one digit per box or table cell)
    if (isCodeChar(c) && tokenStart) {
      let j = i;
      let digits = 0;
      let letters = 0;
      let lowers = false;
      let groups = 1;
      let groupLen = 0;
      // every group so far is short (1–3 characters): a code laid out one character per box or cell
      let allShort = true;
      let firstEnd = -1;
      let firstDigits = 0;
      let firstLetters = 0;
      while (j < text.length) {
        const d = text[j]!;
        // longer than any code (and a bound on the scan, so a long run of digits stays linear); a run of short
        // groups goes on to its end and is masked whole below
        if (!allShort && digits + letters > 10) break;
        if (isDigit(d) || isUpper(d)) {
          if (isDigit(d)) digits++;
          else letters++;
          if (++groupLen > SHORT_GROUP) allShort = false;
          j++;
          continue;
        }
        if (isLower(d) || d === '_') {
          lowers = true;
          break;
        }
        if (firstEnd < 0) {
          firstEnd = j;
          firstDigits = digits;
          firstLetters = letters;
        }
        // short groups split by a dash, or by spaces, tabs and up to two line breaks (no more than 8 blank characters)
        let k = j;
        let breaks = 0;
        if (d === '-') k = j + 1;
        else while (k < text.length && k - j <= 8 && isBlankChar(text[k])) if (text[k++] === '\n') breaks++;
        const nextLen = k > j && k - j <= 8 && breaks <= 2 ? groupAt(text, k) : -1;
        if (allShort && nextLen >= 1 && nextLen <= SHORT_GROUP) {
          groups++;
          groupLen = 0;
          j = k;
          continue;
        }
        const longRun = allShort && digits + letters > 10;
        if ((d === ' ' || d === '-' || d === '\t') && isCodeChar(text[j + 1]) && groups < 4 && !longRun) {
          // a separator only joins groups of the same kind of token (a digit group after a digit group)
          const before = text[j - 1];
          const after = text[j + 1];
          if (isDigit(before) !== isDigit(after) && letters === 0) break;
          groups++;
          groupLen = 0;
          j++;
          continue;
        }
        break;
      }
      // trim a separator the loop stopped after
      let end = j;
      while (end > i && (text[end - 1] === ' ' || text[end - 1] === '-' || text[end - 1] === '\t')) end--;
      if (!lowers && isCode(end, digits, letters)) {
        hide(end);
        continue;
      }
      // a run of short groups longer than a code ("1 2 3 4 5 6 7 8 9") is hidden whole: no part of it leaks
      const len = digits + letters;
      if (!lowers && allShort && groups > 1 && (len > 10 || (len > 8 && digits > 0))) {
        hide(end);
        continue;
      }
      // the joined groups are not one code, but the first group alone may be ("481902 2026-11-14")
      if (firstEnd > 0 && isCode(firstEnd, firstDigits, firstLetters)) {
        hide(firstEnd);
        continue;
      }
    }
    // on a line about a code, a letter-and-digit word in any case ("a7k2p9", "Xb4-9kQ")
    if (named) {
      let j = i;
      let digits = 0;
      let letters = 0;
      while (j < text.length) {
        const d = text[j];
        if (isDigit(d)) digits++;
        else if (isLetter(d)) letters++;
        else if (d !== '-' || !isWordChar(text[j - 1]) || !(isDigit(text[j + 1]) || isLetter(text[j + 1])))
          break;
        if (digits + letters > 10) break; // longer than any code: stop here
        j++;
      }
      if (text[j] !== '_' && digits > 0 && isCode(j, digits, letters)) {
        hide(j);
        continue;
      }
    }
    if (isCodeChar(c) && tokenStart) {
      // not a code: copy the first token (to the first separator) and keep scanning
      let k = i;
      while (k < text.length && isWordChar(text[k])) k++;
      out += text.slice(i, Math.max(k, i + 1));
      i = Math.max(k, i + 1);
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, hidden };
}
