/**
 * A small five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone, plus the
 * 30-day iCalendar export. Fields take `*`, `n`, `a-b`, lists `a,b` and steps `* /n`, `a-b/n`. Day-of-week 0 or 7 =
 * Sunday. As in classic cron, when both day fields are restricted a day matches if either matches.
 */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(src: string, [lo, hi]: [number, number]): { set: Set<number>; any: boolean } {
  const set = new Set<number>();
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) throw new Error(`bad cron step in "${src}"`);
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1]!.split('-').map(Number) as [number, number?];
      a = x;
      b = y ?? (m[2] ? hi : x);
    }
    if (a < lo || b > hi || a > b) throw new Error(`cron value out of range in "${src}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any: src === '*' };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const f = parts.map((p, i) => field(p, RANGES[i]!));
  const dow = f[4]!.set;
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: f[0]!.set,
    hour: f[1]!.set,
    dom: f[2]!.set,
    month: f[3]!.set,
    dow,
    domAny: f[2]!.any,
    dowAny: f[4]!.any,
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTz(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function local(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(ms)) p[x.type] = x.value;
  return {
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow: WD[p.weekday!] ?? 0,
  };
}

const MIN = 60_000;

/** First slot strictly after `after` (ms), or null within a ~5-year horizon. */
export function nextAfter(c: Cron, tz: string, after: number): number | null {
  let t = Math.floor(after / MIN) * MIN + MIN;
  const end = after + 5 * 366 * 24 * 60 * MIN;
  while (t <= end) {
    const l = local(t, tz);
    const dayOk =
      c.month.has(l.month) &&
      (c.domAny && c.dowAny
        ? true
        : c.domAny
          ? c.dow.has(l.dow)
          : c.dowAny
            ? c.dom.has(l.day)
            : c.dom.has(l.day) || c.dow.has(l.dow));
    if (!dayOk) {
      t += (24 * 60 - (l.hour * 60 + l.minute)) * MIN; // next local midnight (DST-safe: we re-read parts)
      continue;
    }
    if (!c.hour.has(l.hour)) {
      t += (60 - l.minute) * MIN;
      continue;
    }
    if (!c.minute.has(l.minute)) {
      t += MIN;
      continue;
    }
    return t;
  }
  return null;
}

/** Every slot in (from, to]. */
export function slotsBetween(c: Cron, tz: string, from: number, to: number, max = 5000): number[] {
  const out: number[] = [];
  let t = from;
  while (out.length < max) {
    const n = nextAfter(c, tz, t);
    if (n === null || n > to) break;
    out.push(n);
    t = n;
  }
  return out;
}

// ---------- iCalendar (RFC 5545) ----------
const icsDate = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Lines longer than 75 octets are folded (RFC 5545 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export interface IcsEvent {
  uid: string;
  at: number;
  summary: string;
  description?: string;
}
export function toIcs(events: IcsEvent[], now: number, name = 'PasaBot routines'): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PasaBot//Routines//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsText(name)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(e.at)}`,
      `DTEND:${icsDate(e.at + 5 * MIN)}`,
      `SUMMARY:${icsText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
