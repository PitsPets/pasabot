/**
 * Review fixes for W20: the service unit follows `pasabot update`, a background server started from a checkout is
 * still found after `current` appears, the hardened system unit refuses paths it cannot see, and the default runner
 * for `systemd --user` follows the server's own rule (headless → `user`).
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alive, runningEntry, runningPid, startServer, stopServer } from './lifecycle.js';
import { installService } from './service.js';
import { type OpsCtx, pidFilePath, prefixOf, readEnvFile } from './shared.js';
import { update } from './update.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const SERVER_JS =
  "require('node:http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1');\n" +
  "process.on('SIGTERM',()=>process.exit(0));\n";
const ENTRY = ['apps', 'server', 'dist', 'host', 'main.js'];

let dir: string;
let priv: KeyObject;
let pubPem: string;
const started: number[] = [];

/** Minimal ustar writer (files and dirs only). */
function tarGz(entries: { name: string; dir?: boolean; data?: string; mode?: number }[]) {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.dir ? '5' : '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A signed release holding a runnable fake server, the unit templates and the pinned key. */
function signedRelease(version: string) {
  const top = `pasabot-${version}`;
  const tpl = (rel: string) => readFileSync(join(repoRoot, 'deploy', rel), 'utf8');
  const tb = tarGz([
    { name: `${top}/`, dir: true },
    { name: `${top}/pasabot-release.json`, data: JSON.stringify({ name: 'pasabot', version }) },
    { name: `${top}/${ENTRY.join('/')}`, data: `// ${version}\n${SERVER_JS}` },
    { name: `${top}/apps/server/dist/package.json`, data: '{"type":"commonjs"}' },
    { name: `${top}/deploy/release-keys/test.pub`, data: pubPem },
    {
      name: `${top}/deploy/launchd/local.pasabot.server.plist`,
      data: tpl('launchd/local.pasabot.server.plist'),
    },
    { name: `${top}/deploy/systemd/pasabot.service`, data: tpl('systemd/pasabot.service') },
    { name: `${top}/deploy/systemd/pasabot-system.service`, data: tpl('systemd/pasabot-system.service') },
  ]);
  const path = join(dir, `${top}.tar.gz`);
  writeFileSync(path, tb);
  writeFileSync(`${path}.sig`, sign(null, tb, priv).toString('base64'));
  return { path, tb };
}

/** A checkout-like install root (no release installed): templates, the pinned key and a fake server. */
function checkout(name = 'checkout') {
  const root = join(dir, name);
  mkdirSync(join(root, 'apps', 'server', 'dist', 'host'), { recursive: true });
  mkdirSync(join(root, 'deploy', 'release-keys'), { recursive: true });
  for (const sub of ['systemd', 'launchd'])
    spawnSync('cp', ['-R', join(repoRoot, 'deploy', sub), join(root, 'deploy', sub)]);
  writeFileSync(join(root, 'deploy', 'release-keys', 'test.pub'), pubPem);
  writeFileSync(join(root, ...ENTRY), `// checkout\n${SERVER_JS}`);
  writeFileSync(join(root, 'apps', 'server', 'dist', 'package.json'), '{"type":"commonjs"}');
  return root;
}

function fakeBins() {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const state = join(dir, 'loaded');
  const sh = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'calls.log')}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  sh(
    'launchctl',
    `case "$1" in
  print) [ -f "${state}" ] && { echo "state = running"; exit 0; }; exit 113;;
  bootstrap) touch "${state}";;
  bootout) rm -f "${state}";;
esac
exit 0`,
  );
  sh('systemctl', `case "$*" in *is-active*) echo active;; esac\nexit 0`);
  return bin;
}

const ctxFor = (platform: NodeJS.Platform, env: Record<string, string> = {}, uid?: number): OpsCtx => ({
  env: {
    HOME: join(dir, 'home'),
    PASABOT_HOME: join(dir, 'data'),
    PASABOT_PREFIX: join(dir, 'prefix'),
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    PATH: `${fakeBins()}:${process.env.PATH}`,
    ...env,
  },
  platform,
  uid,
  out: () => {},
  err: () => {},
});
const calls = () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '');

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-svcupd-')));
  const kp = generateKeyPairSync('ed25519');
  priv = kp.privateKey;
  pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
