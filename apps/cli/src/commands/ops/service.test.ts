import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alive, restartServer, runningPid, serviceState, startServer, stopServer } from './lifecycle.js';
import { tailFile } from './logs.js';
import { installService, uninstallService } from './service.js';
import { type OpsCtx, pidFilePath, readEnvFile } from './shared.js';
import { uninstall } from './uninstall.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

let dir: string;
let calls: string;
let started: number[] = [];

/** A temp install root: the real deploy/ templates + a tiny fake server entry. */
function fakeRoot(withSpaces = false) {
  const root = join(dir, withSpaces ? 'install with space' : 'install');
  mkdirSync(join(root, 'apps', 'server', 'dist', 'host'), { recursive: true });
  mkdirSync(join(root, 'deploy'), { recursive: true });
  for (const sub of ['systemd', 'launchd'])
    spawnSync('cp', ['-R', join(repoRoot, 'deploy', sub), join(root, 'deploy', sub)]);
  writeFileSync(
    join(root, 'apps', 'server', 'dist', 'host', 'main.js'),
    "require('node:http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>console.log('fake server up'));\n" +
      "process.on('SIGTERM',()=>{console.log('bye');process.exit(0)});\n",
  );
  writeFileSync(join(root, 'apps', 'server', 'dist', 'package.json'), '{"type":"commonjs"}');
  return root;
}

