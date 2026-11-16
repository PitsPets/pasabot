/**
 * W28: every LinkTransport passes the contract (in-memory, TCP+TLS, tailcat through a stub of the real v0.7.0 CLI),
 * plus the tailcat specifics: fixed argv with an explicit key and never an empty --allow, no shell, hostile addresses
 * never reach an argv, --allow and the linking window, the loopback port is not a way in, a minimal child environment,
 * missing binary → install help, version warning, restart with backoff, and no process left behind.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLinkTransportContract } from './contract.js';
import {
  generateLinkKeys,
  isLinkPublicKey,
  linkKeysFromPem,
  linkKeysToPem,
  signLink,
  verifyLink,
} from './keys.js';
import { createMemoryNetwork } from './memory.js';
import {
  createTailcatTransport,
  isTailcatAddress,
  TAILCAT_ARGV,
  TAILCAT_INSTALL_HELP,
  type TailcatOptions,
} from './tailcat.js';
import { createTcpTlsTransport } from './tcp-tls.js';
import { isLinkAddress, type LinkPeer, type LinkStream, type LinkTransport } from './types.js';

const STUB = fileURLToPath(new URL('./__fixtures__/tailcat-stub.mjs', import.meta.url));
chmodSync(STUB, 0o755);

/** the stub's sockets live here (short path: macOS caps Unix socket paths at 104 bytes) */
const SOCKDIR = mkdtempSync(join(tmpdir(), 'bk-tcs-'));
const saved = { ...process.env };
beforeAll(() => {
  process.env.TAILCAT_STUB_SOCKDIR = SOCKDIR;
  process.env.TAILCAT_STUB_REFUSE_MS = '400'; // the real CLI gives up after 10 s
});

const stubDirs: string[] = [];
const stubDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'bk-tc-'));
  stubDirs.push(d);
  return d;
};
/** stub CLIs from this file, and bridges (whose environment names our token variable) */
const leftovers = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(STUB) || l.includes('PASABOT_TC_PORT'));
afterAll(async () => {
  // a killed child takes a moment to exit; nothing may still be running a little later
  let left = leftovers();
  for (let i = 0; i < 60 && left.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    left = leftovers();
  }
  for (const k of ['TAILCAT_STUB_SOCKDIR', 'TAILCAT_STUB_REFUSE_MS'])
    if (saved[k] === undefined) delete process.env[k];
  expect(left).toEqual([]);
  expect(readdirSync(SOCKDIR)).toEqual([]);
  rmSync(SOCKDIR, { recursive: true, force: true });
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
});

/** a well-formed tailcat address nobody serves */
const deadTc = () => `tc${randomBytes(65).toString('base64url')}`;
const mkTailcat = (dir: string, name: string, extra: Partial<TailcatOptions> = {}) =>
  createTailcatTransport({
    keys: generateLinkKeys(),
    stateDir: join(dir, name),
    bin: STUB,
    timeoutMs: 5000,
    dialerIdleMs: 200,
    ...extra,
  });
