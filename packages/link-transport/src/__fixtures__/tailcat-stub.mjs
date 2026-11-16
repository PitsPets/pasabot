#!/usr/bin/env node
// A stand-in for the real `tailcat` v0.7.0 CLI in tests, with the same argv grammar, stderr lines, exit codes and
// behaviour PasaBot relies on, over Unix sockets instead of WireGuard + DERP (no network):
//
//   tailcat --version | version                          → "v0.7.0" (TAILCAT_STUB_VERSION overrides)
//   tailcat genkey [--client] [--fixed-region] [--force] --key=<path>
//                                                        → server: prints its address; --client: "nodekey:<hex>"
//   tailcat --key=<k> printpub                           → "nodekey:<hex>"
//   tailcat [--key=<k>] serve [--allow=<keys>|none] [<ports>|exec] [-- cmd …]
//        no services: ONE connection, one-way (client → our stdout), then exit; <port>: proxy to localhost:<port>;
//        exec / `-- cmd`: run cmd per connection with it as stdin/stdout, $TAILCAT_PEER_KEY and $TAILCAT_REMOTE_ADDR.
//        Prints "# 🐈 Server listening with new address: <addr>" (or `with saved key "<k>": <addr>`) on stderr and writes
//        the address to $TAILCAT_ADDR_FILE. No --allow (or an empty one) admits everyone; `--allow` without `=` takes
//        the NEXT argument as its value (the real flag parser does that too).
//   tailcat [--key=<k>] -- cmd …                         → server exec mode (the real CLI's trap)
//   tailcat [--key=<k>] <addr> [port]                    → client: stdin/stdout to that server (port default 1)
//   tailcat [--key=<k>] socks [--listen=127.0.0.1:0]     → SOCKS5 proxy; "… SOCKS running at socks5h://127.0.0.1:<p>"
//   tailcat [--key=<k>] ping [--until-direct] [--timeout=…] <addr>
//                                                        → "pong in 412µs via 127.0.0.1:41641" (TAILCAT_STUB_PATH=derp:
//                                                          "pong in 12.30ms via DERP(stub)", exit 1 with --until-direct)
// A client the server does not admit is dropped silently: it fails only after TAILCAT_STUB_REFUSE_MS (default 10000,
// like the real 10 s) with "tailcat Ping: context deadline exceeded" and exit 1, exactly like an unreachable server.
// Usage errors exit 1. Sockets live in $TAILCAT_STUB_SOCKDIR (default the OS temp dir). TAILCAT_STUB_LOG (a file)
// records each argv as one JSON line. The stub exits on SIGTERM and when its parent is gone.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;
if (env.TAILCAT_STUB_LOG) appendFileSync(env.TAILCAT_STUB_LOG, `${JSON.stringify(argv)}\n`);
// TAILCAT_STUB_ENVLOG (a file): the names of the variables this process got, plus the few values tests check
if (env.TAILCAT_STUB_ENVLOG)
  appendFileSync(
    env.TAILCAT_STUB_ENVLOG,
    `${JSON.stringify({ argv, names: Object.keys(env).sort(), port: env.PASABOT_TC_PORT ?? null, home: env.HOME ?? null })}\n`,
  );
const kids = new Set();
const cleanups = [];
const bye = (code) => {
  for (const k of kids) k.kill();
  for (const c of cleanups) c();
  process.exit(code);
};
process.on('SIGTERM', () => bye(0));
process.on('SIGINT', () => bye(0));
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) bye(0);
}, 200).unref();
const usage = (msg) => {
  process.stderr.write(`tailcat: ${msg}\n`);
  process.exit(1);
};
const REFUSE_MS = Number(env.TAILCAT_STUB_REFUSE_MS ?? 10_000);
const SOCKDIR = env.TAILCAT_STUB_SOCKDIR || tmpdir();

// ---------- keys and addresses ----------
const nodeKeyOf = (priv) => `nodekey:${createHash('sha256').update(priv).digest('hex')}`;
const newKey = (client) => ({
  stub: 1,
  client,
  priv: randomBytes(32).toString('hex'),
  psk: randomBytes(32).toString('hex'),
});
const keyPath = (k) =>
  k.includes('/') || k.includes('\\')
    ? k
    : join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '.', '.config'), 'tailcat', 'keys', `${k}.private.json`);
