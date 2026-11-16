/**
 * `pasabot service install|uninstall|status`: run PasaBot under launchd (macOS) or systemd (Linux, `--system` for a
 * server with the low-privilege `pasabot` user). The default runner follows the platform (ARCHITECTURE 7.2).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { defineCommand } from '../../command.js';
import { serviceState } from './lifecycle.js';
import {
  assertRootOnlyParents,
  ensurePrivateDirNoFollow,
  readEnvFileNoFollow,
  writeEnvFileNoFollow,
} from './nofollow.js';
import {
  currentLinkOf,
  defaultCtx,
  defaultManager,
  ensurePrivateDir,
  envFilePath,
  installedManager,
  installRoot,
  LAUNCHD_LABEL,
  launchdPlistPath,
  logFilePath,
  type Manager,
  type OpsCtx,
  parseFlags,
  pasabotHomeOf,
  readEnvFile,
  runTool,
  SYSTEM_PREFIX,
  SYSTEMD_SYSTEM_UNIT_PATH,
  SYSTEMD_UNIT,
  serverEntry,
  systemdUserUnitPath,
  uid,
  uidOf,
  writeEnvFile,
} from './shared.js';
import { NEVER_IN_UNIT, renderFromRoot } from './units.js';

type Real = Exclude<Manager, 'process'>;

export const unitPath = (ctx: OpsCtx, m: Real) =>
  m === 'launchd'
    ? launchdPlistPath(ctx)
    : m === 'systemd-user'
      ? systemdUserUnitPath(ctx)
      : SYSTEMD_SYSTEM_UNIT_PATH;

const RUNNERS = ['host', 'host-unsandboxed', 'user', 'container'];

/**
 * Runner per platform for a service (ARCHITECTURE 7.2, same rule as the server's `defaultRunnerMode`): an explicit
 * PASABOT_RUNNER wins; macOS → `host`; Linux system service → `user`; systemd --user → `host` only with a desktop
 * session (DISPLAY, WAYLAND_DISPLAY or XDG_CURRENT_DESKTOP), else `user` (a headless server).
 */
export function defaultRunnerFor(m: Real, env: NodeJS.ProcessEnv = {}) {
  if (env.PASABOT_RUNNER && RUNNERS.includes(env.PASABOT_RUNNER)) return env.PASABOT_RUNNER;
  if (m === 'launchd') return 'host';
  if (m === 'systemd-system') return 'user';
  return env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP ? 'host' : 'user';
}