/** a file's trimmed text, '' while it is missing (a child may not have written it yet) */
const readFileSafe = (f: string) => {
  try {
    return readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
};
const readJsonLines = <T>(f: string): T[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((x) => JSON.parse(x) as T)
    : [];
const inbox = (t: LinkTransport) => {
  const got: { stream: LinkStream; peer: LinkPeer }[] = [];
  const listening = t.listen((stream, peer) => got.push({ stream, peer }));
  const next = async () => {
    for (let i = 0; i < 200 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
    const g = got.shift();
    if (!g) throw new Error('no inbound connection');
    return g;
  };
  return { listening, next };
};

runLinkTransportContract('memory', async () => {
  const net = createMemoryNetwork();
  return {
    a: net.transport(generateLinkKeys()),
    b: net.transport(generateLinkKeys()),
    deadAddress: 'memory:nobody',
  };
});

runLinkTransportContract('tcp-tls', async () => ({
  a: createTcpTlsTransport({ keys: generateLinkKeys() }),
  b: createTcpTlsTransport({ keys: generateLinkKeys() }),
  deadAddress: 'tcp-tls://127.0.0.1:9',
}));

runLinkTransportContract('tailcat (stub of the v0.7.0 CLI)', async () => {
  const dir = stubDir();
  const a = mkTailcat(dir, 'a');
  const b = mkTailcat(dir, 'b');
  // linked machines only: a admits b's client node key (as the link module does after linking)
  await a.setAllowed!([(await b.identity()).transportKey!]);
  return {
    a,
    b,
    deadAddress: deadTc(),
    cleanup: async () => {
      await Promise.all([a.close!(), b.close!()]);
    },
  };
});

describe('link keys', () => {
  it('round-trip through PEM; signatures verify only with the right key', () => {
    const k = generateLinkKeys();
    const back = linkKeysFromPem(linkKeysToPem(k));
    expect(back.publicKey).toBe(k.publicKey);
    expect(isLinkPublicKey(k.publicKey)).toBe(true);
    expect(isLinkPublicKey('not a key')).toBe(false);
    const sig = signLink(k, 'transcript');
    expect(verifyLink(k.publicKey, 'transcript', sig)).toBe(true);
    expect(verifyLink(k.publicKey, 'transcript!', sig)).toBe(false);
    expect(verifyLink(generateLinkKeys().publicKey, 'transcript', sig)).toBe(false);
  });
});

describe('tcp-tls pins the certificate key', () => {
  it('the dialer sees exactly the listener’s long-term key (no CA involved)', async () => {
    const ka = generateLinkKeys();
    const a = createTcpTlsTransport({ keys: ka });
    const l = await a.listen((s) => s.destroy());
    const d = await createTcpTlsTransport({ keys: generateLinkKeys() }).dial((await a.identity()).address);
    expect(d.peer.publicKey).toBe(ka.publicKey);
    d.stream.destroy();
    await l.close();
  });
});

describe('tailcat CLI (stub of the real v0.7.0 grammar)', () => {
  it('spawns fixed argv with an explicit key, never an empty --allow, never the address; nothing logs it', async () => {
    const dir = stubDir();
    const logFile = join(dir, 'argv.log');
    process.env.TAILCAT_STUB_LOG = logFile;
    const logs: string[] = [];
    const log = {
      warn: (m: string, d?: Record<string, unknown>) => logs.push(`${m} ${JSON.stringify(d ?? {})}`),
    };
    const a = mkTailcat(dir, 'a', { log });
    const b = mkTailcat(dir, 'b', { log });
    try {
      expect(await a.available()).toEqual({ ok: true });
      const { listening } = inbox(a);
      const l = await listening;
      const { address } = await a.identity();
      const bKey = (await b.identity()).transportKey!;
      await a.setAllowed!([bKey]);
      const d = await b.dial(address);
      d.stream.destroy();
      const win = await a.openLinkWindow!(Date.now() + 60_000);
      expect(win).not.toBe(address);
      await a.setAllowed!([]);
      const err = await b.dial(address).catch((e: Error) => e);
      expect((err as Error).message).not.toContain(address);
      await l.close();
      const argvs = readJsonLines<string[]>(logFile);
      expect(argvs[0]).toEqual(TAILCAT_ARGV.version());
      for (const v of argvs) {
        if (v.join(' ') !== '--version') expect(v.some((x) => x.startsWith('--key='))).toBe(true);
        expect(v).not.toContain('--allow=');
        expect(v).not.toContain('--allow');
        expect(v.join(' ')).not.toContain(address);
        expect(v.join(' ')).not.toContain(win);
        expect(v).not.toContain('--json');
      }
      const serves = argvs.filter((v) => v.includes('serve'));
      // no tunnel process while nobody is linked: the first serve is the one that admits b, none ever admits nobody
      expect(serves[0]).toEqual(expect.arrayContaining(['serve', `--allow=${bKey}`, 'exec', '--']));
      expect(serves.some((v) => v.includes('--allow=none'))).toBe(false);
      expect(serves.some((v) => v[0] === '--key=new' && !v.some((x) => x.startsWith('--allow')))).toBe(true);
      expect(argvs.some((v) => v[1] === 'socks')).toBe(true);
      for (const line of logs) {
        expect(line).not.toContain(address);
        expect(line).not.toContain(win);
      }
    } finally {
      await Promise.all([a.close!(), b.close!()]);
      delete process.env.TAILCAT_STUB_LOG;
    }
  });

  it('a hostile address never reaches an argv: refused before anything is spawned', async () => {
    const dir = stubDir();
    const logFile = join(dir, 'argv.log');
    process.env.TAILCAT_STUB_LOG = logFile;
    try {
      const t = mkTailcat(dir, 's');
      const hostile = [
        '-x',
        '--key=new',
        '--',
        '-- /bin/sh',
        'tc-- ls',
        `tc${'A'.repeat(30)} --allow=none`,
        `tc${'A'.repeat(30)};rm -rf ~`,
        `tc$(id)${'A'.repeat(30)}`,
        `tc\`id\`${'A'.repeat(30)}`,
        `tc${'A'.repeat(30)}\nB`,
        ` tc${'A'.repeat(30)}`,
        `tc${'A'.repeat(300)}`,
        'tcAAAA',
        'stub-0000000000000000',
        'tcp-tls://127.0.0.1:9',
        '',
      ];
      for (const bad of hostile) {
        expect(isTailcatAddress(bad)).toBe(false);
        await expect(t.dial(bad)).rejects.toMatchObject({ code: 'bad_address' });
      }
      expect(existsSync(logFile)).toBe(false); // nothing was spawned for any of them
      expect(isTailcatAddress(deadTc())).toBe(true);
      // review fix: no command ever takes an address. `tailcat ping` only accepts it as a positional (readable by any
      // local user through `ps`), so the transport has no probe and no ping argv at all
      expect(t.probe).toBeUndefined();
      expect('ping' in TAILCAT_ARGV).toBe(false);
      expect(isLinkAddress('tcp-tls://[::1]:4433')).toBe(true);
      expect(isLinkAddress('-x')).toBe(false);
      await t.close!();
    } finally {
      delete process.env.TAILCAT_STUB_LOG;
    }
  });

  it('a machine not in --allow is refused like an unreachable one; admitted after setAllowed, refused at once after removal', async () => {
    const dir = stubDir();
    const a = mkTailcat(dir, 'a');
    const b = mkTailcat(dir, 'b');
    try {
      const { listening, next } = inbox(a);
      await listening;
      const { address } = await a.identity();
      const refused = await b.dial(address).catch((e: Error) => e);
      expect(refused).toMatchObject({ code: 'unreachable' });
      expect((refused as Error).message).toMatch(/unreachable or does not admit/);
      const bKey = (await b.identity()).transportKey!;
      await a.setAllowed!([bKey]);
      const d = await b.dial(address);
      d.stream.write('hi\n');
      const got = await next();
      expect(got.peer.transportKey).toBe(bKey); // what the tunnel saw, not what b claimed
      expect(got.peer.viaLinkWindow).toBe(false);
      // review fix: an OPEN connection of a machine that is unlinked is cut at once, not only new ones refused
      let cutBeforeRestart = false;
      let restarted = false;
      got.stream.once('close', () => {
        cutBeforeRestart = !restarted;
      });
      await a.setAllowed!([]);
      restarted = true;
      expect(cutBeforeRestart).toBe(true); // cut by the transport itself, not later when tailcat goes away
      d.stream.destroy();
      await expect(b.dial(address)).rejects.toMatchObject({ code: 'unreachable' });
      expect(await a.status!()).toMatchObject({ serving: false, linked: 0 }); // nobody left: no tunnel process
    } finally {
      await Promise.all([a.close!(), b.close!()]);
    }
  });

  it('the linking window admits any key on its own address, marks the connection, and is gone once closed', async () => {
    const dir = stubDir();
    const a = mkTailcat(dir, 'a');
    const b = mkTailcat(dir, 'b');
    try {
      const { listening, next } = inbox(a);
      await listening;
      const until = Date.now() + 60_000;
      const win = await a.openLinkWindow!(until);
      expect(await a.openLinkWindow!(until + 1000)).toBe(win); // a second code reuses the open window
      expect((await a.status!()).linkWindow).toBe(true);
      const d = await b.dial(win);
      const got = await next();
      expect(got.peer.viaLinkWindow).toBe(true);
      expect(got.peer.transportKey).toBe((await b.identity()).transportKey);
      expect(got.peer.publicKey).toBe((await b.identity()).publicKey);
      d.stream.destroy();
      got.stream.destroy();
      await a.closeLinkWindow!();
      expect((await a.status!()).linkWindow).toBe(false);
      await expect(b.dial(win)).rejects.toMatchObject({ code: 'unreachable' });
      // and the window closes by itself at its deadline
      const short = await a.openLinkWindow!(Date.now() + 150);
      await new Promise((r) => setTimeout(r, 600));
      expect((await a.status!()).linkWindow).toBe(false);
      await expect(b.dial(short)).rejects.toMatchObject({ code: 'unreachable' });
    } finally {
      await Promise.all([a.close!(), b.close!()]);
    }
  });

  it('the loopback port is not a way in; children get a minimal environment with HOME in our state dir', async () => {
    const dir = stubDir();
    const envLog = join(dir, 'env.log');
    process.env.TAILCAT_STUB_ENVLOG = envLog;
    process.env.PASABOT_SOME_SECRET = 'do-not-pass';
    const a = mkTailcat(dir, 'a');
    try {
      await a.setAllowed!([`nodekey:${'1'.repeat(64)}`]); // someone linked, so the tunnel runs
      const got: LinkPeer[] = [];
      const l = await a.listen((s, p) => {
        got.push(p);
        s.destroy();
      });
      const entries = readJsonLines<{ argv: string[]; names: string[]; port: string | null; home: string }>(
        envLog,
      );
      const serve = entries.find((e) => e.argv.includes('serve'))!;
      for (const e of entries) {
        expect(e.names).not.toContain('PASABOT_SOME_SECRET');
        expect(e.home.startsWith(join(dir, 'a'))).toBe(true);
      }
      // a local process that dials the loopback port: without the token it never reaches the peer proof
      for (const line of [
        '',
        '{"tok":"guess","peer":""}\n',
        `{"tok":"","peer":"nodekey:${'0'.repeat(64)}"}\n`,
      ]) {
        const closed = await new Promise<boolean>((res) => {
          const s = connect(Number(serve.port), '127.0.0.1', () => s.write(`${line}{"v":1}\n`));
          s.on('error', () => {});
          s.on('data', () => res(false)); // a peer proof would answer with our hello
          s.on('close', () => res(true));
          setTimeout(() => {
            s.destroy();
            res(true);
          }, 6000).unref();
        });
        expect(closed).toBe(true);
      }
      expect(got).toEqual([]);
      await l.close();
    } finally {
      await a.close!();
      delete process.env.TAILCAT_STUB_ENVLOG;
      delete process.env.PASABOT_SOME_SECRET;
    }
  });

  it('a serve that dies is started again with backoff; close leaves nothing running', async () => {
    const dir = stubDir();
    const logs: string[] = [];
    const a = mkTailcat(dir, 'a', { log: { warn: (m) => logs.push(m) } });
    const b = mkTailcat(dir, 'b');
    try {
      await a.setAllowed!([(await b.identity()).transportKey!]);
      const { listening } = inbox(a);
      await listening;
      const { address } = await a.identity();
      const servePid = () =>
        execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
          .split('\n')
          .find((l) => l.includes(STUB) && l.includes(join(dir, 'a')) && l.includes(' serve '))
          ?.trim()
          .split(/\s+/)[0];
      const pid = Number(servePid());
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 'SIGKILL');
      for (let i = 0; i < 100 && (await a.status!()).restarts === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 200 && !(await a.status!()).serving; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(await a.status!()).toMatchObject({ serving: true, restarts: 1 });
      expect(logs).toContain('tailcat stopped; starting it again');
      expect((await a.identity()).address).toBe(address); // the saved server key keeps the address
      const d = await b.dial(address);
      d.stream.destroy();
    } finally {
      await Promise.all([a.close!(), b.close!()]);
    }
    expect(existsSync(join(dir, 'a', 'children.json'))).toBe(true);
  });

  it('while nobody is linked, listening runs no tunnel process and makes no key (nothing touches the relays)', async () => {
    const dir = stubDir();
    const logFile = join(dir, 'argv.log');
    process.env.TAILCAT_STUB_LOG = logFile;
    const a = mkTailcat(dir, 'a');
    try {
      await a.setAllowed!([]);
      const l = await a.listen(() => {});
      expect(readJsonLines<string[]>(logFile)).toEqual([TAILCAT_ARGV.version()]);
      expect(await a.status!()).toMatchObject({ serving: false, linked: 0, linkWindow: false });
      await l.close();
    } finally {
      await a.close!();
      delete process.env.TAILCAT_STUB_LOG;
    }
  });

  it('close() also stops a one-shot tailcat command that is still running (review fix)', async () => {
    const dir = stubDir();
    process.env.TAILCAT_STUB_HANG_GENKEY = '1';
    const t = mkTailcat(dir, 'h', { timeoutMs: 20_000 });
    const mine = () => leftovers().filter((l) => l.includes(join(dir, 'h')) && l.includes('genkey'));
    try {
      const pending = t.identity(); // genkey hangs in the stub
      for (let i = 0; i < 200 && !mine().length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(mine()).toHaveLength(1);
      await t.close!();
      for (let i = 0; i < 100 && mine().length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(mine()).toEqual([]);
      await pending; // identity() swallows the failed key set-up
    } finally {
      delete process.env.TAILCAT_STUB_HANG_GENKEY;
    }
  });

  it('a missing binary answers with install help (available, listen and dial)', async () => {
    const dir = stubDir();
    const t = createTailcatTransport({
      keys: generateLinkKeys(),
      stateDir: join(dir, 's'),
      bin: join(dir, 'no-such-tailcat'),
    });
    expect(await t.available()).toEqual({ ok: false, installHelp: TAILCAT_INSTALL_HELP });
    await expect(t.listen(() => {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(t.dial(deadTc())).rejects.toMatchObject({ code: 'unavailable' });
    expect(TAILCAT_INSTALL_HELP).toContain('brew install tailcat');
    expect(TAILCAT_INSTALL_HELP).toContain('go install github.com/tailscale/tailcat/cmd/tailcat@v0.7.0');
    await t.close!();
  });

  it('v0.7.x is accepted quietly; another version still works but warns once', async () => {
    const logs: string[] = [];
    const t = mkTailcat(stubDir(), 's', { log: { warn: (m) => logs.push(m) } });
    try {
      process.env.TAILCAT_STUB_VERSION = 'v0.7.4';
      expect(await t.available()).toEqual({ ok: true });
      expect(logs).toEqual([]);
      process.env.TAILCAT_STUB_VERSION = 'v0.9.0';
      expect(await t.available()).toEqual({ ok: true });
      await t.available();
      expect(logs).toEqual(['tailcat version differs from the one PasaBot was tested with']);
      expect(await t.status!()).toMatchObject({ version: 'v0.9.0' });
    } finally {
      delete process.env.TAILCAT_STUB_VERSION;
    }
  });

  it('the stub keeps the real CLI traps: one-way default serve, `--` runs a command, refusal is silent', async () => {
    const dir = stubDir();
    const run = (args: string[], input = '', extraEnv: Record<string, string> = {}) =>
      new Promise<{ code: number | null; out: string; err: string }>((res) => {
        const c = spawn(STUB, args, { env: { ...process.env, ...extraEnv } });
        let out = '';
        let err = '';
        c.stdout!.on('data', (d: Buffer) => (out += d));
        c.stderr!.on('data', (d: Buffer) => (err += d));
        c.on('close', (code) => res({ code, out, err }));
        c.stdin!.end(input);
      });
    const addrFile = join(dir, 'addr');
    // `tailcat --key=new -- <cmd>` is a SERVER that runs <cmd>; it never dials anything
    const trap = spawn(STUB, ['--key=new', '--', 'echo', 'ran'], {
      env: { ...process.env, TAILCAT_ADDR_FILE: addrFile },
    });
    let trapErr = '';
    trap.stderr!.on('data', (d: Buffer) => (trapErr += d));
    for (let i = 0; i < 250 && !(readFileSafe(addrFile) && trapErr.includes('Server listening')); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(trapErr).toContain('Server listening with new address');
    const addr = readFileSafe(addrFile);
    expect(trapErr).toContain(addr);
    const ran = await run(['--key=new', addr, '7']);
    trap.kill();
    expect(ran).toMatchObject({ code: 0, out: 'ran\n' });
    // default serve: one connection, client → server only
    rmSync(addrFile, { force: true });
    const oneWay = spawn(STUB, ['--key=new', 'serve'], {
      env: { ...process.env, TAILCAT_ADDR_FILE: addrFile },
    });
    let served = '';
    oneWay.stdout!.on('data', (d: Buffer) => (served += d));
    // listen for its exit before the client runs: the one-shot server may be gone before the client is
    const oneWayDone = new Promise<void>((r) => oneWay.once('close', () => r()));
    for (let i = 0; i < 250 && !readFileSafe(addrFile); i++) await new Promise((r) => setTimeout(r, 20));
    const c = await run(['--key=new', readFileSafe(addrFile)], 'hello\n');
    expect(c).toMatchObject({ code: 0, out: '' });
    await oneWayDone;
    expect(served).toBe('hello\n');
    // a refused client: exit 1, the same message as an unreachable one
    const r = await run(['--key=new', deadTc()], 'x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('tailcat Ping: context deadline exceeded');
    // usage errors exit 1
    expect((await run(['serve', '--nope'])).code).toBe(1);
  });
});
