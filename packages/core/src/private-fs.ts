import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { windowsPowerShellPath } from './win.js';

/** Owner-only permissions for everything PasaBot keeps under its data dir (workspaces, blobs, logs, module data). */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const posix = process.platform !== 'win32';

/**
 * `mkdir -p` whose newly created folders are owner-only (0o700). An existing folder is left as it is, unless
 * `tighten` is set (only for folders PasaBot itself owns, never a user-chosen workspace). Windows: plain mkdir,
 * permissions there come from the ACLs of the parent folder.
 */
export function mkdirPrivate(dir: string, o: { tighten?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (o.tighten && posix) chmodSync(dir, PRIVATE_DIR_MODE);
}

/** A program run for `protectDataDir`: exit status (null when it could not start) and stdout. Never a shell. */
export type AclRunner = (
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
) => { status: number | null; stdout: string };

const runAclTool: AclRunner = (cmd, args, env) => {
  // a repair pass walks the folder once (children back to inheriting), so it may take a while; a check does not
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/**
 * Windows PowerShell 5.1 that makes the folder in $env:PASABOT_ACL_DIR this user's alone and says what it did
 * (`ok`: it already was, nothing written; `fixed`; `open:<why>` with a non-zero exit when it could not). "Alone" is
 * checked, not assumed: owned by this user (an owner can always rewrite the list), inheritance off, and no entry for
 * any other account. Only when that fails is the list replaced (owner, inheritance off, full control for this user
 * only) and every child reset to inherit it (`icacls /reset`), so an entry copied in or left by another account is
 * gone too; then it is checked again. The usual start reads the list and writes nothing (no walk of the folder).
 */
export const WINDOWS_DATA_DIR_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$d = $env:PASABOT_ACL_DIR',
  '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  'function Why($a) {',
  "  if ($a.GetOwner($sid).Value -ne $me.Value) { return 'owner' }",
  "  if (-not $a.AreAccessRulesProtected) { return 'inherited' }",
  "  foreach ($r in $a.GetAccessRules($true, $true, $sid)) { if ($r.IdentityReference.Value -ne $me.Value) { return 'other' } }",
  "  return ''",
  '}',
  "if (-not (Why ([System.IO.Directory]::GetAccessControl($d)))) { [Console]::Out.Write('ok'); exit 0 }",
  '$n = New-Object System.Security.AccessControl.DirectorySecurity',
  '$n.SetOwner($me)',
  '$n.SetAccessRuleProtection($true, $false)',
  "$n.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))",
  '[System.IO.Directory]::SetAccessControl($d, $n)',
  "$ErrorActionPreference = 'Continue'",
  '& "$env:SystemRoot\\System32\\icacls.exe" (Join-Path $d \'*\') /reset /T /C /L /Q 2>&1 | Out-Null',
  "$ErrorActionPreference = 'Stop'",
  '$after = Why ([System.IO.Directory]::GetAccessControl($d))',
  'if ($after) { [Console]::Out.Write("open:$after"); exit 3 }',
  "[Console]::Out.Write('fixed'); exit 0",
].join('\r\n');

/** The PowerShell command line for `WINDOWS_DATA_DIR_ACL_SCRIPT` (encoded: no quoting of the script, no profile). */
export function windowsAclCommand(env: Record<string, string | undefined> = process.env): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: windowsPowerShellPath(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_DATA_DIR_ACL_SCRIPT, 'utf16le').toString('base64'),
    ],
  };
}

/**
 * Windows: chmod is a no-op there, so PasaBot's data folder (the database, the vault key, run/ with the lock and the
 * launcher's files, logs, workspaces) gets an explicit access list instead: owned by this user, inheritance off, full
 * control for this user only. A data folder outside the profile (D:\pasabot) would otherwise inherit "Authenticated
 * Users: Modify" from the drive, and one made first by another account would keep that account's entries (and, as its
 * owner, the right to change the list at any time). The folder's path reaches PowerShell as a variable, never as
 * script text. POSIX: unchanged (`mkdirPrivate` already makes it 0700). 'failed' is reported to the owner as a card.
 */
export function protectDataDir(
  dir: string,
  o: { platform?: NodeJS.Platform; run?: AclRunner; env?: Record<string, string | undefined> } = {},
): 'ok' | 'failed' | 'skipped' {
  if ((o.platform ?? process.platform) !== 'win32') return 'skipped';
  const run = o.run ?? runAclTool;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return 'failed';
  }
  const env = o.env ?? process.env;
  const c = windowsAclCommand(env);
  const r = run(c.cmd, c.args, { ...env, PASABOT_ACL_DIR: dir });
  return r.status === 0 && /^(ok|fixed)$/.test(r.stdout.trim()) ? 'ok' : 'failed';
}

/** chmod a PasaBot-owned file to owner-only (0o600); a no-op on Windows or when the file is gone. */
export function chmodPrivate(path: string, mode = PRIVATE_FILE_MODE): void {
  if (!posix) return;
  try {
    chmodSync(path, mode);
  } catch {
    /* gone or not ours: nothing to tighten */
  }
}