const loadKey = (k, mode) => {
  if (k === 'new') return { key: newKey(mode === 'client'), saved: null };
  const name = k ?? (mode === 'client' ? 'client-default' : 'default');
  const p = keyPath(name);
  if (!existsSync(p)) {
    if (k) usage(`key ${JSON.stringify(k)} not found`);
    return { key: newKey(mode === 'client'), saved: null };
  }
  return { key: JSON.parse(readFileSync(p, 'utf8')), saved: k ?? name };
};
const addressOf = (key) =>
  `tc${Buffer.concat([Buffer.from(createHash('sha256').update(key.priv).digest('hex'), 'hex'), Buffer.from(key.psk, 'hex'), Buffer.from([0x3c])]).toString('base64url')}`;
const parseAddr = (a) => {
  if (typeof a !== 'string' || !/^tc[A-Za-z0-9_-]+$/.test(a)) return null;
  const b = Buffer.from(a.slice(2), 'base64url');
  if (b.length !== 65) return null;
  return { pub: b.subarray(0, 32).toString('hex'), psk: b.subarray(32, 64).toString('hex') };
};
const sockOf = (pubHex) => join(SOCKDIR, `tcs-${pubHex.slice(0, 16)}.sock`);

// ---------- argv: global flags, then the subcommand ----------
const global = {};
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') break;
  if (!a.startsWith('--')) break;
  const [name, ...v] = a.slice(2).split('=');
  if (!['key', 'json', 'verbose', 'derpmap-url', 'version'].includes(name))
    usage(`flag provided but not defined: -${name}`);
  global[name] = v.length ? v.join('=') : true;
}
const rest = argv.slice(i);
const SUBS = ['serve', 'ping', 'socks', 'genkey', 'printpub', 'version', 'readme', 'parse'];

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');

/** the stub tunnel: a client sends one JSON line (its node key, the port, the psk), the server answers "meowed" */
const tunnelDial = (addr, clientKey, port, extra = {}) =>
  new Promise((resolve) => {
    const started = Date.now();
    const p = parseAddr(addr);
    const refused = () => setTimeout(() => resolve(null), Math.max(0, REFUSE_MS - (Date.now() - started)));
    if (!p) return refused();
    const s = createConnection({ path: sockOf(p.pub), allowHalfOpen: true }); // TCP-like half-close
    let buf = '';
    let done = false;
    s.once('error', () => {
      if (!done) {
        done = true;
        refused();
      }
    });
    s.once('close', () => {
      if (!done) {
        done = true;
        refused();
      }
    });
    s.once('connect', () =>
      s.write(`${JSON.stringify({ peer: nodeKeyOf(clientKey.priv), port, psk: p.psk, ...extra })}\n`),
    );
    const onData = (c) => {
      buf += c.toString('latin1');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      s.off('data', onData);
      done = true;
      if (buf.slice(0, nl) !== 'meowed') {
        s.destroy();
        return refused();
      }
      const leftover = Buffer.from(buf.slice(nl + 1), 'latin1');
      s.removeAllListeners('error');
      s.on('error', () => {});
      s.pause();
      if (leftover.length) s.unshift(leftover);
      resolve(s);
    };
    s.on('data', onData);
  });

