/**
 * Is what a catalogue connector needs already on this computer? A cheap, read-only look: the launcher command is
 * resolved on PATH (never run), and a few desktop apps are looked for by folder name. Nothing is downloaded, run or
 * read from a file here; the answer is cached for a short time per catalogue entry.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Manifest } from './manifest.js';

/** what a connector needs that may be missing, as the page names it */
export interface Need {
  /** a plain name for the thing (Docker, Node.js, uv, or the command itself) */
  name: string;
  /** its official site, or null when there is none to point at */
  site: string | null;
}

export interface DetectEnv {
  /** the PATH to search (default `$PATH`) */
  path: string;
  /** folders that hold desktop apps (default `/Applications` and `~/Applications` on macOS) */
  appDirs: string[];
  platform: NodeJS.Platform;
}

/** launchers we know, with the app that brings them and where to get them */
const KNOWN: Record<string, Need & { apps?: string[] }> = {
  docker: { name: 'Docker', site: 'https://www.docker.com/', apps: ['Docker.app'] },
  podman: { name: 'Podman', site: 'https://podman.io/', apps: ['Podman Desktop.app'] },
  npx: { name: 'Node.js', site: 'https://nodejs.org/' },
  node: { name: 'Node.js', site: 'https://nodejs.org/' },
  bunx: { name: 'Bun', site: 'https://bun.sh/' },
  uvx: { name: 'uv', site: 'https://docs.astral.sh/uv/' },
  uv: { name: 'uv', site: 'https://docs.astral.sh/uv/' },
};

export function detectEnv(): DetectEnv {
  const apps = process.env.PASABOT_CONNECTORS_APPS;
  return {
    path: process.env.PASABOT_CONNECTORS_PATH ?? process.env.PATH ?? '',
    appDirs:
      apps !== undefined
        ? apps.split(delimiter).filter(Boolean)
        : process.platform === 'darwin'
          ? ['/Applications', join(homedir(), 'Applications')]
          : [],
    platform: process.platform,
  };
}

const runnable = (p: string, platform: NodeJS.Platform) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The full path a command would start from, or null. Looks only; never runs it. */
export function findOnPath(command: string, env: Pick<DetectEnv, 'path' | 'platform'>): string | null {
  if (!command) return null;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return isAbsolute(command) && runnable(command, env.platform) ? command : null;
  const exts =
    env.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
      : [''];
  for (const dir of env.path.split(env.platform === 'win32' ? ';' : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // a relative PATH entry depends on the server's folder: skipped
    for (const ext of exts) {
      const p = join(dir, command + ext);
      if (runnable(p, env.platform)) return p;
    }
  }
  return null;
}

const appFound = (apps: string[], env: DetectEnv) =>
  apps.some((a) =>
    env.appDirs.some((d) => {
      try {
        return statSync(join(d, a)).isDirectory();
      } catch {
        return false;
      }
    }),
  );

export interface Detection {
  /** true when nothing has to be put on this computer first */
  here: boolean;
  /** what is missing (only when `here` is false) */
  missing: Need | null;
}

/** What one connector needs on this computer, and whether it is there. */
export function detect(m: Pick<Manifest, 'kind' | 'mcp' | 'homepage'>, env: DetectEnv): Detection {
  // a hosted service or a sign-in runs nothing here
  if (m.kind !== 'mcp-stdio' || !m.mcp?.command) return { here: true, missing: null };
  const command = m.mcp.command;
  const bin = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  const known = KNOWN[bin];
  if (findOnPath(command, env)) return { here: true, missing: null };
  if (known?.apps && appFound(known.apps, env)) return { here: true, missing: null };
  return {
    here: false,
    missing: known ? { name: known.name, site: known.site } : { name: bin, site: m.homepage ?? null },
  };
}

/** `detect` with a short cache per connector, so opening the page twice looks once. */
export function createDetector(ttlMs = 30_000, envOf: () => DetectEnv = detectEnv) {
  const cache = new Map<string, { at: number; d: Detection }>();
  return (m: Pick<Manifest, 'slug' | 'version' | 'kind' | 'mcp' | 'homepage'>): Detection => {
    const key = `${m.slug}@${m.version}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.d;
    const d = detect(m, envOf());
    cache.set(key, { at: now, d });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return d;
  };
}
