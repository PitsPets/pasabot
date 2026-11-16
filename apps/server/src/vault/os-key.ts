/**
 * The vault master key in the operating system's own key store, for host mode on Windows and Linux (macOS uses the
 * login keychain, `keychainMasterKey`). Without one of these the vault could not open at all on a Windows PC or a
 * Linux desktop (it asked for a passphrase nobody sets), so no API key or channel token could be saved.
 *
 *   - Windows: DPAPI, CurrentUser scope (`ProtectedData.Protect` through the built-in PowerShell 5.1). Only this
 *     Windows user, on this PC, can unwrap the blob `vault.dpapi` in the data folder; the key itself never touches
 *     the disk in clear and never appears in a command line (it goes over stdin and stdout).
 *   - Linux: the desktop keyring through `secret-tool` (libsecret) when it works. When there is no keyring (no
 *     secret-tool, or no keyring service answering), a `vault.key` file readable only by this user (0600) inside the
 *     data folder, which bubblewrap hides from every agent; the owner is told so plainly (a startup card).
 *
 * A key is only ever created when its store is certainly empty and the vault has no data key yet; anything else is a
 * `VaultConfigError` (the vault stays closed for this run and the owner sees a card), never a silent new key.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { chmodPrivate } from '@pasabot/core';

export class OsKeyError extends Error {}

/** One helper run: exit status (null when it could not start), stdout and stderr. Never through a shell. */
export type KeyToolRunner = (
  cmd: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string; stderr: string };

export const runKeyTool: KeyToolRunner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 30_000,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Windows PowerShell 5.1 by its full path (never whatever `powershell` PATH finds first). */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** PowerShell that reads base64 on stdin and writes base64 on stdout: DPAPI CurrentUser protect or unprotect. */
export function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
}

const psArgs = (script: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  script,
];

export const DPAPI_FILE = 'vault.dpapi';

/**
 * The master key wrapped with DPAPI (CurrentUser) in `<home>/vault.dpapi`. `hasDataKey`: the vault already holds a
 * wrapped data key, so a missing blob is an error (a new key could never open it), not a reason to make one.
 */
export function dpapiMasterKey(
  home: string,
  hasDataKey: boolean,
  run: KeyToolRunner = runKeyTool,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const ps = windowsPowerShell(env);
  const file = join(home, DPAPI_FILE);
  const unprotect = (blob: string, what: string) => {
    const r = run(ps, psArgs(dpapiScript('Unprotect')), blob);
    if (r.status !== 0)
      throw new OsKeyError(
        `Windows could not unlock the vault key (${what}; DPAPI exit ${r.status ?? 'none'}): it only opens for the ` +
          'Windows user who saved it, on this PC',
      );
    const key = Buffer.from(r.stdout.trim(), 'base64');
    if (key.length !== 32) throw new OsKeyError(`the vault key from Windows is malformed (${what})`);
    return key;
  };
  if (existsSync(file)) return unprotect(readFileSync(file, 'utf8').trim(), 'saved key');
  if (hasDataKey)
    throw new OsKeyError(
      `the vault key file ${DPAPI_FILE} is missing from the data folder, so saved secrets cannot be opened`,
    );
  const key = randomBytes(32);
  const r = run(ps, psArgs(dpapiScript('Protect')), key.toString('base64'));
  const blob = r.stdout.trim();
  if (r.status !== 0 || !/^[A-Za-z0-9+/=]{40,}$/.test(blob))
    throw new OsKeyError(`Windows could not protect a new vault key (DPAPI exit ${r.status ?? 'none'})`);
  const tmp = `${file}.new`;
  writeFileSync(tmp, blob, { mode: 0o600 });
  renameSync(tmp, file);
  // only what reads back is used: never a key the next boot could not open
  const back = unprotect(readFileSync(file, 'utf8').trim(), 'read back after create');
  if (!back.equals(key)) throw new OsKeyError('the vault key did not read back from Windows unchanged');
  return back;
}

const SECRET_ATTRS = (account: string) => ['service', 'pasabot-vault', 'account', account];

/**
 * The master key in the Linux desktop keyring (libsecret's `secret-tool`). Returns null when there is no working
 * keyring here (no secret-tool, or no keyring service answering) and the vault has no data key yet, so the caller can
 * fall back to a key file. A keyring that held the key before and fails now is an error, never a fallback.
 */
export function secretToolMasterKey(
  account: string,
  o: { hasDataKey: boolean; usedBefore: boolean },
  run: KeyToolRunner = runKeyTool,
): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new OsKeyError('vault: unexpected keyring account name');
  const lookup = () => run('secret-tool', ['lookup', ...SECRET_ATTRS(account)]);
  const decode = (s: string, what: string) => {
    const key = Buffer.from(s.trim(), 'base64');
    if (key.length !== 32) throw new OsKeyError(`the keyring's vault key is malformed (${what})`);
    return key;
  };
  const found = lookup();
  if (found.status === 0 && found.stdout.trim()) return decode(found.stdout, 'stored item');
  if (o.usedBefore)
    throw new OsKeyError(
      'the desktop keyring did not give back the vault key (locked, or not running); unlock it and start again',
    );
  if (o.hasDataKey) return null; // a vault made with another key source: the caller decides
  const key = randomBytes(32).toString('base64');
  const stored = run(
    'secret-tool',
    ['store', '--label=PasaBot vault key', ...SECRET_ATTRS(account)],
    key, // over stdin, never in argv
  );
  if (stored.status !== 0) return null;
  const back = lookup();
  if (back.status !== 0 || !back.stdout.trim()) return null;
  return decode(back.stdout, 'read back after create');
}

/**
 * Last resort on a Linux desktop with no keyring: `<home>/vault.key`, 0600. bubblewrap hides the whole data folder
 * from agents, so only this user's own programs outside PasaBot can read it; the owner is told so.
 */
export function fallbackKeyFile(home: string, hasDataKey: boolean): Buffer {
  const p = join(home, 'vault.key');
  if (!existsSync(p)) {
    if (hasDataKey)
      throw new OsKeyError('the vault key file vault.key is missing, so saved secrets cannot be opened');
    writeFileSync(p, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  chmodSync(p, 0o600);
  chmodPrivate(p);
  const key = Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new OsKeyError('vault.key is malformed');
  return key;
}
