/**
 * Just enough RFC 5322 / MIME for a bot inbox: headers (unfolded, encoded-words decoded), the first text/plain part
 * (else text/html turned into plain text by a linear scan: tags dropped, no remote image is ever fetched), quoted-
 * printable and base64 bodies, and outgoing messages with attachments. Parsing is index scans; the only patterns are fixed, linear ones written here
 * (never a user- or agent-supplied regex).
 */
import { randomBytes } from 'node:crypto';

export interface ParsedMail {
  headers: Map<string, string>;
  from: { addr: string; name: string };
  to: string[];
  subject: string;
  date: number | null;
  messageId: string | null;
  text: string;
  wasHtml: boolean;
}

const MAX_TEXT = 200_000;

function splitHeadBody(raw: string): [string, string] {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return [raw.slice(0, crlf), raw.slice(crlf + 4)];
  if (lf >= 0) return [raw.slice(0, lf), raw.slice(lf + 2)];
  return [raw, ''];
}

export function parseHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur = '';
  const flush = () => {
    const i = cur.indexOf(':');
    if (i > 0) {
      const k = cur.slice(0, i).trim().toLowerCase();
      if (!out.has(k)) out.set(k, decodeWords(cur.slice(i + 1).trim()));
    }
  };
  for (const line of head.split('\n')) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.startsWith(' ') || l.startsWith('\t')) cur += ` ${l.trim()}`;
    else {
      flush();
      cur = l;
    }
  }
  flush();
  return out;
}

/** =?utf-8?B?...?= and =?utf-8?Q?...?= encoded words */
function decodeWords(v: string): string {
  let out = '';
  let i = 0;
  while (i < v.length) {
    const s = v.indexOf('=?', i);
    if (s < 0) break;
    const q1 = v.indexOf('?', s + 2);
    const q2 = q1 < 0 ? -1 : v.indexOf('?', q1 + 1);
    const e = q2 < 0 ? -1 : v.indexOf('?=', q2 + 1);
    if (q1 < 0 || q2 < 0 || e < 0) break;
    const between = v.slice(i, s);
    out += between.trim() === '' && out ? '' : between;
    const enc = v.slice(q1 + 1, q2).toUpperCase();
    const data = v.slice(q2 + 1, e);
    try {
      out +=
        enc === 'B'
          ? Buffer.from(data, 'base64').toString('utf8')
          : decodeQp(data.split('_').join(' '), true);
    } catch {
      out += data;
    }
    i = e + 2;
  }
  return out + v.slice(i);
}

