/**
 * PasaBot Screen Helper (macOS, W16): the separate app that alone holds Screen Recording and Accessibility. The
 * launcher hands it and the server a fresh secret on every start: 32 random bytes as hex in
 * `$PASABOT_HOME/run/screen.key` (0600 in a 0700 folder, which agent sandboxes cannot read), then starts the helper
 * through LaunchServices (`open -g -a`), never as a child of this process: a child would share PasaBot's
 * responsible process, and with it any permission given to the helper. Stopping the server removes the key; the
 * helper sees that within two seconds and quits.
 *
 * The helper trusts ONE data folder: `~/.pasabot` of this user (from the user database, never $HOME), the folder
 * agent sandboxes always deny. A `--home` naming any other folder makes it quit, so a copy started by anyone else
 * never trusts a key they wrote. With another $PASABOT_HOME, computer use on this Mac stays off.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export const HELPER_APP_NAME = 'PasaBot Screen Helper.app';

/** the helper bundled inside PasaBot.app (Contents/Helpers), or null when this build has none */
export function helperAppPath(appPath: string | null | undefined, exists = existsSync): string | null {
  if (!appPath) return null;
  const p = join(appPath, 'Contents', 'Helpers', HELPER_APP_NAME);
  return exists(p) ? p : null;
}

export const helperKeyPath = (home: string) => join(home, 'run', 'screen.key');

/** the only data folder the Screen Helper trusts (ScreenHelper.swift `canonicalHome`) */
export const helperHome = (userHome = userInfo().homedir) => join(userHome, '.pasabot');
/** whether this data folder is the one the helper trusts */
export const helperHomeOk = (home: string, userHome?: string) => resolve(home) === helperHome(userHome);

/** a fresh per-launch key, written atomically with 0600 in a 0700 run folder; returns its path */
export function writeHelperKey(home: string): string {
  const dir = join(home, 'run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = helperKeyPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'w' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export function removeHelperKey(home: string): void {
  rmSync(helperKeyPath(home), { force: true });
}

export type Opener = (cmd: string, args: string[]) => Promise<void>;
const openWithLaunchServices: Opener = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15_000 }, (e) => (e ? reject(e) : resolve())),
  );

/** the exact `open` call: in the background (-g), the bundled helper, our data dir */
export const helperOpenArgs = (app: string, home: string) => ['-g', '-a', app, '--args', '--home', home];

/** writes the key, then starts (or wakes) the helper; never throws: computer use simply stays unavailable */
export async function startScreenHelper(o: {
  home: string;
  app: string;
  open?: Opener;
  log?: (m: string) => void;
  /** the user's home folder (tests) */
  userHome?: string;
}): Promise<boolean> {
  if (!helperHomeOk(o.home, o.userHome)) {
    o.log?.(
      `screen helper not started: it only works with the standard data folder ${helperHome(o.userHome)}`,
    );
    return false;
  }
  try {
    writeHelperKey(o.home);
    await (o.open ?? openWithLaunchServices)('/usr/bin/open', helperOpenArgs(o.app, o.home));
    return true;
  } catch (e) {
    o.log?.(`screen helper not started: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
