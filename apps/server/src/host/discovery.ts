/**
 * Discovery (ARCHITECTURE.md 2.1): scan the workspace and node_modules/@pasabot/* for package.json files with a
 * `pasabot` field. No central registry file.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PasaBotPackageField } from '@pasabot/core';

export interface DiscoveredPackage {
  name: string;
  dir: string;
  /** folder name; the module/plugin id */
  id: string;
  pasabot: PasaBotPackageField;
}

const GROUPS = ['providers', 'channels', 'modules', 'plugins'];
const KINDS = new Set(['module', 'provider', 'channel', 'plugin']);

/** Walk up from `start` to the folder holding pnpm-workspace.yaml (the repo root), if any. */
export function findWorkspaceRoot(start: string): string | null {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The root discovery scans, derived from where the server code itself lives (never the process cwd, which is `/`
 * under launchd/systemd): the pnpm workspace that holds it, else the install prefix whose `node_modules/@pasabot`
 * holds the packages (the outermost `node_modules` above the server).
 */
export function findServerRoot(selfDir: string): string | null {
  const ws = findWorkspaceRoot(selfDir);
  if (ws) return ws;
  const parts = resolve(selfDir).split(sep);
  const i = parts.indexOf('node_modules');
  if (i <= 0) return null;
  const prefix = parts.slice(0, i).join(sep) || sep;
  return existsSync(join(prefix, 'node_modules', '@pasabot')) ? prefix : null;
}

function readPkg(dir: string): DiscoveredPackage | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; pasabot?: PasaBotPackageField };
  const b = pkg.pasabot;
  if (!b || !KINDS.has(b.kind) || typeof b.entry !== 'string') return null;
  const real = realpathSync(dir);
  return { name: pkg.name ?? real, dir: real, id: real.split(/[\\/]/).pop()!, pasabot: b };
}

export function discoverPackages(root: string): DiscoveredPackage[] {
  const found = new Map<string, DiscoveredPackage>();
  const add = (dir: string) => {
    const p = readPkg(dir);
    if (p && !found.has(p.dir)) found.set(p.dir, p);
  };
  for (const g of GROUPS) {
    const gd = join(root, g);
    if (!existsSync(gd)) continue;
    for (const id of readdirSync(gd).sort()) add(join(gd, id));
  }
  const nm = join(root, 'node_modules', '@pasabot');
  if (existsSync(nm)) for (const n of readdirSync(nm).sort()) add(join(nm, n));
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Import a discovered package's server entry. Uses the TypeScript `source` entry when the built entry is missing
 * or PASABOT_SOURCE=1 (dev and test runs, which execute TypeScript through Vite/tsx).
 */
export async function loadEntry<T = unknown>(p: DiscoveredPackage): Promise<T> {
  const built = join(p.dir, p.pasabot.entry);
  const useSource =
    !!p.pasabot.source && (process.env.PASABOT_SOURCE === '1' || !!process.env.VITEST || !existsSync(built));
  const file = useSource ? join(p.dir, p.pasabot.source!) : built;
  const mod = (await import(pathToFileURL(file).href)) as { default?: T };
  if (mod.default === undefined) throw new Error(`${p.name}: entry ${file} has no default export`);
  return mod.default;
}
