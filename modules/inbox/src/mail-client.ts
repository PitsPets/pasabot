/**
 * Minimal IMAP (fetch) and SMTP (send) clients over `safeConnect` from @pasabot/safe-net. Both end on verified TLS
 * before any credential (`requireTls()`); with `starttls` a server that does not offer STARTTLS is refused, never
 * used in plaintext. Only the hosts the owner entered can be reached.
 */
import type { Socket } from 'node:net';
import { type SafeTcpConnection, safeConnect, type TlsMode } from '@pasabot/safe-net';

export interface MailboxSettings {
  address: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapTls: TlsMode;
  smtpHost: string;
  smtpPort: number;
  smtpTls: TlsMode;
}
export interface NetOptions {
  privateHosts?: string[];
  ca?: string | string[];
  resolver?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  timeoutMs?: number;
}

export class MailError extends Error {
  constructor(
    readonly code: 'starttls_unavailable' | 'auth_failed' | 'protocol' | 'timeout' | 'rejected' | 'stopped',
    message: string,
    /** what the server said with a refusal (matched for a plain reason, never shown or logged) */
    readonly serverText = '',
  ) {
    super(message);
  }
}

/** Buffers a socket's bytes; reads lines (CRLF) or exact byte counts; can move to the TLS socket after STARTTLS. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended: Error | null = null;
  private sock: Socket | null = null;
  constructor(private readonly timeoutMs: number) {}
  private onData = (d: Buffer) => {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 64 * 1024 * 1024) this.fail(new MailError('protocol', 'response too large'));
    this.wake();
  };
  private onEnd = () => this.fail(new MailError('protocol', 'connection closed'));
  private onErr = (e: Error) => this.fail(e);
  /** end every wait now (Stop all) */
  abort(e: Error) {
    this.fail(e);
  }
  private fail(e: Error) {
    this.ended ??= e;
    this.wake();
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  attach(s: Socket) {
    if (this.sock) {
      this.sock.off('data', this.onData);
      this.sock.off('end', this.onEnd);
      this.sock.off('error', this.onErr);
    }
    this.sock = s;
    s.on('data', this.onData);
    s.on('end', this.onEnd);
    s.on('error', this.onErr);
  }
  /**
   * Leaves the plaintext socket before STARTTLS. Any byte already buffered past the STARTTLS reply came in plaintext
   * and would otherwise be read as if the server had sent it over TLS (CVE-2011-0411 class): refuse the connection.
   */
  detachForTls() {
    this.detach();
    if (this.ended) throw this.ended;
    if (this.buf.length > 0)
      throw new MailError('protocol', 'the mail server sent data before TLS started; refusing');
  }
  detach() {
    if (!this.sock) return;
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('error', this.onErr);
    this.sock = null;
  }
  private async wait() {
    if (this.ended) throw this.ended;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new MailError('timeout', 'mail server did not answer')),
        this.timeoutMs,
      );
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return l;
      }
      if (this.buf.length > 1024 * 1024) throw new MailError('protocol', 'line too long');
      await this.wait();
    }
  }
  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.wait();
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(b);
  }
}

async function open(host: string, port: number, tls: TlsMode, o: NetOptions): Promise<SafeTcpConnection> {
  return safeConnect({
    host,
    port,
    tls,
    // only the host the owner entered for this protocol of this mailbox
    onlyHosts: [host],
    privateHosts: o.privateHosts,
    ca: o.ca,
    resolver: o.resolver,
    timeoutMs: o.timeoutMs,
  });
}

const imapQuote = (s: string) => {
  let out = '"';
  for (const ch of s) {
    if (ch === '\r' || ch === '\n') throw new MailError('protocol', 'line breaks are not allowed here');
    out += ch === '"' || ch === '\\' ? `\\${ch}` : ch;
  }
  return `${out}"`;
};

export interface FetchedMail {
  uidValidity: string;
  uid: number;
  raw: string;
}

