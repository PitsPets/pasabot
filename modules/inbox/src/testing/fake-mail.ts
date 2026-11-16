/**
 * In-repo fake IMAP + SMTP server for W35 tests (no network, no real account): listens on 127.0.0.1 port 0 with a
 * throwaway self-signed certificate (made with the openssl CLI and a minimal config of its own) that only the test
 * trusts. `tls: 'implicit'` speaks TLS at once; `'starttls'` starts plain and upgrades on STARTTLS; `'none'` never
 * offers TLS, so a correct client must refuse to sign in. It records every sign-in attempt and whether it was in
 * plaintext, and every message SMTP accepted.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';

export interface TestCert {
  key: string;
  cert: string;
}
/** a self-signed cert for 127.0.0.1 and `mail.test` (P-256, valid 2 days) */
export function makeTestCert(): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cert-'));
  try {
    writeFileSync(join(dir, 'req.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
    execFileSync(
      'openssl',
      [
        'req',
        '-config',
        join(dir, 'req.cnf'),
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=mail.test',
        '-addext',
        'subjectAltName=DNS:mail.test,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type FakeTls = 'implicit' | 'starttls' | 'none';
export interface FakeMail {
  cert: TestCert;
  imapPort: number;
  smtpPort: number;
  /** put a raw RFC 5322 message in the INBOX */
  deliver(raw: string): void;
  /** messages SMTP accepted (DATA, de-dot-stuffed) with their envelope */
  sent: { from: string; to: string[]; data: string }[];
  /** sign-in attempts: which protocol, whether on TLS, ok */
  logins: { proto: 'imap' | 'smtp'; secure: boolean; ok: boolean }[];
  /**
   * From now on every IMAP sign-in is refused with these words after `NO` (what a real service says when the code
   * is wrong, IMAP is off or it wants 2-step verification); null = sign-ins work again with the right password.
   */
  refuseWith(text: string | null): void;
  close(): Promise<void>;
}

export async function startFakeMail(o: {
  user: string;
  pass: string;
  tls?: FakeTls;
  cert?: TestCert;
  /** while true, a UID FETCH gets no answer at all (a server that hangs mid-fetch); `onFetch` sees each one */
  stallFetch?: () => boolean;
  onFetch?: () => void;
  /** plaintext bytes sent right after the STARTTLS reply, in the same write (an on-path injection) */
  afterStarttls?: { imap?: string; smtp?: string };
}): Promise<FakeMail> {
  const cert = o.cert ?? makeTestCert();
  const mode = o.tls ?? 'implicit';
  const inbox: string[] = [];
  const sent: FakeMail['sent'] = [];
  const logins: FakeMail['logins'] = [];
  let refusal: string | null = null;
  const sockets = new Set<Socket>();

  /** line reader that survives an in-place TLS upgrade */
  const serve = (raw: Socket, onLine: (l: string, io: Io) => void | Promise<void>, greet: string) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    const io: Io = {
      sock: raw,
      secure: raw instanceof TLSSocket,
      buf: '',
      data: null,
      write(s) {
        io.sock.write(s);
      },
      upgrade() {
        const t = new TLSSocket(io.sock as Socket, { isServer: true, key: cert.key, cert: cert.cert });
        t.on('error', () => {});
        io.sock.removeAllListeners('data');
        io.sock = t;
        io.secure = true;
        io.buf = '';
        t.on('data', feed);
      },
    };
    let chain = Promise.resolve();
    const feed = (d: Buffer) => {
      io.buf += d.toString('utf8');
      for (;;) {
        if (io.data) {
          const end = io.buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const body = io.buf.slice(0, end + 2);
          io.buf = io.buf.slice(end + 5);
          const done = io.data;
          io.data = null;
          chain = chain.then(() => done(body));
          continue;
        }
        const i = io.buf.indexOf('\r\n');
        if (i < 0) return;
        const l = io.buf.slice(0, i);
        io.buf = io.buf.slice(i + 2);
        chain = chain.then(() => onLine(l, io));
      }
    };
    raw.on('data', feed);
    io.write(greet);
  };

  const listen = async (handler: (s: Socket) => void): Promise<{ server: Server; port: number }> => {
    const server =
      mode === 'implicit'
        ? createTlsServer({ key: cert.key, cert: cert.cert }, handler)
        : createNetServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: (server.address() as { port: number }).port };
  };

  const imap = await listen((s) =>
    serve(
      s,
      (l, io) => {
        const sp = l.indexOf(' ');
        const tag = l.slice(0, sp);
        const rest = l.slice(sp + 1);
        const verb = rest.split(' ')[0]!.toUpperCase();
        if (verb === 'CAPABILITY')
          io.write(`* CAPABILITY IMAP4rev1${mode === 'starttls' ? ' STARTTLS' : ''}\r\n${tag} OK done\r\n`);
        else if (verb === 'STARTTLS') {
          if (mode !== 'starttls' || io.secure) io.write(`${tag} BAD no TLS here\r\n`);
          else {
            io.write(`${tag} OK begin TLS\r\n${o.afterStarttls?.imap ?? ''}`);
            io.upgrade();
          }
        } else if (verb === 'LOGIN') {
          const args = parseQuoted(rest.slice(6));
          const ok = refusal === null && args[0] === o.user && args[1] === o.pass;
          logins.push({ proto: 'imap', secure: io.secure, ok });
          io.write(ok ? `${tag} OK signed in\r\n` : `${tag} NO ${refusal ?? 'bad credentials'}\r\n`);
        } else if (verb === 'SELECT')
          io.write(`* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (verb === 'UID' && rest.split(' ')[1]?.toUpperCase() === 'SEARCH') {
          const range = rest.split(' ')[3] ?? '1:*';
          const from = Number(range.split(':')[0]) || 1;
          const ids = inbox.map((_, i) => i + 1).filter((u) => u >= from);
          io.write(`* SEARCH${ids.map((u) => ` ${u}`).join('')}\r\n${tag} OK done\r\n`);
        } else if (verb === 'UID' && rest.split(' ')[1]?.toUpperCase() === 'FETCH') {
          o.onFetch?.();
          if (o.stallFetch?.()) return;
          const uid = Number(rest.split(' ')[2]);
          const m = inbox[uid - 1];
          if (m) {
            const bytes = Buffer.byteLength(m, 'utf8');
            io.write(`* ${uid} FETCH (UID ${uid} BODY[] {${bytes}}\r\n${m})\r\n`);
          }
          io.write(`${tag} OK done\r\n`);
        } else if (verb === 'LOGOUT') {
          io.write(`* BYE\r\n${tag} OK bye\r\n`);
          io.sock.end();
        } else io.write(`${tag} BAD unknown\r\n`);
      },
      '* OK fake IMAP ready\r\n',
    ),
  );

  const smtp = await listen((s) => {
    let from = '';
    let to: string[] = [];
    let authed = false;
    serve(
      s,
      (l, io) => {
        const verb = l.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO')
          io.write(
            `250-fake.smtp\r\n${mode === 'starttls' && !io.secure ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`,
          );
        else if (verb === 'STARTTLS') {
          if (mode !== 'starttls' || io.secure) io.write('502 no TLS here\r\n');
          else {
            io.write(`220 go ahead\r\n${o.afterStarttls?.smtp ?? ''}`);
            io.upgrade();
          }
        } else if (verb === 'AUTH') {
          const b = Buffer.from(l.split(' ')[2] ?? '', 'base64')
            .toString('utf8')
            .split('\0');
          const ok = b[1] === o.user && b[2] === o.pass;
          logins.push({ proto: 'smtp', secure: io.secure, ok });
          authed = ok;
          io.write(ok ? '235 ok\r\n' : '535 no\r\n');
        } else if (verb === 'MAIL') {
          if (!authed) return io.write('530 sign in first\r\n');
          from = l.slice(l.indexOf('<') + 1, l.lastIndexOf('>'));
          to = [];
          io.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          to.push(l.slice(l.indexOf('<') + 1, l.lastIndexOf('>')));
          io.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          io.write('354 go\r\n');
          io.data = (body) => {
            const data = body
              .split('\r\n')
              .map((x) => (x.startsWith('..') ? x.slice(1) : x))
              .join('\r\n');
            sent.push({ from, to, data });
            io.write('250 queued\r\n');
          };
        } else if (verb === 'QUIT') {
          io.write('221 bye\r\n');
          io.sock.end();
        } else io.write('250 ok\r\n');
      },
      '220 fake.smtp ready\r\n',
    );
  });

  return {
    cert,
    imapPort: imap.port,
    smtpPort: smtp.port,
    deliver: (raw) => inbox.push(raw.split('\r\n').join('\n').split('\n').join('\r\n')),
    sent,
    logins,
    refuseWith(text) {
      refusal = text;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all([imap.server, smtp.server].map((sv) => new Promise((r) => sv.close(() => r(null)))));
    },
  };
}

interface Io {
  sock: Socket | TLSSocket;
  secure: boolean;
  buf: string;
  data: ((body: string) => void) | null;
  write(s: string): void;
  upgrade(): void;
}

function parseQuoted(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      let v = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++;
        v += s[i] ?? '';
        i++;
      }
      out.push(v);
      i++;
    } else if (s[i] === ' ') i++;
    else {
      const e = s.indexOf(' ', i);
      out.push(s.slice(i, e < 0 ? s.length : e));
      i = e < 0 ? s.length : e;
    }
  }
  return out;
}