function decodeQp(s: string, header = false): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=') {
      const n1 = s[i + 1];
      if (!header && (n1 === '\r' || n1 === '\n')) {
        i += n1 === '\r' && s[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      const hex = s.slice(i + 1, i + 3);
      const v = Number.parseInt(hex, 16);
      if (hex.length === 2 && Number.isFinite(v)) {
        bytes.push(v);
        i += 2;
        continue;
      }
    }
    for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `Name <a@b>` -> { addr, name }; lower-cased address */
export function parseAddress(v: string): { addr: string; name: string } {
  const lt = v.lastIndexOf('<');
  const gt = v.lastIndexOf('>');
  if (lt >= 0 && gt > lt) {
    let name = v.slice(0, lt).trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return {
      addr: v
        .slice(lt + 1, gt)
        .trim()
        .toLowerCase(),
      name,
    };
  }
  return { addr: v.trim().toLowerCase(), name: '' };
}

function param(contentType: string, name: string): string | null {
  for (const part of contentType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }
  return null;
}

function decodeBody(body: string, cte: string): string {
  const e = cte.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(body.split(/\s+/).join(''), 'base64').toString('utf8');
  if (e === 'quoted-printable') return decodeQp(body);
  return body;
}

/** HTML to plain text: tags dropped (script/style content too), a few entities decoded. Linear. */
export function htmlToText(html: string): string {
  let out = '';
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const c = html[i]!;
    if (c === '<') {
      const end = html.indexOf('>', i + 1);
      if (end < 0) break;
      const tag = lower.slice(i + 1, end).trim();
      const name = tag.split(/[\s/]/)[0] ?? '';
      if (name === 'script' || name === 'style') {
        const close = lower.indexOf(`</${name}`, end);
        i = close < 0 ? html.length : lower.indexOf('>', close) + 1 || html.length;
        continue;
      }
      if (
        name === 'br' ||
        name === 'p' ||
        name === '/p' ||
        name === 'div' ||
        name === '/div' ||
        name === 'li'
      )
        out += '\n';
      // a table cell or a span ends with a space: a code split into cells never runs into the word next to it
      else if (tag.startsWith('/')) {
        const closed = tag.slice(1).trim().split(/[\s/]/)[0];
        if (closed === 'td' || closed === 'th' || closed === 'span') out += ' ';
      }
      i = end + 1;
      continue;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi > i && semi - i <= 8) {
        const ent = html.slice(i + 1, semi).toLowerCase();
        const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        if (map[ent] !== undefined) {
          out += map[ent];
          i = semi + 1;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .split('\n\n\n')
    .join('\n\n')
    .trim();
}

function textOf(
  headers: Map<string, string>,
  body: string,
  depth = 0,
): { text: string; html: boolean } | null {
  const ct = headers.get('content-type') ?? 'text/plain';
  const type = (ct.split(';')[0] ?? '').trim().toLowerCase();
  const cte = headers.get('content-transfer-encoding') ?? '7bit';
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = param(ct, 'boundary');
    if (!boundary) return null;
    const parts = body.split(`--${boundary}`).slice(1);
    let html: string | null = null;
    for (const p of parts) {
      if (p.startsWith('--')) break;
      const [h, b] = splitHeadBody(p.startsWith('\r\n') ? p.slice(2) : p.startsWith('\n') ? p.slice(1) : p);
      const ph = parseHeaders(h);
      if ((ph.get('content-disposition') ?? '').toLowerCase().startsWith('attachment')) continue;
      const got = textOf(ph, b, depth + 1);
      if (got && !got.html) return got;
      if (got?.html && html === null) html = got.text;
    }
    return html === null ? null : { text: html, html: true };
  }
  if (type === 'text/plain') return { text: decodeBody(body, cte), html: false };
  if (type === 'text/html') return { text: htmlToText(decodeBody(body, cte)), html: true };
  return null;
}

export function parseMail(raw: string): ParsedMail {
  const [head, body] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const t = textOf(headers, body) ?? { text: '', html: false };
  const dateMs = Date.parse(headers.get('date') ?? '');
  return {
    headers,
    from: parseAddress(headers.get('from') ?? ''),
    to: (headers.get('to') ?? '')
      .split(',')
      .map((x) => parseAddress(x).addr)
      .filter(Boolean),
    subject: headers.get('subject') ?? '',
    date: Number.isFinite(dateMs) ? dateMs : null,
    messageId: headers.get('message-id') ?? null,
    text: t.text.replace(/\r\n/g, '\n').slice(0, MAX_TEXT),
    wasHtml: t.html,
  };
}

// ---------- outgoing ----------
export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  extraHeaders?: Record<string, string>;
  attachments?: { name: string; mime: string; data: Buffer }[];
}

/** a header value with no CR/LF (header injection) */
export function headerSafe(v: string): string {
  let out = '';
  for (const ch of v) out += ch === '\r' || ch === '\n' ? ' ' : ch;
  return out;
}
const encodeWord = (v: string) => {
  const s = headerSafe(v);
  for (const ch of s) if (ch.charCodeAt(0) > 126) return `=?utf-8?B?${Buffer.from(s).toString('base64')}?=`;
  return s;
};
const b64lines = (b: Buffer) => (b.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

export function buildMail(m: OutgoingMail, now = new Date()): string {
  const id = `<${randomBytes(12).toString('hex')}@pasabot>`;
  const head = [
    `From: ${headerSafe(m.from)}`,
    `To: ${m.to.map(headerSafe).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(headerSafe).join(', ')}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo
      ? [`In-Reply-To: ${headerSafe(m.inReplyTo)}`, `References: ${headerSafe(m.inReplyTo)}`]
      : []),
    ...Object.entries(m.extraHeaders ?? {}).map(([k, v]) => `${headerSafe(k)}: ${headerSafe(v)}`),
    'MIME-Version: 1.0',
  ];
  const textPart = b64lines(Buffer.from(m.text, 'utf8'));
  if (!m.attachments?.length)
    return [
      ...head,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      textPart,
      '',
    ].join('\r\n');
  const boundary = `pb-${randomBytes(12).toString('hex')}`;
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    textPart,
  ];
  for (const a of m.attachments)
    parts.push(
      `--${boundary}`,
      `Content-Type: ${headerSafe(a.mime)}; name="${headerSafe(a.name).split('"').join('')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${headerSafe(a.name).split('"').join('')}"`,
      '',
      b64lines(a.data),
    );
  parts.push(`--${boundary}--`, '');
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}
