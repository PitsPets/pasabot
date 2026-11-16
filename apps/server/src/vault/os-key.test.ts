/**
 * The vault master key on Windows (DPAPI) and the Linux desktop (secret-tool, else a 0600 file), with the key tools
 * faked: PowerShell and secret-tool are recorded, never run, so this proves the logic on any OS.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_MIGRATIONS_DIR, openDatabase, runMigrations } from '@pasabot/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempHome } from '../../../../packages/testkit/src/index.js';
import { LocalVault, osMasterKeySource, VaultConfigError } from './index.js';
import { dpapiScript, type KeyToolRunner, windowsPowerShell } from './os-key.js';

const made: (() => void)[] = [];
afterEach(() => {
  while (made.length) made.pop()!();
});
function freshDb() {
  const home = tempHome();
  const db = openDatabase(join(home.dir, 'pasabot.db'));
  runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }], { backupDir: join(home.dir, 'backups') });
  made.push(() => {
    db.close();
    home.cleanup();
  });
  return { home: home.dir, db };
}

/** a fake DPAPI: "protect" reverses the base64 text and tags it; only the same fake can unprotect */
function fakeDpapi(log: { cmd: string; args: string[]; input?: string }[], user = 'me'): KeyToolRunner {
  return (cmd, args, input) => {
    log.push({ cmd, args, input });
    const script = args[args.length - 1] ?? '';
    const text = (input ?? '').trim();
    if (script.includes('::Protect('))
      return { status: 0, stdout: `${Buffer.from(`${user}:${text}`).toString('base64')}`, stderr: '' };
    if (script.includes('::Unprotect(')) {
      const plain = Buffer.from(text, 'base64').toString();
      if (!plain.startsWith(`${user}:`)) return { status: 1, stdout: '', stderr: 'wrong user' };
      return { status: 0, stdout: plain.slice(user.length + 1), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
}

describe('Windows DPAPI master key', () => {
  it('creates, stores and reopens the key; the key never travels in argv; PowerShell by its full path', async () => {
    const { home, db } = freshDb();
    const log: { cmd: string; args: string[]; input?: string }[] = [];
    const run = fakeDpapi(log);
    const o = {
      db,
      home,
      serverId: 's1',
      runnerMode: 'host-unsandboxed',
      source: 'dpapi' as const,
      keyTool: run,
    };
    const v = await LocalVault.open(o);
    const ref = await v.put('global', 'k', 'secret-value-123');
    expect(existsSync(join(home, 'vault.dpapi'))).toBe(true);
    expect(readFileSync(join(home, 'vault.dpapi'), 'utf8')).not.toContain('secret-value-123');
    const v2 = await LocalVault.open(o);
    expect(await v2.get(ref, { actor: 'test', purpose: 'unit' })).toBe('secret-value-123');
    for (const c of log) {
      expect(c.cmd).toBe(windowsPowerShell(process.env));
      expect(c.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
      // only the script is in argv: the key and the blob go over stdin
      expect(c.args.join(' ')).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
    expect(dpapiScript('Protect')).toContain('DataProtectionScope]::CurrentUser');
  });
  it('another Windows user, or a missing blob for an existing vault: the vault stays closed, never a new key', async () => {
    const { home, db } = freshDb();
    await LocalVault.open({
      db,
      home,
      serverId: 's1',
      runnerMode: 'host-unsandboxed',
      source: 'dpapi',
      keyTool: fakeDpapi([]),
    });
    await expect(
      LocalVault.open({
        db,
        home,
        serverId: 's1',
        runnerMode: 'host-unsandboxed',
        source: 'dpapi',
        keyTool: fakeDpapi([], 'other'),
      }),
    ).rejects.toThrow(VaultConfigError);
    rmSync(join(home, 'vault.dpapi'));
    await expect(
      LocalVault.open({
        db,
        home,
        serverId: 's1',
        runnerMode: 'host-unsandboxed',
        source: 'dpapi',
        keyTool: fakeDpapi([]),
      }),
    ).rejects.toThrow(/missing/);
    expect(existsSync(join(home, 'vault.dpapi'))).toBe(false);
  });
  it('the OS key store by platform', () => {
    expect(osMasterKeySource('win32')).toBe('dpapi');
    expect(osMasterKeySource('linux')).toBe('os-keyring');
    expect(osMasterKeySource('darwin')).toBe('keychain');
  });
});

/** a fake secret-tool keyring; `working: false` = no keyring service answering */
function fakeKeyring(store: Map<string, string>, working = true): KeyToolRunner {
  return (cmd, args, input) => {
    expect(cmd).toBe('secret-tool');
    if (!working) return { status: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' };
    const key = args
      .filter((a) => !a.startsWith('--'))
      .slice(1)
      .join('|');
    if (args[0] === 'store') {
      store.set(key, (input ?? '').trim());
      return { status: 0, stdout: '', stderr: '' };
    }
    const v = store.get(key);
    return v ? { status: 0, stdout: `${v}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
  };
}

describe('Linux desktop keyring master key', () => {
  it('uses the keyring when it works; the key goes over stdin', async () => {
    const { home, db } = freshDb();
    const store = new Map<string, string>();
    const notices: string[] = [];
    const o = {
      db,
      home,
      serverId: 's1',
      runnerMode: 'host',
      source: 'os-keyring' as const,
      keyTool: fakeKeyring(store),
      onNotice: (n: string) => notices.push(n),
    };
    await LocalVault.open(o);
    await LocalVault.open(o);
    expect(store.size).toBe(1);
    expect(existsSync(join(home, 'vault.key'))).toBe(false);
    expect(notices).toEqual([]);
  });
  it('no keyring on the first start: a 0600 key file and a notice; a keyring that worked before and fails is an error', async () => {
    const { home, db } = freshDb();
    const notices: string[] = [];
    const base = { db, home, serverId: 's1', runnerMode: 'host', source: 'os-keyring' as const };
    await LocalVault.open({
      ...base,
      keyTool: fakeKeyring(new Map(), false),
      onNotice: (n) => notices.push(n),
    });
    expect(notices).toEqual(['vault-key-file']);
    if (process.platform !== 'win32') expect(statSync(join(home, 'vault.key')).mode & 0o777).toBe(0o600);
    // later starts keep the file even when a keyring appears (never a second key)
    await LocalVault.open({ ...base, keyTool: fakeKeyring(new Map(), true) });

    const b = freshDb();
    const store = new Map<string, string>();
    const o2 = { db: b.db, home: b.home, serverId: 's2', runnerMode: 'host', source: 'os-keyring' as const };
    await LocalVault.open({ ...o2, keyTool: fakeKeyring(store) });
    await expect(LocalVault.open({ ...o2, keyTool: fakeKeyring(store, false) })).rejects.toThrow(/keyring/);
    expect(existsSync(join(b.home, 'vault.key'))).toBe(false);
  });
});