/** Fetch mail with a UID above `afterUid` (at most `limit`), oldest first. */
export async function imapFetch(
  s: MailboxSettings,
  password: string,
  o: NetOptions & {
    afterUid?: number;
    uidValidity?: string | null;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FetchedMail[]> {
  const stopped = () => new MailError('stopped', 'everything is stopped');
  if (o.signal?.aborted) throw stopped();
  const conn = await open(s.imapHost, s.imapPort, s.imapTls, o);
  if (o.signal?.aborted) {
    conn.close();
    throw stopped();
  }
  const r = new Reader(o.timeoutMs ?? 20_000);
  r.attach(conn.socket as Socket);
  // Stop all ends a fetch in flight: every pending read fails at once and the connection is closed
  const onAbort = () => {
    r.abort(stopped());
    conn.close();
  };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let n = 0;
  const send = async (cmd: string): Promise<{ untagged: string[]; status: string; literals: Buffer[] }> => {
    const tag = `p${++n}`;
    conn.socket.write(`${tag} ${cmd}\r\n`);
    const untagged: string[] = [];
    const literals: Buffer[] = [];
    for (;;) {
      let l = await r.line();
      // a literal {n} at the end of a line: read exactly n bytes, then the rest of the line
      while (l.endsWith('}') && l.lastIndexOf('{') >= 0) {
        const size = Number(l.slice(l.lastIndexOf('{') + 1, -1));
        if (!Number.isInteger(size) || size < 0 || size > 50 * 1024 * 1024) break;
        literals.push(await r.bytes(size));
        l = `${l}${await r.line()}`;
      }
      if (l.startsWith(`${tag} `)) return { untagged, status: l.slice(tag.length + 1), literals };
      untagged.push(l);
    }
  };
  try {
    const greet = await r.line();
    if (!greet.startsWith('* OK') && !greet.startsWith('* PREAUTH'))
      throw new MailError('protocol', 'not an IMAP server');
    if (s.imapTls === 'starttls') {
      const st = await send('STARTTLS');
      if (!st.status.startsWith('OK'))
        throw new MailError('starttls_unavailable', 'the IMAP server did not start TLS; refusing to sign in');
      r.detachForTls();
      const t = await conn.startTls();
      r.attach(t);
    }
    conn.requireTls();
    const login = await send(`LOGIN ${imapQuote(s.username)} ${imapQuote(password)}`);
    if (!login.status.startsWith('OK'))
      throw new MailError(
        'auth_failed',
        'the IMAP server refused the sign-in',
        [...login.untagged, login.status].join(' ').slice(0, 500),
      );
    const sel = await send('SELECT INBOX');
    if (!sel.status.startsWith('OK')) throw new MailError('protocol', 'could not open INBOX');
    let uidValidity = '0';
    for (const l of sel.untagged) {
      const i = l.indexOf('[UIDVALIDITY ');
      if (i >= 0) uidValidity = l.slice(i + 13, l.indexOf(']', i)).trim();
    }
    const after = o.uidValidity && o.uidValidity !== uidValidity ? 0 : (o.afterUid ?? 0);
    const search = await send(`UID SEARCH UID ${after + 1}:*`);
    const uids: number[] = [];
    for (const l of search.untagged)
      if (l.startsWith('* SEARCH'))
        for (const x of l.slice(8).trim().split(' ')) {
          const u = Number(x);
          if (Number.isInteger(u) && u > after) uids.push(u);
        }
    uids.sort((a, b) => a - b);
    const out: FetchedMail[] = [];
    for (const uid of uids.slice(0, o.limit ?? 50)) {
      const f = await send(`UID FETCH ${uid} (BODY.PEEK[])`);
      if (!f.status.startsWith('OK') || !f.literals[0]) continue;
      out.push({ uidValidity, uid, raw: f.literals[0].toString('utf8') });
    }
    await send('LOGOUT').catch(() => undefined);
    return out;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    r.detach();
    conn.close();
  }
}

/** Send one message; resolves once the server accepted it (250 after DATA). */
export function smtpSend(
  s: MailboxSettings,
  password: string,
  m: { from: string; recipients: string[]; data: string },
  o: NetOptions = {},
): Promise<void> {
  return smtpSession(s, password, m, o);
}

/** Signs in to the SMTP server and leaves again, sending nothing (the connect check). */
export function smtpCheck(s: MailboxSettings, password: string, o: NetOptions = {}): Promise<void> {
  return smtpSession(s, password, null, o);
}

/** Signs in to IMAP and opens the INBOX, fetching nothing (the connect check). */
export async function imapCheck(s: MailboxSettings, password: string, o: NetOptions = {}): Promise<void> {
  await imapFetch(s, password, { ...o, limit: 0 });
}

async function smtpSession(
  s: MailboxSettings,
  password: string,
  m: { from: string; recipients: string[]; data: string } | null,
  o: NetOptions,
): Promise<void> {
  const conn = await open(s.smtpHost, s.smtpPort, s.smtpTls, o);
  const r = new Reader(o.timeoutMs ?? 20_000);
  r.attach(conn.socket as Socket);
  const reply = async (): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    for (;;) {
      const l = await r.line();
      lines.push(l.slice(4));
      if (l[3] !== '-') return { code: Number(l.slice(0, 3)), lines };
    }
  };
  const cmd = async (c: string, ok: number[]) => {
    conn.socket.write(`${c}\r\n`);
    const res = await reply();
    if (!ok.includes(res.code)) throw new MailError('rejected', `the mail server answered ${res.code}`);
    return res;
  };
  const addr = (a: string) => {
    for (const ch of a)
      if (ch === '\r' || ch === '\n' || ch === '<' || ch === '>')
        throw new MailError('protocol', 'bad address');
    return a;
  };
  try {
    const greet = await reply();
    if (greet.code !== 220) throw new MailError('protocol', 'not an SMTP server');
    let ehlo = await cmd('EHLO pasabot.local', [250]);
    if (s.smtpTls === 'starttls') {
      if (!ehlo.lines.some((l) => l.toUpperCase().startsWith('STARTTLS')))
        throw new MailError(
          'starttls_unavailable',
          'the SMTP server does not offer STARTTLS; refusing to sign in',
        );
      await cmd('STARTTLS', [220]);
      r.detachForTls();
      const t = await conn.startTls();
      r.attach(t);
      ehlo = await cmd('EHLO pasabot.local', [250]);
    }
    conn.requireTls();
    const plain = Buffer.from(`\0${s.username}\0${password}`, 'utf8').toString('base64');
    conn.socket.write(`AUTH PLAIN ${plain}\r\n`);
    const auth = await reply();
    if (auth.code !== 235)
      throw new MailError(
        'auth_failed',
        'the SMTP server refused the sign-in',
        `${auth.code} ${auth.lines.join(' ')}`.slice(0, 500),
      );
    if (!m) {
      await cmd('QUIT', [221]).catch(() => undefined);
      return;
    }
    await cmd(`MAIL FROM:<${addr(m.from)}>`, [250]);
    for (const rcpt of m.recipients) await cmd(`RCPT TO:<${addr(rcpt)}>`, [250, 251]);
    await cmd('DATA', [354]);
    // dot-stuffing (RFC 5321 4.5.2)
    const body = m.data
      .split('\r\n')
      .map((l) => (l.startsWith('.') ? `.${l}` : l))
      .join('\r\n');
    await cmd(`${body.endsWith('\r\n') ? body : `${body}\r\n`}.`, [250]);
    await cmd('QUIT', [221]).catch(() => undefined);
  } finally {
    r.detach();
    conn.close();
  }
}
