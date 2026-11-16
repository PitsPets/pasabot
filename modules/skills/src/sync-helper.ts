/**
 * The part of the skills sync that touches an agent's workspace. The server process is not sandboxed and the
 * skills dirs are agent-writable, so nothing here acts on such a folder by its full path: a short-lived child
 * process `chdir`s from the (server-made) workspace one folder at a time, checks after each step that it stands in
 * the very folder it `lstat`ed (same dev + inode, so no symlink was followed), and then works only with single-name
 * relative paths in that folder (openat-style). `rename`, `unlink`, `rmdir` and `lstat` never follow the last
 * component, files are opened with O_NOFOLLOW and created with O_EXCL, and `chmod` only ever runs on `.`. A folder
 * swapped for a symlink mid-sync therefore aborts that skills dir; it can never redirect a write or a delete.
 */
import { spawn } from 'node:child_process';

export interface SyncSkill {
  name: string;
  id: string;
  rev: number;
  /** sha of the files below as `hashFiles` computes it; an up-to-date copy is left alone */
  sha: string;
  /** [relative posix path, base64 bytes] */
  files: [string, string][];
}
export interface SyncJob {
  /** the agent's workspace (made by the server, so trusted as a starting point) */
  ws: string;
  /** each CLI's skills dir as folder names below the workspace */
  dirs: string[][];
  want: SyncSkill[];
  marker: string;
  limits: { files: number; totalBytes: number; fileBytes: number; depth: number };
  /** mode of every folder the helper makes or enters in the workspace: owner-only (`PRIVATE_DIR_MODE`, 0o700) */
  dirMode: number;
}

