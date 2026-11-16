/**
 * File operations for ops verbs that run as root on the service's state folder (`sudo pasabot service install
 * --system`, and `sudo pasabot update` when it re-renders the unit). After the first start that folder
 * (`/var/lib/pasabot`, systemd's `StateDirectory=`) belongs to the `pasabot` user, the same uid the server and its
 * `user`-mode agents run as, so anything they run could have planted a link there to make root chmod or overwrite a
 * file of its choosing. Here nothing is followed: a symbolic link, a hard link or the wrong kind of file is refused,
 * modes are set on an open descriptor, and the env file is replaced by a rename, which swaps the folder entry and
 * never writes through it. ARCHITECTURE 8 ("Local privilege escalation").
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { envFileText, parseEnvFile, uid } from './shared.js';

export class UnsafePathError extends Error {}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

function refuse(path: string, why: string): never {
  throw new UnsafePathError(
    `${path} ${why}; refusing to touch it as root. Remove it (or fix its owner) and run the command again`,
  );
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Open `path` without following a link in its last part; a link there is refused, not an error code. */
function openNoFollow(path: string, flags: number): number {
  try {
    return openSync(path, flags | O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR')
      refuse(path, 'is a link or not a folder');
    throw e;
  }
}

/**
 * Every folder above `path` may be written only by root (or by the user running this, which is root outside tests):
 * otherwise whoever can write one of them could swap the path for a link between the check and the use. A sticky
 * folder such as /tmp is allowed, since there only an entry's owner may rename it. Checked along the path as written
 * and along its real path.
 */
export function assertRootOnlyParents(path: string) {
  const trusted = new Set([0, uid()]);
  const parent = resolve(dirname(path));
  const chains = new Set([parent]);
  try {
    chains.add(realpathSync(parent));
  } catch {
    // a parent that does not exist yet is created below by root
  }
  for (const start of chains)
    for (let dir = start; ; dir = dirname(dir)) {
      let st: Stats | null = null;
      try {
        st = statSync(dir);
      } catch {
        st = null;
      }
      if (st) {
        if (!trusted.has(st.uid)) refuse(dir, `is owned by uid ${st.uid}, not root`);
        if (st.mode & 0o022 && !(st.mode & 0o1000)) refuse(dir, 'can be written by other users');
      }
      if (dirname(dir) === dir) break;
    }
}

/** `mkdir -p` + chmod 0700 that refuses a link (or a non-folder) at `path` and sets the mode on the open folder. */
export function ensurePrivateDirNoFollow(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const st = lstatOrNull(path);
  if (st?.isSymbolicLink()) refuse(path, 'is a link');
  if (st && !st.isDirectory()) refuse(path, 'is not a folder');
  if (!st) mkdirSync(path, { mode: 0o700 });
  const fd = openNoFollow(path, constants.O_RDONLY | O_DIRECTORY);
  try {
    if (!fstatSync(fd).isDirectory()) refuse(path, 'is not a folder');
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/** The env file's settings, read without following a link; missing = none. */
export function readEnvFileNoFollow(path: string): Record<string, string> {
  const st = lstatOrNull(path);
  if (!st) return {};
  if (st.isSymbolicLink()) refuse(path, 'is a link');
  if (!st.isFile()) refuse(path, 'is not a regular file');
  const fd = openNoFollow(path, constants.O_RDONLY | O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) refuse(path, 'is not a regular file');
    return parseEnvFile(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the env file (0600) as a new file next to it and rename it into place: the rename replaces the folder entry,
 * so a planted link or hard link is dropped, never written through. A link already there is refused first, so the
 * admin hears about it.
 */
export function writeEnvFileNoFollow(path: string, vars: Record<string, string>) {
  const text = envFileText(vars);
  const st = lstatOrNull(path);
  if (st?.isSymbolicLink()) refuse(path, 'is a link');
  if (st && !st.isFile()) refuse(path, 'is not a regular file');
  if (st && st.nlink > 1) refuse(path, 'has another hard link');
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}`);
  // O_EXCL: never an entry that already exists, link or not
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}
