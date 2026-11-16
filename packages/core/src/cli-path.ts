/**
 * Where brain CLIs live. A server started by launchd, systemd or a desktop app gets a bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so CLIs installed the usual ways (npm -g, Homebrew, the vendors' own
 * installers in `~/.local/bin`) would read as "not installed". `cliSearchPath` appends the common install folders
 * that exist after the given PATH: system and package-manager folders plus the folder of the running Node (npm CLIs
 * start with `#!/usr/bin/env node`) first, then the per-user ones; the PATH it was given always comes first. `findCli` resolves a bare command name on that search path.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';

/**
 * System and package-manager folders, searched before the per-user ones. Several of them are writable by the server
 * user (Apple Silicon Homebrew, a per-user Node install), so the runner sandbox denies writes to every folder on the
 * search path, these included (`cliSearchDirs`), not just the per-user ones.
 */
export function systemCliDirs(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? env.PROGRAMFILES;
    return [dirname(process.execPath), ...(pf ? [win32.join(pf, 'nodejs')] : [])];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', dirname(process.execPath)];
}

/**
 * Per-user install folders (vendors' own installers, npm/bun/volta prefixes). The runner sandbox denies writes to
 * them (Seatbelt deny; never made writable under bubblewrap), because the server runs what it finds here outside
 * the sandbox (`detect`).
 */
export function userCliDirs(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    const h = (...p: string[]) => win32.join(home, ...p);
    const appData = env.APPDATA || h('AppData', 'Roaming');
    const local = env.LOCALAPPDATA || h('AppData', 'Local');
    return [
      win32.join(appData, 'npm'), // npm -g (claude.cmd, codex.cmd, gemini.cmd)
      h('.local', 'bin'), // the Claude Code native installer (claude.exe)
      win32.join(local, 'PasaBot', 'bin'), // the free starter's OpenCode (opencode.exe)
      h('.bun', 'bin'),
      h('.opencode', 'bin'),
      win32.join(local, 'Volta', 'bin'),
      win32.join(local, 'Programs', 'OpenCode'),
    ];
  }
  const h = (p: string) => join(home, p);
  return [
    h('.local/bin'),
    h('.npm-global/bin'),
    h('.bun/bin'),
    h('.opencode/bin'),
    h('.volta/bin'),
    h('bin'),
  ];
}

/** install folders checked after PATH (only those that exist are added): system ones first, then per-user */
export function commonCliDirs(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...systemCliDirs(platform, env), ...userCliDirs(home, platform, env)];
}

/**
 * Every folder the server searches for a brain CLI (`cliSearchPath(env)`, absolute entries only), plus their
 * symlink-resolved forms. The server runs the first match it finds outside any sandbox (`detect`, `listModels`), so
 * the runner sandbox must deny writes to all of them, and to their parent chain against a rename-and-replace
 * (`cliSearchDirAncestors`). One list drives the Seatbelt profile and `writablePaths`.
 */
export function cliSearchDirs(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const d of cliSearchPath(env).split(delimiter)) {
    if (!isAbsolute(d)) continue;
    for (const p of [resolve(d), realOr(d)]) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The parent folders of `dirs` up to (not including) `/`: renaming one would swap a protected folder out. */
export function cliSearchDirAncestors(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) if (!out.includes(p)) out.push(p);
  }
  return out;
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function cliSearchPath(env: Record<string, string | undefined> = process.env): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (d: string) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    out.push(d);
  };
  // Windows spells it `Path`; environment names are case-insensitive there
  const pathVar = env.PATH ?? (process.platform === 'win32' ? env.Path : undefined) ?? '';
  for (const d of pathVar.split(delimiter)) add(d);
  const home = process.platform === 'win32' ? env.USERPROFILE || homedir() : env.HOME || homedir();
  for (const d of commonCliDirs(home, process.platform, env)) if (!seen.has(d) && existsSync(d)) add(d);
  return out.join(delimiter);
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Windows: the program extensions tried, in PATHEXT order (.EXE before .CMD); only real program types. */
export function windowsExts(pathext?: string): string[] {
  const allowed = ['.COM', '.EXE', '.BAT', '.CMD'];
  const out = (pathext || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => allowed.includes(e));
  return out.length ? out.filter((e, i) => out.indexOf(e) === i) : allowed;
}

export interface FindCliOptions {
  platform?: NodeJS.Platform;
  /** Windows PATHEXT (default: the server's) */
  pathext?: string;
  /** whether a path is a regular file (tests) */
  isFile?: (p: string) => boolean;
}

/**
 * absolute path of a CLI on `path` (default: `cliSearchPath()`), or null; a name with a slash is checked as is.
 * Relative PATH entries (`.`, `node_modules/.bin`) are skipped: they resolve against the server's working folder,
 * which the sandbox does not protect.
 *
 * Windows: a bare name is tried with each PATHEXT extension in order (`claude.exe` before `claude.cmd`), never as an
 * extensionless file (npm puts a `#!/bin/sh` script there that Windows cannot run); a path with `\` or a drive
 * letter is absolute; the search path is split on `;`.
 */
export function findCli(bin: string, path = cliSearchPath(), o: FindCliOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const fileCheck = o.isFile ?? isFile;
  if (platform !== 'win32') {
    if (bin.includes('/')) return fileCheck(bin) ? bin : null;
    for (const dir of path.split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const p = join(dir, bin);
      if (fileCheck(p)) return p;
    }
    return null;
  }
  const exts = windowsExts(o.pathext ?? process.env.PATHEXT);
  const hasExt = exts.includes(win32.extname(bin).toUpperCase());
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e.toLowerCase()));
  if (/[\\/]/.test(bin) || /^[A-Za-z]:/.test(bin)) {
    if (!win32.isAbsolute(bin)) return null;
    return candidates(bin).find(fileCheck) ?? null;
  }
  for (const dir of path.split(';')) {
    if (!dir || !win32.isAbsolute(dir) || !/^([A-Za-z]:|\\\\)/.test(dir)) continue;
    const hit = candidates(win32.join(dir, bin)).find(fileCheck);
    if (hit) return hit;
  }
  return null;
}
