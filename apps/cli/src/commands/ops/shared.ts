/**
 * Shared helpers for the W20 ops verbs (start/stop/restart/service/update/uninstall/logs/doctor).
 * Everything takes an `OpsCtx` so tests can point HOME, PASABOT_HOME, PATH and the platform at temp folders and
 * fake `launchctl`/`systemctl` binaries without touching the real machine.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpsCtx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** the effective uid (tests set it; defaults to the real one) */
  uid?: number;
  out(s: string): void;
  err(s: string): void;
}

export const defaultCtx = (): OpsCtx => ({
  env: process.env,
  platform: process.platform,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});

export const LAUNCHD_LABEL = 'local.pasabot.server';
export const SYSTEMD_UNIT = 'pasabot.service';

export const userHome = (ctx: OpsCtx) => ctx.env.HOME || homedir();
export const pasabotHomeOf = (ctx: OpsCtx) => ctx.env.PASABOT_HOME || join(userHome(ctx), '.pasabot');
/** The environment file every service unit loads (0600, no secrets: the vault holds those). */
export const envFilePath = (ctx: OpsCtx) => join(pasabotHomeOf(ctx), 'pasabot.env');
export const logFilePath = (ctx: OpsCtx) => join(pasabotHomeOf(ctx), 'logs', 'server.log');
export const pidFilePath = (ctx: OpsCtx) => join(pasabotHomeOf(ctx), 'run', 'server.pid');
/**
 * Where `pasabot update` keeps signed releases (`releases/<version>`) and the `current` link. As root on Linux
 * (`sudo pasabot ...` for the system service) it is the root-owned `/opt/pasabot`: the hardened unit cannot see /root
 * or /home (ProtectHome=yes).
 */
export const prefixOf = (ctx: OpsCtx) =>
  ctx.env.PASABOT_PREFIX ||
  (ctx.platform === 'linux' && uidOf(ctx) === 0
    ? SYSTEM_PREFIX
    : join(userHome(ctx), '.local', 'share', 'pasabot'));
export const SYSTEM_PREFIX = '/opt/pasabot';
/** The stable path every service unit runs from; `pasabot update` switches what it points at. */
export const currentLinkOf = (ctx: OpsCtx) => join(prefixOf(ctx), 'current');

export const launchdPlistPath = (ctx: OpsCtx) =>
  join(userHome(ctx), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const systemdUserUnitPath = (ctx: OpsCtx) =>
  join(ctx.env.XDG_CONFIG_HOME || join(userHome(ctx), '.config'), 'systemd', 'user', SYSTEMD_UNIT);
export const SYSTEMD_SYSTEM_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;

/**
 * The install root: `PASABOT_ROOT`, else `<prefix>/current` when a signed release is installed, else the checkout
 * or install this CLI runs from (found by walking up to the folder holding `deploy/` and `apps/server/`).
 */
export function installRoot(ctx: OpsCtx): string | null {
  if (ctx.env.PASABOT_ROOT) return ctx.env.PASABOT_ROOT;
  const current = join(prefixOf(ctx), 'current');
  if (existsSync(join(current, 'apps', 'server'))) return current;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'deploy')) && existsSync(join(dir, 'apps', 'server'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export const SERVER_ENTRY_TAIL = join('apps', 'server', 'dist', 'host', 'main.js');
export const serverEntry = (root: string) => join(root, SERVER_ENTRY_TAIL);

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** KEY=VALUE lines; `#` comments; optional single or double quotes; nothing is expanded or executed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
      value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** The env file's text; refuses a bad name or a value that would add a line. */
export function envFileText(vars: Record<string, string>): string {
  const lines = [
    '# PasaBot server settings, read by the service unit. No secrets here: they live in the vault.',
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid setting name "${k}"`);
    if (/[\n\r\0]/.test(v)) throw new Error(`setting ${k} contains a line break`);
    lines.push(`${k}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeEnvFile(path: string, vars: Record<string, string>) {
  const text = envFileText(vars);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The settings the server actually runs with: the shell's PASABOT_* overlaid by the service's env file. */
export function effectiveSettings(ctx: OpsCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (k.startsWith('PASABOT_') && v !== undefined) out[k] = v;
  return { ...out, ...readEnvFile(envFilePath(ctx)) };
}

export function ensurePrivateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export type Manager = 'launchd' | 'systemd-user' | 'systemd-system' | 'process';

/** Which service manager runs PasaBot here: an installed unit wins, else the detached-process fallback. */
export function installedManager(ctx: OpsCtx): Manager {
  if (existsSync(launchdPlistPath(ctx))) return 'launchd';
  if (existsSync(systemdUserUnitPath(ctx))) return 'systemd-user';
  if (ctx.platform === 'linux' && existsSync(SYSTEMD_SYSTEM_UNIT_PATH)) return 'systemd-system';
  return 'process';
}

export function defaultManager(ctx: OpsCtx, system = false): Exclude<Manager, 'process'> {
  if (ctx.platform === 'darwin') {
    if (system)
      throw new Error('--system is for Linux servers; on macOS PasaBot runs as a launchd user agent');
    return 'launchd';
  }
  if (ctx.platform === 'linux') return system ? 'systemd-system' : 'systemd-user';
  throw new Error(`no service manager support on ${ctx.platform}; run \`pasabot start\` instead`);
}

/** Run a tool by name from PATH (no shell). Returns status + output; never throws on a non-zero exit. */
export function runTool(ctx: OpsCtx, cmd: string, args: string[], inherit = false) {
  const r = spawnSync(cmd, args, {
    env: ctx.env,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const uid = () => process.getuid?.() ?? 0;
export const uidOf = (ctx: OpsCtx) => ctx.uid ?? uid();

export const modeOf = (path: string) => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
};

/** Parse `--flag`, `--key value` and `--key=value`; the rest stays positional. */
export function parseFlags(args: string[], valued: string[] = []) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      if (a === '-n' || a === '-f') {
        if (a === '-n') flags.lines = args[++i] ?? '';
        else flags.follow = true;
        continue;
      }
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) flags[key] = a.slice(eq + 1);
    else if (valued.includes(key)) flags[key] = args[++i] ?? '';
    else flags[key] = true;
  }
  return { flags, rest };
}