/** Fake launchctl/systemctl on PATH that record their argv and answer like the real tools. */
function fakeBins() {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  calls = join(dir, 'calls.log');
  const state = join(dir, 'loaded');
  const sh = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
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

const ctxFor = (platform: NodeJS.Platform, root: string, extra: Record<string, string> = {}): OpsCtx => ({
  env: {
    HOME: dir,
    PASABOT_HOME: join(dir, 'data'),
    PASABOT_ROOT: root,
    PASABOT_PREFIX: join(dir, 'prefix'),
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    PATH: `${fakeBins()}:${process.env.PATH}`,
    ...extra,
  },
  platform,
  out: () => {},
  err: () => {},
});
const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pasabot-svc-'));
  started = [];
});
afterEach(() => {
  // every process a test started is gone before the next test
  for (const p of started) if (alive(p)) process.kill(p, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('launchd (macOS)', () => {
  it('install writes a valid plist with the default host runner and bootstraps it; stop/start/restart/uninstall', async () => {
    const root = fakeRoot(true);
    const ctx = ctxFor('darwin', root, { PASABOT_VAULT_PASSPHRASE: 'never-in-unit' });
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'pasabot.env'), 'PASABOT_VAULT_PASSPHRASE=secret-value\n', {
      mode: 0o600,
    });
    const r = installService(ctx);
    expect(r.manager).toBe('launchd');
    expect(r.unitPath).toBe(join(dir, 'Library', 'LaunchAgents', 'local.pasabot.server.plist'));
    const plist = readFileSync(r.unitPath, 'utf8');
    expect(plist).toContain('<string>local.pasabot.server</string>');
    // the unit runs the stable `<prefix>/current`, bootstrapped as a link to this install
    const current = join(dir, 'prefix', 'current');
    expect(plist).toContain(`<string>${join(current, 'apps', 'server', 'dist', 'host', 'main.js')}</string>`);
    expect(readlinkSync(current)).toBe(realpathSync(root));
    expect(plist).toContain('<key>PASABOT_RUNNER</key><string>host</string>');
    expect(plist).not.toContain('secret-value');
    expect(r.warnings.join()).toMatch(/PASABOT_VAULT_PASSPHRASE.*never copied/);
    if (existsSync('/usr/bin/plutil'))
      expect(spawnSync('/usr/bin/plutil', ['-lint', r.unitPath]).status).toBe(0);
    expect(readEnvFile(r.envFile)).toMatchObject({ PASABOT_RUNNER: 'host', PASABOT_HOST: '127.0.0.1' });
    expect(statSync(r.envFile).mode & 0o777).toBe(0o600);
    expect(log()).toMatch(/launchctl bootstrap gui\/\d+ .*local\.pasabot\.server\.plist/);

    expect(serviceState(ctx)).toMatchObject({ manager: 'launchd', running: true });
    expect(await stopServer(ctx)).toBe('stopped (launchd)');
    expect(log()).toMatch(/launchctl bootout gui\/\d+\/local\.pasabot\.server/);
    expect(await startServer(ctx)).toBe('started (launchd)');
    expect(await restartServer(ctx)).toBe('restarted (launchd)');
    expect(log()).toMatch(/launchctl kickstart -k gui\/\d+\/local\.pasabot\.server/);

    const lines = await uninstall(ctx);
    expect(lines.join('\n')).toMatch(/service removed/);
    expect(existsSync(r.unitPath)).toBe(false);
    expect(existsSync(join(dir, 'data', 'pasabot.env'))).toBe(true); // data kept
  });
});

describe('systemd (Linux)', () => {
  it('user service: quoted ExecStart, env file, daemon-reload + enable --now; uninstall disables', () => {
    const root = fakeRoot(true);
    const ctx = ctxFor('linux', root);
    const r = installService(ctx);
    expect(r.manager).toBe('systemd-user');
    expect(r.unitPath).toBe(join(dir, 'xdg', 'systemd', 'user', 'pasabot.service'));
    const unit = readFileSync(r.unitPath, 'utf8');
    expect(unit).toContain(
      `ExecStart="${process.execPath}" "${join(dir, 'prefix', 'current', 'apps', 'server', 'dist', 'host', 'main.js')}"`,
    );
    expect(unit).toContain(`EnvironmentFile=-${join(dir, 'data', 'pasabot.env')}`);
    expect(unit).toContain(`Environment="PASABOT_HOME=${join(dir, 'data')}"`);
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(readEnvFile(r.envFile).PASABOT_RUNNER).toBe('user'); // no desktop session: a headless server
    expect(log()).toMatch(/systemctl --user daemon-reload\nsystemctl --user enable --now pasabot\.service/);
    expect(serviceState(ctx)).toMatchObject({ manager: 'systemd-user', running: true });
    expect(uninstallService(ctx)).toBe(r.unitPath);
    expect(log()).toMatch(/systemctl --user disable --now pasabot\.service/);
    expect(existsSync(r.unitPath)).toBe(false);
  });

  it('system service (dry run): pasabot user, runner user, hardening, state in /var/lib/pasabot', () => {
    const ctx = ctxFor('linux', fakeRoot());
    delete ctx.env.PASABOT_HOME;
    const r = installService(ctx, { system: true, dryRun: true, node: '/usr/bin/node' });
    expect(r.manager).toBe('systemd-system');
    expect(r.unitPath).toBe('/etc/systemd/system/pasabot.service');
    expect(r.unit).toContain('User=pasabot');
    expect(r.unit).toContain('ProtectSystem=strict');
    expect(r.unit).toContain('ReadWritePaths=/var/lib/pasabot');
    expect(r.unit).toContain('EnvironmentFile=-/var/lib/pasabot/pasabot.env');
    expect(log()).toBe(''); // a dry run touches nothing
  });
});

describe('no service installed: background process', () => {
  it('start runs the server detached with a pid file and log, stop ends it', async () => {
    const root = fakeRoot();
    const ctx = ctxFor(process.platform, root);
    const msg = await startServer(ctx);
    expect(msg).toMatch(/started \(pid \d+/);
    const pid = runningPid(ctx)!;
    started.push(pid);
    expect(pid).toBeGreaterThan(1);
    expect(alive(pid)).toBe(true);
    expect(await startServer(ctx)).toMatch(/already running/);
    for (let i = 0; i < 50 && !tailFile(join(dir, 'data', 'logs', 'server.log'), 5); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(tailFile(join(dir, 'data', 'logs', 'server.log'), 5)).toContain('fake server up');
    expect(statSync(join(dir, 'data', 'logs', 'server.log')).mode & 0o777).toBe(0o600);
    expect(await stopServer(ctx)).toBe(`stopped (pid ${pid})`);
    expect(alive(pid)).toBe(false);
    expect(existsSync(pidFilePath(ctx))).toBe(false);
    expect(await stopServer(ctx)).toBe('not running');
  });

  it('a stale pid that belongs to another program is never signalled', async () => {
    const ctx = ctxFor(process.platform, fakeRoot());
    mkdirSync(join(dir, 'data', 'run'), { recursive: true });
    writeFileSync(pidFilePath(ctx), `${process.pid}\n`); // the test runner itself, not a PasaBot server
    expect(runningPid(ctx)).toBeNull();
    expect(await stopServer(ctx)).toBe('not running');
    expect(alive(process.pid)).toBe(true);
  });

  it('start reports a server that dies at once', async () => {
    const root = fakeRoot();
    writeFileSync(join(root, 'apps', 'server', 'dist', 'host', 'main.js'), 'process.exit(3)\n');
    await expect(startServer(ctxFor(process.platform, root))).rejects.toThrow(/exited at start/);
  });
});

describe('as root, nothing planted in the state folder is followed', () => {
  // `sudo pasabot service install --system` (or `sudo pasabot update`) writes into the state folder that the
  // `pasabot` user owns after the first start; a link planted there must never make root chmod or overwrite its target
  const asRoot = (root: string): OpsCtx => ({ ...ctxFor('linux', root), uid: 0 });
  const victim = () => {
    const d = join(dir, 'victim');
    mkdirSync(d, { mode: 0o755 });
    chmodSync(d, 0o755);
    const f = join(d, 'sudoers');
    writeFileSync(f, 'root ALL=(ALL) ALL\n', { mode: 0o644 });
    chmodSync(f, 0o644);
    return { d, f };
  };
  const untouched = (v: { d: string; f: string }) => {
    expect(statSync(v.d).mode & 0o777).toBe(0o755);
    expect(statSync(v.f).mode & 0o777).toBe(0o644);
    expect(readFileSync(v.f, 'utf8')).toBe('root ALL=(ALL) ALL\n');
  };

  it('a logs link to another folder is refused, and that folder keeps its mode', () => {
    const v = victim();
    mkdirSync(join(dir, 'data'), { mode: 0o700 });
    symlinkSync(v.d, join(dir, 'data', 'logs'));
    expect(() => installService(asRoot(fakeRoot()))).toThrow(
      /data\/logs is a link; refusing to touch it as root/,
    );
    untouched(v);
  });

  it('an env file link is refused before it is read or written, and its target keeps its text and mode', () => {
    const v = victim();
    mkdirSync(join(dir, 'data'), { mode: 0o700 });
    symlinkSync(v.f, join(dir, 'data', 'pasabot.env'));
    const ctx = asRoot(fakeRoot());
    expect(() => installService(ctx)).toThrow(/pasabot\.env is a link/);
    // the dry run reads it as root too
    expect(() => installService(ctx, { dryRun: true })).toThrow(/pasabot\.env is a link/);
    untouched(v);
  });

  it('an env file hard-linked to another file is refused', () => {
    const v = victim();
    mkdirSync(join(dir, 'data'), { mode: 0o700 });
    linkSync(v.f, join(dir, 'data', 'pasabot.env'));
    expect(() => installService(asRoot(fakeRoot()))).toThrow(/pasabot\.env has another hard link/);
    untouched(v);
  });

  it('a state folder that is itself a link, or under a folder others can write, is refused', () => {
    const v = victim();
    symlinkSync(v.d, join(dir, 'data'));
    const ctx = asRoot(fakeRoot());
    expect(() => installService(ctx)).toThrow(/data is a link/);
    untouched(v);
    const open = join(dir, 'shared');
    mkdirSync(open);
    chmodSync(open, 0o777);
    ctx.env.PASABOT_HOME = join(open, 'data');
    expect(() => installService(ctx)).toThrow(/shared can be written by other users/);
    expect(existsSync(join(open, 'data'))).toBe(false);
  });

  it('real folders and file: installs, with the folders 0700 and the env file 0600 (rewritten in place by rename)', () => {
    mkdirSync(join(dir, 'data', 'logs'), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, 'data'), 0o755);
    writeFileSync(join(dir, 'data', 'pasabot.env'), 'PASABOT_PORT=7790\n', { mode: 0o644 });
    const r = installService(asRoot(fakeRoot()));
    expect(r.manager).toBe('systemd-user');
    expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'data', 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(r.envFile).mode & 0o777).toBe(0o600);
    expect(readEnvFile(r.envFile)).toMatchObject({ PASABOT_PORT: '7790', PASABOT_HOST: '127.0.0.1' });
  });
});