const runServe = (args, execCmd) => {
  let allow = null; // null = everyone
  const services = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a.startsWith('--allow=')) allow = a.slice('--allow='.length) || null;
    else if (a === '--allow')
      allow = args[++j] ?? null; // swallows the next argument, like the real parser
    else if (a === '--full-address' || a.startsWith('--psk')) {
    } else if (a.startsWith('-')) usage(`flag provided but not defined: ${a}`);
    else services.push(...a.split(',').filter(Boolean));
  }
  const allowList = allow === null ? null : allow === 'none' ? [] : allow.split(',');
  if (allowList?.some((k) => !/^nodekey:[0-9a-f]{64}$/.test(k))) usage('invalid --allow key');
  if (execCmd && !services.includes('exec')) services.push('exec');
  const ports = services.filter((x) => /^\d+$/.test(x)).map(Number);
  const exec = services.includes('exec');
  if (exec && !execCmd?.length) usage('exec service needs a command after --');
  for (const s of services) if (!/^\d+$/.test(s) && s !== 'exec') usage(`unknown service ${s}`);
  const oneShot = !exec && !ports.length;
  const { key, saved } = loadKey(global.key, 'server');
  const pub = createHash('sha256').update(key.priv).digest('hex');
  const addr = addressOf(key);
  const path = sockOf(pub);
  try {
    unlinkSync(path);
  } catch {}
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('error', () => {});
    let buf = '';
    const onData = (c) => {
      buf += c.toString('latin1');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.off('data', onData);
      let hello = {};
      try {
        hello = JSON.parse(buf.slice(0, nl));
      } catch {}
      // silently dropped, like the real server: no answer at all
      if (hello.psk !== key.psk || (allowList && !allowList.includes(hello.peer))) return sock.destroy();
      sock.write('meowed\n');
      if (hello.ping) return sock.end();
      const leftover = Buffer.from(buf.slice(nl + 1), 'latin1');
      if (ports.includes(hello.port)) {
        const up = createConnection(hello.port, '127.0.0.1');
        up.on('error', () => sock.destroy());
        if (leftover.length) up.write(leftover);
        sock.pipe(up);
        up.pipe(sock);
        sock.on('close', () => up.destroy());
        up.on('close', () => sock.destroy());
      } else if (exec) {
        const k = spawn(execCmd[0], execCmd.slice(1), {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...env, TAILCAT_PEER_KEY: hello.peer, TAILCAT_REMOTE_ADDR: '[fd7a:115c:a1e0::1]:41641' },
        });
        kids.add(k);
        k.on('close', () => {
          kids.delete(k);
          sock.end();
        });
        k.on('error', () => sock.destroy());
        k.stdin.on('error', () => {});
        if (leftover.length) k.stdin.write(leftover);
        sock.pipe(k.stdin);
        k.stdout.pipe(sock);
        sock.on('close', () => k.stdin.destroy());
      } else if (oneShot) {
        server.close();
        if (leftover.length) process.stdout.write(leftover);
        sock.pipe(process.stdout); // one-way: nothing goes back to the client
        sock.on('end', () => sock.end());
        sock.on('close', () => process.stdout.write('', () => bye(0)));
      } else sock.destroy(); // a port nobody serves
    };
    sock.on('data', onData);
  });
  let ino = null;
  cleanups.push(() => {
    try {
      if (ino !== null && statSync(path).ino === ino) unlinkSync(path);
    } catch {}
  });
  server.listen(path, () => {
    ino = statSync(path).ino;
    process.stderr.write('# Selected bootstrap relay region 900, Stub\n');
    if (exec) process.stderr.write(`# Running ${execCmd.join(' ')} for each connection\n`);
    process.stderr.write(
      `# 🐈 Server listening with ${saved ? `saved key ${JSON.stringify(saved)}` : 'new address'}: ${addr}\n`,
    );
    if (env.TAILCAT_ADDR_FILE && !env.TAILCAT_ADDR_FILE.startsWith('tcp:'))
      writeFileSync(env.TAILCAT_ADDR_FILE, `${addr}\n`);
    if (global.json) process.stdout.write(`${JSON.stringify({ listenAddr: addr })}\n`);
  });
};

const failClient = () => {
  process.stderr.write(`${now()} tailcat Ping: context deadline exceeded\n`);
  process.exit(1);
};

