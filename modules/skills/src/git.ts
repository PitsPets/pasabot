/**
 * Fetch a skill from a git URL. https only (plus file:// for the owner), one shallow clone of one branch, no
 * submodules, no hooks, no credential helpers, no redirects. For https the host is vetted by safe-net first and
 * the clone is pinned to that address (`http.curloptResolve`), so a DNS answer cannot be rebound in between.
 * Nothing in the cloned tree is ever run; only its files are read. One clone runs at a time per server, and git is
 * killed once the clone folder grows past `maxBytes` (20 MB), so a huge repository never fills the disk. With
 * `commit` the clone must land on exactly that commit (what the owner approved), or nothing is returned.
 */
import { execFile, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Resolver, SsrfError, vetUrl } from '@pasabot/safe-net';
import { readFolder, SkillError, type SkillFiles, validPath } from './bundle.js';

const run = promisify(execFile);

export interface GitSource {
  url: string;
  /** branch or tag; default = the remote's default branch */
  ref?: string;
  /** folder inside the repository that holds SKILL.md */
  subdir?: string;
  /** the full 40-hex commit that was approved; the clone must be exactly this commit or nothing is installed */
  commit?: string;
}
export interface GitOptions {
  /** file:// URLs (owner only; tests use a local repository) */
  allowFile?: boolean;
  allowHosts?: string[];
  resolver?: Resolver;
  timeoutMs?: number;
  /** the clone (pack + checkout) is stopped once the folder grows past this (default 20 MB) */
  maxBytes?: number;
}

export const MAX_CLONE_BYTES = 20 * 1024 * 1024;

export const isCommit = (c: string) =>
  c.length === 40 && [...c].every((ch) => (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'));

/** One clone at a time per server: parallel installs wait their turn instead of filling the disk together. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => {});
  return next;
}

/** Bytes under a folder, walking at most `cap` + 1 bytes' worth (stops early once over). */
function sizeOver(dir: string, cap: number): boolean {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const st = lstatSync(join(d, n));
        if (st.isDirectory()) stack.push(join(d, n));
        else total += st.size;
      } catch {}
      if (total > cap) return true;
    }
  }
  return false;
}

/** Runs git, killing it when it overruns the time or the folder it writes grows past `cap`. */
function gitCapped(
  args: string[],
  env: NodeJS.ProcessEnv,
  watch: string,
  cap: number,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let why: 'too_large' | 'timeout' | null = null;
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      err = (err + d).slice(-4000);
    });
    const stop = (w: 'too_large' | 'timeout') => {
      why = w;
      child.kill('SIGKILL');
    };
    const tick = setInterval(() => {
      if (sizeOver(watch, cap)) stop('too_large');
    }, 100);
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.on('error', (e) => {
      clearInterval(tick);
      clearTimeout(timer);
      reject(new SkillError('source_failed', `git could not run: ${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(tick);
      clearTimeout(timer);
      if (!why && code === 0 && sizeOver(watch, cap)) why = 'too_large';
      if (why === 'too_large')
        return reject(
          new SkillError('too_large', `the repository is over ${Math.round(cap / 1024 / 1024)} MB`),
        );
      if (why === 'timeout') return reject(new SkillError('source_failed', 'git clone took too long'));
      if (code !== 0) {
        const msg = err.split('\n').filter(Boolean).slice(-1)[0];
        return reject(new SkillError('source_failed', `git clone failed: ${msg ?? 'unknown error'}`));
      }
      resolve();
    });
  });
}

function validRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > 200 || ref.startsWith('-') || ref.includes('..')) return false;
  for (const c of ref) {
    const ok =
      (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || '._-/'.includes(c);
    if (!ok) return false;
  }
  return true;
}

export function fetchGitSkill(
  src: GitSource,
  o: GitOptions = {},
): Promise<{ files: SkillFiles; commit: string; url: string }> {
  return serial(() => fetchNow(src, o));
}

async function fetchNow(
  src: GitSource,
  o: GitOptions,
): Promise<{ files: SkillFiles; commit: string; url: string }> {
  let url: URL;
  try {
    url = new URL(src.url);
  } catch {
    throw new SkillError('source_failed', 'not a valid URL');
  }
  if (src.ref !== undefined && !validRef(src.ref))
    throw new SkillError('source_failed', 'branch or tag not allowed');
  if (src.subdir !== undefined && src.subdir !== '' && !validPath(src.subdir))
    throw new SkillError('source_failed', 'folder name not allowed');
  if (src.commit !== undefined && !isCommit(src.commit))
    throw new SkillError('source_failed', 'commit must be the full 40-character lowercase hex id');
  const config = [
    'protocol.allow=never',
    'protocol.https.allow=always',
    'http.followRedirects=false',
    'core.hooksPath=/dev/null',
    'core.symlinks=false',
    'credential.helper=',
    'submodule.recurse=false',
  ];
  if (url.protocol === 'https:') {
    if (url.username || url.password)
      throw new SkillError('source_failed', 'credentials in URLs are not allowed');
    try {
      const { ip, family } = await vetUrl(url, { allowHosts: o.allowHosts, resolver: o.resolver });
      const port = url.port || '443';
      config.push(`http.curloptResolve=${url.hostname}:${port}:${family === 6 ? `[${ip}]` : ip}`);
    } catch (e) {
      if (e instanceof SsrfError) throw new SkillError('source_failed', e.message);
      throw e;
    }
  } else if (url.protocol === 'file:' && o.allowFile) {
    config.push('protocol.file.allow=always');
  } else {
    throw new SkillError('source_failed', `scheme ${url.protocol} is not allowed (use https)`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'pasabot-skill-git-'));
  const dest = join(tmp, 'repo');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmp,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: '/bin/false',
  };
  const timeout = o.timeoutMs ?? 60_000;
  try {
    const args = [
      ...config.flatMap((c) => ['-c', c]),
      'clone',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      '--template=',
      ...(src.ref ? ['--branch', src.ref] : []),
      '--',
      url.href,
      dest,
    ];
    await gitCapped(args, env, tmp, o.maxBytes ?? MAX_CLONE_BYTES, timeout);
    const { stdout } = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { env, timeout: 10_000 });
    if (src.commit && stdout.trim() !== src.commit)
      throw new SkillError(
        'source_failed',
        `the repository is at ${stdout.trim().slice(0, 12)}, not the approved commit ${src.commit.slice(0, 12)}; nothing was installed`,
      );
    const root = src.subdir ? join(dest, src.subdir) : dest;
    let files: SkillFiles;
    try {
      files = readFolder(root);
    } catch (e) {
      if (e instanceof SkillError) throw e;
      throw new SkillError('source_failed', 'that folder is not in the repository');
    }
    return { files, commit: stdout.trim(), url: url.href };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
