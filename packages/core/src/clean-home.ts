/**
 * Clean agents: a brain CLI started for a PasaBot turn gets a config home PasaBot owns (inside the agent's workspace),
 * never the user's own. So the user's personal global instructions, memories, rules, custom agents and commands,
 * hooks, plugins and MCP servers (e.g. `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) never reach an agent. The only
 * thing shared is the user's sign-in file, as a link (never a copy), so the login keeps working.
 *
 * The sandboxed agent can write its workspace, so everything under it is untrusted: the unsandboxed server never
 * follows a link the agent may have planted there (a link in place of the clean home, or of a folder above it, would
 * otherwise make the server chmod, overwrite or delete the user's own files through it).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { mkdirPrivate, PRIVATE_DIR_MODE } from './private-fs.js';

/**
 * Whether this user can make file links in `dir` (Windows needs Developer Mode or admin rights for that; elsewhere
 * always). Without them the clean homes cannot share a CLI's sign-in file, so the owner is told (a startup card).
 */
export function canLinkFiles(dir: string): boolean {
  const target = join(dir, `.pasabot-link-test-${process.pid}`);
  const link = `${target}.link`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '');
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
}

/** The clean config home of one brain CLI in an agent's workspace (`<workspace>/.pasabot/home/<cli>`). */
export function cleanHomeDir(workspace: string, cli: string): string {
  return join(workspace, '.pasabot', 'home', cli);
}

/** A sign-in file of the user's that the clean home links to: `name` inside the home, `target` the user's file. */
export interface LoginLink {
  name: string;
  target: string;
}

/** The workspace a clean home `dir` sits in (`<workspace>/.pasabot/home/<cli>`), else the folder that holds `dir`. */
function trustedRoot(dir: string): string {
  const home = dirname(dir);
  const dot = dirname(home);
  return basename(home) === 'home' && basename(dot) === '.pasabot' ? dirname(dot) : home;
}

/**
 * Every folder from `root` (exclusive) down to `dir` is made a real folder: a link, a file or anything else in the
 * way is removed (`rm` never follows a link) and a 0700 folder is made in its place. Then `dir`'s real path must
 * still be inside `root`'s, or this throws.
 */
function realDirs(root: string, dir: string): void {
  const parts = relative(root, dir).split(sep).filter(Boolean);
  if (parts.includes('..')) throw new Error(`clean home "${dir}" is not inside "${root}"`);
  let p = root;
  for (const part of parts) {
    p = join(p, part);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(p);
    } catch {
      /* missing: made below */
    }
    if (st && !st.isDirectory()) {
      rmSync(p, { force: true, recursive: true });
      st = null;
    }
    if (!st) mkdirSync(p, { mode: PRIVATE_DIR_MODE });
  }
  const r = realpathSync(root);
  const d = realpathSync(dir);
  if (d !== join(r, ...parts)) throw new Error(`clean home "${dir}" does not resolve inside "${root}"`);
}

/**
 * Creates (0700) the clean home `dir` and links each sign-in file into it, checked every turn: a link to the user's
 * own file stays; anything else is removed, so no credential is kept in PasaBot's home. Nothing found in the clean
 * home is ever copied into the user's file: a plain file in a link's place may be one the sandboxed agent wrote
 * itself, so it is removed and the link made again (the CLI's next refresh writes through the link). A missing user
 * file is no link at all (a key from the vault, or free models, need none).
 */
export function prepareCleanHome(dir: string, links: LoginLink[] = []): string {
  const root = trustedRoot(dir);
  mkdirPrivate(root);
  realDirs(root, dir);
  // a real folder of PasaBot's, checked above: tightening it never reaches a linked target
  mkdirPrivate(dir, { tighten: true });
  for (const { name, target } of links) {
    const link = join(dir, name);
    realDirs(dir, dirname(link));
    let present = false;
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) present = readlinkSync(link) === target;
      // anything else (a plain file, a hard link, a folder) is the agent's and never reaches the user's file
      if (!present) rmSync(link, { force: true, recursive: true });
    } catch {
      rmSync(link, { force: true, recursive: true });
    }
    try {
      if (!present && existsSync(target)) symlinkSync(target, link);
    } catch {
      /* no sign-in to share */
    }
  }
  return dir;
}