if (global.version) {
  process.stdout.write(`${env.TAILCAT_STUB_VERSION ?? 'v0.7.0'}\n`);
} else if (rest[0] === '--') {
  runServe([], rest.slice(1)); // the trap: `tailcat -- <cmd>` serves and RUNS <cmd>
} else if (rest.length === 0) {
  runServe([]);
} else if (rest[0] === 'version') {
  process.stdout.write(`${env.TAILCAT_STUB_VERSION ?? 'v0.7.0'}\n`);
} else if (rest[0] === 'serve') {
  const dd = rest.indexOf('--');
  runServe(dd < 0 ? rest.slice(1) : rest.slice(1, dd), dd < 0 ? null : rest.slice(dd + 1));
} else if (rest[0] === 'genkey') {
  // test knob: a one-shot command that is still running when the transport closes
  if (env.TAILCAT_STUB_HANG_GENKEY) await new Promise((r) => setTimeout(r, 30_000));
  let client = false;
  let force = false;
  let k = null;
  for (const a of rest.slice(1)) {
    if (a === '--client') client = true;
    else if (a === '--force') force = true;
    else if (a === '--fixed-region' || a.startsWith('--region=')) {
    } else if (a.startsWith('--key=')) k = a.slice(6);
    else usage(`genkey: unexpected ${a}`);
  }
  if (!k) usage('genkey: --key is required');
  const p = keyPath(k);
  if (existsSync(p) && !force) usage(`genkey: ${p} exists; use --force`);
  const key = newKey(client);
  writeFileSync(p, JSON.stringify(key), { mode: 0o600 });
  process.stderr.write(`# wrote file to ${p}\n`);
  process.stdout.write(`${client ? nodeKeyOf(key.priv) : addressOf(key)}\n`);
} else if (rest[0] === 'printpub') {
  process.stdout.write(`${nodeKeyOf(loadKey(global.key, 'client').key.priv)}\n`);
} else if (rest[0] === 'ping') {
  const target = rest.slice(1).find((a) => !a.startsWith('-'));
  if (!target) usage('ping: missing address');
  const { key } = loadKey(global.key, 'client');
  const t0 = process.hrtime.bigint();
  tunnelDial(target, key, 1, { ping: true }).then((s) => {
    if (!s) return failClient();
    s.destroy();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(
      env.TAILCAT_STUB_PATH === 'derp'
        ? `pong in ${ms.toFixed(2)}ms via DERP(stub)\n`
        : `pong in ${Math.round(ms * 1000)}µs via 127.0.0.1:41641\n`,
    );
    // like the real one: with --until-direct, only relay pongs = exit 1
    process.exit(env.TAILCAT_STUB_PATH === 'derp' && rest.includes('--until-direct') ? 1 : 0);
  });
} else if (rest[0] === 'socks') {
  let listen = '127.0.0.1:0';
  for (const a of rest.slice(1)) {
    if (a.startsWith('--listen=')) listen = a.slice(9);
    else usage(`socks: unexpected ${a}`);
  }
  const [host, port] = listen.includes(':')
    ? [listen.slice(0, listen.lastIndexOf(':')) || '0.0.0.0', listen.slice(listen.lastIndexOf(':') + 1)]
    : ['127.0.0.1', listen];
  const { key } = loadKey(global.key, 'client');
  const server = createServer((c) => {
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = async (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        c.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || buf.length < 5) return;
      if (buf[3] !== 3) return c.destroy();
      const len = buf[4];
      if (buf.length < 7 + len) return;
      const target = buf.subarray(5, 5 + len).toString('latin1');
      const dport = buf.readUInt16BE(5 + len);
      const extra = buf.subarray(7 + len);
      stage = 2;
      c.off('data', onData);
      c.pause();
      const s = await tunnelDial(target, key, dport);
      const reply = (rep) =>
        Buffer.concat([Buffer.from([5, rep, 0, 4]), Buffer.alloc(16), Buffer.from([0, 0])]);
      if (!s) {
        c.end(reply(1));
        return;
      }
      c.write(reply(0));
      if (extra.length) s.write(extra);
      c.pipe(s);
      s.pipe(c);
      s.resume();
      c.resume();
      c.on('close', () => s.destroy());
      s.on('close', () => c.destroy());
    };
    c.on('data', onData);
  });
  server.listen(Number(port), host, () => {
    process.stderr.write(`${now()} SOCKS running at socks5h://127.0.0.1:${server.address().port}\n`);
  });
} else if (SUBS.includes(rest[0])) {
  usage(`${rest[0]}: not in the stub`);
} else if (rest[0].startsWith('tc') || rest[0].includes('.')) {
  const target = rest[0];
  const port = rest[1] === undefined ? 1 : Number(rest[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || rest.length > 2)
    usage('usage: tailcat <tc-addr> [port]');
  const { key } = loadKey(global.key, 'client');
  tunnelDial(target, key, port).then((s) => {
    if (!s) return failClient();
    s.pipe(process.stdout);
    process.stdin.pipe(s);
    s.resume();
    process.stdin.on('end', () => s.end());
    s.on('close', () => process.stdout.write('', () => process.exit(0)));
  });
} else usage(`unknown command ${JSON.stringify(rest[0])}`);