/** Paths the hardened system unit cannot see (ProtectHome=yes). */
const HIDDEN_FROM_SYSTEM = /^\/(home|root|run\/user)(\/|$)/;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Point `link` at `target` atomically (temp link + rename). */
function pointLink(link: string, target: string) {
  mkdirSync(dirname(link), { recursive: true, mode: 0o755 });
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

function step(r: { status: number; stderr: string }, what: string) {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
}

export interface InstallResult {
  manager: Real;
  unitPath: string;
  unit: string;
  envFile: string;
  warnings: string[];
}

export function installService(
  ctx0: OpsCtx,
  o: { system?: boolean; dryRun?: boolean; node?: string } = {},
): InstallResult {
  const manager = defaultManager(ctx0, o.system);
  // the system service keeps its state in /var/lib/pasabot (StateDirectory=) and its releases in /opt/pasabot unless
  // PASABOT_HOME / PASABOT_PREFIX say otherwise: both stay visible under ProtectHome=yes
  const ctx: OpsCtx =
    manager === 'systemd-system'
      ? {
          ...ctx0,
          env: {
            ...ctx0.env,
            PASABOT_HOME: ctx0.env.PASABOT_HOME || '/var/lib/pasabot',
            PASABOT_PREFIX: ctx0.env.PASABOT_PREFIX || SYSTEM_PREFIX,
          },
        }
      : ctx0;
  if (manager === 'systemd-system' && uidOf(ctx) !== 0 && !o.dryRun)
    throw new Error('`--system` writes /etc/systemd/system: run it with sudo');
  const src = installRoot(ctx);
  if (!src) throw new Error('cannot find the PasaBot install; set PASABOT_ROOT');
  // The unit always runs `<prefix>/current`, never the folder install ran from, so `pasabot update` (which switches
  // `current`) changes what the service runs. With no release installed yet, `current` is bootstrapped as a link
  // to this install; a release link (`releases/<v>`) is never replaced here.
  const root = currentLinkOf(ctx);
  const warnings: string[] = [];
  const linkTarget = isLink(root) ? readlinkSync(root) : null;
  const bootstrapLink = linkTarget !== null && isAbsolute(linkTarget);
  const repoint =
    resolve(src) !== resolve(root) &&
    (!existsSync(root) || (bootstrapLink && !!ctx.env.PASABOT_ROOT && real(src) !== real(root)));
  if (!repoint && ctx.env.PASABOT_ROOT && real(src) !== real(root))
    warnings.push(`the service runs ${root} (${real(root)}), not PASABOT_ROOT (${src})`);
  const codeRoot = repoint ? src : root;
  const node = o.node ?? process.execPath;
  if (manager === 'systemd-system') {
    const checks: [string, string][] = [
      ['node', real(node)],
      ['the install', root],
      ['the install', real(codeRoot)],
      ['PASABOT_HOME', resolve(pasabotHomeOf(ctx))],
    ];
    for (const [what, p] of checks)
      if (HIDDEN_FROM_SYSTEM.test(p))
        throw new Error(
          `--system: ${what} is at ${p}, which the hardened unit cannot see (ProtectHome=yes). ` +
            'Use a node outside /home and /root, and install a release with `sudo pasabot update <tarball>` ' +
            `(it goes to ${dirname(root)}) or run from a checkout outside /home`,
        );
  }
  if (!existsSync(serverEntry(codeRoot)))
    warnings.push(`server build missing at ${serverEntry(codeRoot)} (run pnpm build)`);

  const envFile = envFilePath(ctx);
  // As root, the state folder is the service user's (StateDirectory= hands it to `pasabot` on the first start), so
  // nothing in it is followed: a planted link would make root chmod or overwrite a file of the link's choosing.
  const asRoot = uidOf(ctx) === 0;
  const current = asRoot ? readEnvFileNoFollow(envFile) : readEnvFile(envFile);
  const settings: Record<string, string> = {
    PASABOT_RUNNER: defaultRunnerFor(manager, ctx.env),
    PASABOT_HOST: '127.0.0.1',
    PASABOT_PORT: '7777',
    // launchd and the systemd user manager start with a bare PATH; agent CLIs live on the owner's PATH
    ...(manager !== 'systemd-system' && ctx.env.PATH ? { PATH: ctx.env.PATH } : {}),
    ...current,
  };
  for (const k of NEVER_IN_UNIT)
    if (manager === 'launchd' && settings[k])
      warnings.push(
        `${k} is in ${envFile} but is never copied into the launchd unit; keep secrets in the vault`,
      );

  const unit = renderFromRoot(codeRoot, manager, {
    node,
    entry: serverEntry(root),
    root,
    pasabotHome: pasabotHomeOf(ctx),
    envFile,
    logFile: logFilePath(ctx),
    env: settings,
  });
  const path = unitPath(ctx, manager);
  if (o.dryRun) return { manager, unitPath: path, unit, envFile, warnings };

  if (repoint) pointLink(root, real(src));
  if (asRoot) {
    // the folders above the state folder are root's, so checking each last part (no-follow) is race-free
    assertRootOnlyParents(pasabotHomeOf(ctx));
    ensurePrivateDirNoFollow(pasabotHomeOf(ctx));
    ensurePrivateDirNoFollow(dirname(logFilePath(ctx)));
    writeEnvFileNoFollow(envFile, settings);
  } else {
    ensurePrivateDir(pasabotHomeOf(ctx));
    ensurePrivateDir(dirname(logFilePath(ctx)));
    writeEnvFile(envFile, settings);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unit, { mode: 0o644 });

  if (manager === 'launchd') {
    const target = `gui/${uid()}`;
    if (runTool(ctx, 'launchctl', ['print', `${target}/${LAUNCHD_LABEL}`]).status === 0)
      runTool(ctx, 'launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]);
    step(runTool(ctx, 'launchctl', ['bootstrap', target, path]), 'launchctl bootstrap');
  } else {
    const sc = (args: string[]) =>
      runTool(ctx, 'systemctl', manager === 'systemd-user' ? ['--user', ...args] : args);
    step(sc(['daemon-reload']), 'systemctl daemon-reload');
    step(sc(['enable', '--now', SYSTEMD_UNIT]), 'systemctl enable');
  }
  return { manager, unitPath: path, unit, envFile, warnings };
}

/** Remove the service unit (the server is stopped first). Data in $PASABOT_HOME is never touched. */
export function uninstallService(ctx: OpsCtx): string | null {
  const m = installedManager(ctx);
  if (m === 'process') return null;
  const path = unitPath(ctx, m);
  if (m === 'launchd') runTool(ctx, 'launchctl', ['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
  else {
    const sc = (args: string[]) =>
      runTool(ctx, 'systemctl', m === 'systemd-user' ? ['--user', ...args] : args);
    sc(['disable', '--now', SYSTEMD_UNIT]);
    rmSync(path, { force: true });
    sc(['daemon-reload']);
    return path;
  }
  rmSync(path, { force: true });
  return path;
}

export default defineCommand({
  name: 'service',
  summary: 'install, remove or show the launchd/systemd service (install [--system] [--dry-run])',
  async run(args) {
    const ctx = defaultCtx();
    const { flags, rest } = parseFlags(args);
    const sub = rest[0] ?? 'status';
    if (sub === 'install') {
      const r = installService(ctx, { system: !!flags.system, dryRun: !!flags['dry-run'] });
      for (const w of r.warnings) ctx.err(`warning: ${w}\n`);
      if (flags['dry-run']) {
        ctx.out(`# ${r.unitPath}\n${r.unit}`);
        return 0;
      }
      ctx.out(`pasabot: ${r.manager} service installed at ${r.unitPath}\nsettings: ${r.envFile}\n`);
      return 0;
    }
    if (sub === 'uninstall') {
      const p = uninstallService(ctx);
      ctx.out(p ? `pasabot: service removed (${p}); your data is kept\n` : 'pasabot: no service installed\n');
      return 0;
    }
    if (sub === 'status') {
      const s = serviceState(ctx);
      ctx.out(`manager: ${s.manager}\nrunning: ${s.running ? 'yes' : 'no'} (${s.detail})\n`);
      return s.running ? 0 : 3;
    }
    ctx.err('usage: pasabot service install [--system] [--dry-run] | uninstall | status\n');
    return 2;
  },
});
