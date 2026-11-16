/**
 * The clean home lives in the agent's (writable, untrusted) workspace: a link the agent plants in place of the home
 * or a folder above it must never make the server chmod, overwrite or delete the user's own sign-in through it.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanHomeDir, prepareCleanHome } from './clean-home.js';

const posix = process.platform !== 'win32';
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-cleanhome-')));
  const ws = join(root, 'ws');
  const user = join(root, 'user', '.codex');
  mkdirSync(ws, { recursive: true });
  mkdirSync(user, { recursive: true });
  chmodSync(user, 0o755);
  const auth = join(user, 'auth.json');
  writeFileSync(auth, 'USER-LOGIN');
  return { ws, user, auth, dir: cleanHomeDir(ws, 'codex') };
}

describe.runIf(posix)('prepareCleanHome', () => {
  it('links the sign-in into a real 0700 folder', () => {
    const { auth, dir } = setup();
    prepareCleanHome(dir, [{ name: 'auth.json', target: auth }]);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
    expect(readlinkSync(join(dir, 'auth.json'))).toBe(auth);
  });

  for (const planted of [join('.pasabot', 'home', 'codex'), join('.pasabot', 'home'), '.pasabot'])
    it(`never follows a link planted at ${planted}`, () => {
      const { ws, user, auth, dir } = setup();
      // the agent swaps a folder on the way for a link whose path below resolves to the user's own ~/.codex
      const at = join(ws, planted);
      const below = join('.pasabot', 'home', 'codex').slice(planted.length + 1);
      const evil = join(root, 'evil');
      const end = join(evil, below);
      mkdirSync(join(end, '..'), { recursive: true });
      if (below) symlinkSync(user, end);
      mkdirSync(join(at, '..'), { recursive: true });
      symlinkSync(below ? evil : user, at);
      expect(realpathSync(join(dir, 'auth.json'))).toBe(auth);
      // an older user file than a "refreshed" one would also have been copied over
      utimesSync(auth, new Date(0), new Date(0));
      prepareCleanHome(dir, [{ name: 'auth.json', target: auth }]);
      expect(readFileSync(auth, 'utf8')).toBe('USER-LOGIN');
      expect(lstatSync(auth).isFile()).toBe(true);
      expect((statSync(user).mode & 0o777).toString(8)).toBe('755');
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect(realpathSync(dir)).toBe(join(ws, '.pasabot', 'home', 'codex'));
      expect(readlinkSync(join(dir, 'auth.json'))).toBe(auth);
    });

  it('a hard link in the login file place is removed, never copied back', () => {
    const { auth, dir } = setup();
    prepareCleanHome(dir, []);
    const other = join(root, 'other-auth.json');
    writeFileSync(other, 'SOMEONE-ELSE');
    linkSync(other, join(dir, 'auth.json'));
    utimesSync(auth, new Date(0), new Date(0));
    prepareCleanHome(dir, [{ name: 'auth.json', target: auth }]);
    expect(readFileSync(auth, 'utf8')).toBe('USER-LOGIN');
    expect(existsSync(other)).toBe(true);
    expect(readlinkSync(join(dir, 'auth.json'))).toBe(auth);
  });

  it('a plain file in the link place (the agent may have written it) is never copied over the user file', () => {
    const { auth, dir } = setup();
    prepareCleanHome(dir, [{ name: 'auth.json', target: auth }]);
    rmSync(join(dir, 'auth.json'));
    writeFileSync(join(dir, 'auth.json'), 'ATTACKER-LOGIN');
    utimesSync(auth, new Date(0), new Date(0));
    prepareCleanHome(dir, [{ name: 'auth.json', target: auth }]);
    expect(readFileSync(auth, 'utf8')).toBe('USER-LOGIN');
    expect(readlinkSync(join(dir, 'auth.json'))).toBe(auth);
  });
});