afterEach(() => {
  for (const p of started.splice(0)) if (alive(p)) process.kill(p, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('the service runs `<prefix>/current`, so `pasabot update` changes what it runs (high)', () => {
  it('install from a checkout, then update: the unit resolves to the new release and is restarted', async () => {
    const root = checkout();
    const ctx = ctxFor('darwin', { PASABOT_ROOT: root });
    const r = installService(ctx);
    const current = join(dir, 'prefix', 'current');
    const entry = join(current, ...ENTRY);
    expect(readFileSync(r.unitPath, 'utf8')).toContain(`<string>${entry}</string>`);
    expect(readFileSync(r.unitPath, 'utf8')).not.toContain(`<string>${join(root, ...ENTRY)}</string>`);

    const rel = signedRelease('1.0.1');
    const msg = await update(ctx, rel.path);
    expect(msg).toMatch(/installed 1\.0\.1 .*restarted \(launchd\)/);
    expect(readlinkSync(current)).toBe(join('releases', '1.0.1'));
    // what launchd starts after the restart is the release, not the checkout
    expect(realpathSync(entry)).toBe(join(dir, 'prefix', 'releases', '1.0.1', ...ENTRY));
    expect(readFileSync(entry, 'utf8')).toContain('// 1.0.1');
    expect(calls()).toMatch(/launchctl kickstart -k/);
  });

  it('a unit written before this fix (pointing at the checkout) is re-rendered by update, never reported as applied', async () => {
    const root = checkout();
    const ctx = ctxFor('linux', { PASABOT_ROOT: root });
    const r = installService(ctx);
    // emulate the old unit: ExecStart at the checkout
    const old = readFileSync(r.unitPath, 'utf8').replaceAll(join(dir, 'prefix', 'current'), root);
    writeFileSync(r.unitPath, old);
    rmSync(join(dir, 'prefix', 'current'));

    const rel = signedRelease('1.0.1');
    await expect(update(ctx, rel.path, { restart: false })).rejects.toThrow(
      /does not run .*prefix\/current.*pasabot service install/,
    );
    const rel2 = signedRelease('1.0.2');
    const msg = await update(ctx, rel2.path);
    expect(msg).toMatch(/installed 1\.0\.2 .*service unit switched .*restarted \(systemd-user\)/);
    const unit = readFileSync(r.unitPath, 'utf8');
    expect(unit).toContain(`"${join(dir, 'prefix', 'current', ...ENTRY)}"`);
    expect(unit).not.toContain(join(root, ...ENTRY));
    expect(readlinkSync(join(dir, 'prefix', 'current'))).toBe(join('releases', '1.0.2'));
  });

  it('install never replaces an installed release link, and says when PASABOT_ROOT is not what it runs', async () => {
    const root = checkout();
    const ctx = ctxFor('darwin', { PASABOT_ROOT: root });
    await update(ctx, signedRelease('1.0.0').path, { restart: false });
    const r = installService(ctx);
    expect(readlinkSync(join(dir, 'prefix', 'current'))).toBe(join('releases', '1.0.0'));
    expect(r.warnings.join('\n')).toMatch(/runs .*prefix\/current .*not PASABOT_ROOT/);
  });
});

describe('background server started from a checkout survives `current` appearing (medium)', () => {
  it('stop finds the server by the entry recorded at start, after the install root changed', async () => {
    const a = checkout('a');
    const b = checkout('b');
    const ctxA = ctxFor(process.platform, { PASABOT_ROOT: a });
    await startServer(ctxA);
    const pid = runningPid(ctxA)!;
    started.push(pid);
    expect(readFileSync(pidFilePath(ctxA), 'utf8')).toBe(`${pid}\n${join(a, ...ENTRY)}\n`);
    const ctxB = ctxFor(process.platform, { PASABOT_ROOT: b }); // installRoot now points elsewhere
    expect(runningPid(ctxB)).toBe(pid);
    expect(await stopServer(ctxB)).toBe(`stopped (pid ${pid})`);
    expect(alive(pid)).toBe(false);
  });

  it('update restarts a checkout-started server into the new release', async () => {
    const prefix = join(dir, 'prefix');
    const v1 = signedRelease('1.0.0');
    const checkoutRoot = checkout();
    const ctxCheckout = ctxFor(process.platform, { PASABOT_ROOT: checkoutRoot });
    await update(ctxCheckout, v1.path, { restart: false });
    await startServer(ctxCheckout); // started from the checkout, not from current
    const oldPid = runningPid(ctxCheckout)!;
    started.push(oldPid);

    const ctx = ctxFor(process.platform); // no PASABOT_ROOT: installRoot is now <prefix>/current
    const v2 = signedRelease('1.0.1');
    const msg = await update(ctx, v2.path);
    const newPid = runningPid(ctx)!;
    started.push(newPid);
    expect(msg).toMatch(/installed 1\.0\.1 .*started \(pid \d+/);
    expect(alive(oldPid)).toBe(false);
    expect(newPid).not.toBe(oldPid);
    expect(runningEntry(ctx)).toBe(join(prefix, 'current', ...ENTRY));
    expect(await stopServer(ctx)).toBe(`stopped (pid ${newPid})`);
  });
});

describe('--system refuses paths ProtectHome hides (medium)', () => {
  it('node, the install or PASABOT_HOME under /home or /root is refused; the prefix defaults to /opt/pasabot', () => {
    const root = checkout();
    const ctx = ctxFor('linux', { PASABOT_ROOT: root });
    expect(() =>
      installService(ctx, {
        system: true,
        dryRun: true,
        node: '/home/owner/.nvm/versions/node/v24/bin/node',
      }),
    ).toThrow(/node is at \/home\/owner.*ProtectHome/);
    expect(() =>
      installService(ctxFor('linux', { PASABOT_ROOT: root, PASABOT_PREFIX: '/root/.local/share/pasabot' }), {
        system: true,
        dryRun: true,
        node: '/usr/bin/node',
      }),
    ).toThrow(/the install is at \/root\/.local\/share\/pasabot\/current.*ProtectHome/);
    expect(() =>
      installService(ctxFor('linux', { PASABOT_ROOT: root, PASABOT_HOME: '/home/owner/.pasabot' }), {
        system: true,
        dryRun: true,
        node: '/usr/bin/node',
      }),
    ).toThrow(/PASABOT_HOME is at \/home\/owner/);

    const noPrefix = ctxFor('linux', { PASABOT_ROOT: root });
    delete noPrefix.env.PASABOT_PREFIX;
    delete noPrefix.env.PASABOT_HOME;
    const r = installService(noPrefix, { system: true, dryRun: true, node: '/usr/bin/node' });
    expect(r.unit).toContain(`ExecStart="/usr/bin/node" "/opt/pasabot/current/${ENTRY.join('/')}"`);
    expect(r.unit).toContain('WorkingDirectory=/opt/pasabot/current');
    // `sudo pasabot update` (root on Linux) installs where the system unit looks
    expect(prefixOf({ ...noPrefix, uid: 0 })).toBe('/opt/pasabot');
    expect(prefixOf({ ...noPrefix, uid: 1000 })).toBe(join(dir, 'home', '.local', 'share', 'pasabot'));
    expect(calls()).toBe('');
  });
});

describe('systemd --user runner follows the server default (medium)', () => {
  it('headless → user, desktop session → host, an explicit PASABOT_RUNNER wins', () => {
    const root = checkout();
    const headless = installService(ctxFor('linux', { PASABOT_ROOT: root }), { dryRun: true });
    expect(headless.unit).toBeTruthy();
    const env = (extra: Record<string, string>) => {
      const ctx = ctxFor('linux', { PASABOT_ROOT: root, ...extra });
      rmSync(join(dir, 'data'), { recursive: true, force: true });
      return readEnvFile(installService(ctx).envFile).PASABOT_RUNNER;
    };
    expect(env({})).toBe('user');
    expect(env({ DISPLAY: ':0' })).toBe('host');
    expect(env({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('host');
    expect(env({ PASABOT_RUNNER: 'container' })).toBe('container');
  });
});