/** CommonJS run with `node -e`; reads the job as JSON on stdin, prints `{ warnings }`. */
const HELPER = String.raw`'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const C = fs.constants;
const RD = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const MAX_DEPTH = 64;
let stack = [];
// owner-only folders (the job's dirMode, PRIVATE_DIR_MODE): set from the job before any folder is made
let DIR_MODE = 0o700;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const okName = (n) => typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\0');
const rand = () => crypto.randomBytes(6).toString('hex');

function root(ws) {
  const st = fs.lstatSync(ws);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('workspace is not a plain folder');
  process.chdir(ws);
  const now = fs.statSync('.');
  if (!same(st, now)) throw new Error('workspace changed while syncing');
  stack = [now];
}
function into(name) {
  if (!okName(name)) throw new Error('bad folder name');
  if (stack.length > MAX_DEPTH) throw new Error('folders nest too deep');
  const st = fs.lstatSync(name);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('not a plain folder: ' + name);
  process.chdir(name);
  const now = fs.statSync('.');
  if (!same(st, now)) throw new Error('folder changed while syncing: ' + name);
  stack.push(now);
}
function up() {
  stack.pop();
  process.chdir('..');
  if (!same(fs.statSync('.'), stack[stack.length - 1])) throw new Error('folder moved while syncing');
}
/** a plain file in the current folder, never through a symlink, never a FIFO or device */
function readPlain(name, max) {
  let fd;
  try {
    fd = fs.openSync(name, RD);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return off === buf.length ? buf : null;
  } finally {
    fs.closeSync(fd);
  }
}
function readMarker(job, name) {
  into(name);
  const b = readPlain(job.marker, 4096);
  up();
  if (!b) return null;
  try {
    const j = JSON.parse(b.toString('utf8'));
    return typeof j.id === 'string' && typeof j.rev === 'number' ? j : null;
  } catch {
    return null;
  }
}
/** same rules and hash as readFolder + hashFiles; null when the copy is not a clean one */
function hashTree(job, name) {
  const files = new Map();
  let total = 0;
  const walk = (dir, rel, depth) => {
    if (depth > job.limits.depth) return false;
    into(dir);
    for (const n of fs.readdirSync('.').sort()) {
      if (n.startsWith('.')) continue;
      const r = rel ? rel + '/' + n : n;
      const st = fs.lstatSync(n);
      if (st.isSymbolicLink()) return up(), false;
      if (st.isDirectory()) {
        if (!walk(n, r, depth + 1)) return up(), false;
      } else if (st.isFile()) {
        if (files.size >= job.limits.files) return up(), false;
        const b = readPlain(n, job.limits.fileBytes);
        if (!b) return up(), false;
        total += b.length;
        if (total > job.limits.totalBytes) return up(), false;
        files.set(r, b);
      } else return up(), false;
    }
    up();
    return true;
  };
  if (!walk(name, '', 1)) return null;
  const h = crypto.createHash('sha256');
  for (const p of [...files.keys()].sort()) {
    const b = files.get(p);
    h.update(p + '\0' + b.length + '\0');
    h.update(b);
  }
  return h.digest('hex');
}
/** deletes an entry of the current folder: a symlink or file is unlinked, a folder emptied through into/up */
function removeTree(name) {
  const st = fs.lstatSync(name);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    fs.unlinkSync(name);
    return;
  }
  into(name);
  try {
    fs.chmodSync('.', DIR_MODE);
  } catch {}
  for (const n of fs.readdirSync('.')) removeTree(n);
  up();
  fs.rmdirSync(name);
}
/** first moved aside in the same folder (rename never follows the last component), then deleted */
function removeEntry(name) {
  const trash = '.pasabot-trash.' + rand();
  fs.renameSync(name, trash);
  removeTree(trash);
}
function writeAt(parts, buf) {
  let pushed = 0;
  for (const d of parts.slice(0, -1)) {
    try {
      fs.mkdirSync(d, DIR_MODE);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    into(d);
    pushed++;
  }
  const last = parts[parts.length - 1];
  if (!okName(last)) throw new Error('bad file name');
  fs.writeFileSync(last, buf, { flag: 'wx', mode: 0o444 });
  for (let i = 0; i < pushed; i++) up();
}
function syncDir(job, parts, warnings) {
  root(job.ws);
  for (const p of parts) {
    if (!okName(p)) throw new Error('bad folder name');
    try {
      fs.mkdirSync(p, DIR_MODE);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    into(p);
    // the CLI's folder (.fake, .claude, .fake/skills, …) is owner-only, an older one made 0o755 too; chmod on '.'
    fs.chmodSync('.', DIR_MODE);
  }
  const wanted = new Map(job.want.map((s) => [s.name, s]));
  for (const name of fs.readdirSync('.')) {
    const st = fs.lstatSync(name);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const mark = readMarker(job, name);
    if (!mark) continue; // not ours: never touched
    const s = wanted.get(name);
    if (!s || mark.id !== s.id) removeEntry(name);
  }
  for (const s of job.want) {
    if (!okName(s.name)) continue;
    let st = null;
    try {
      st = fs.lstatSync(s.name);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (st) {
      const mark = st.isDirectory() && !st.isSymbolicLink() ? readMarker(job, s.name) : null;
      if (!mark) {
        warnings.push('a folder named ' + s.name + ' is not ours, left alone');
        continue;
      }
      if (mark.id === s.id && mark.rev === s.rev && hashTree(job, s.name) === s.sha) continue;
    }
    const tmp = '.' + s.name + '.' + rand() + '.tmp';
    fs.mkdirSync(tmp, DIR_MODE);
    into(tmp);
    for (const [p, b64] of s.files) writeAt(p.split('/'), Buffer.from(b64, 'base64'));
    writeAt([job.marker], Buffer.from(JSON.stringify({ id: s.id, name: s.name, rev: s.rev })));
    up();
    if (st) removeEntry(s.name);
    fs.renameSync(tmp, s.name);
  }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const job = JSON.parse(input);
  if (Number.isInteger(job.dirMode) && job.dirMode > 0 && job.dirMode <= 0o700) DIR_MODE = job.dirMode;
  const warnings = [];
  for (const parts of job.dirs) {
    try {
      syncDir(job, parts, warnings);
    } catch (e) {
      warnings.push(parts.join('/') + ': ' + ((e && e.message) || String(e)));
    }
  }
  process.stdout.write(JSON.stringify({ warnings }));
});
`;

/** Runs one sync job in the helper; resolves with its warnings, rejects when the helper itself failed. */
export function runSyncHelper(job: SyncJob, cwd: string, timeoutMs = 60_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', HELPER], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (out.length < 1_000_000) out += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (err.length < 10_000) err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`skills sync helper failed: ${err.trim().slice(-500)}`));
      try {
        resolve((JSON.parse(out) as { warnings: string[] }).warnings);
      } catch {
        reject(new Error('skills sync helper gave no result'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
  });
}
