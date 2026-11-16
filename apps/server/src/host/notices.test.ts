/**
 * The Windows/Linux "what the owner should know" cards and the careful default, with the platform injected (this
 * proves the server logic on any OS; a real Windows PC is still needed for icacls/DPAPI themselves: selftest.ps1).
 */

import { protectDataDir, WINDOWS_DATA_DIR_ACL_SCRIPT, windowsAclCommand } from '@pasabot/core';
import { describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../../packages/testkit/src/index.js';
import { defaultRunnerMode, hostModeWarning, linuxSandboxProblem, scrubbedEnv } from '../runner/sandbox.js';

describe('the Windows sandbox story, stated honestly', () => {
  it('Windows defaults to no sandbox (named so), with a plain warning; never a sandbox that silently fails', () => {
    expect(defaultRunnerMode({}, 'win32')).toBe('host-unsandboxed');
    expect(defaultRunnerMode({ PASABOT_RUNNER: 'host' }, 'win32')).toBe('host');
    expect(hostModeWarning('host-unsandboxed', 'win32')).toMatch(/Windows: no OS sandbox/);
    expect(hostModeWarning('host-unsandboxed', 'darwin')).toMatch(/^macOS host mode/);
  });
  it('the owner sees a card, new helpers start careful, the owner can still change it; others see nothing', async () => {
    const s = await bootTestServer({ platform: 'win32' });
    try {
      const owner = seedUser(s.db, 'owner');
      const member = seedUser(s.db, 'member', 'M');
      const get = (token: string) =>
        fetch(`${s.url}/api/v1/system/notices`, { headers: { authorization: `Bearer ${token}` } });
      const r = (await (await get(owner.token)).json()) as { notices: { id: string }[]; platform: string };
      expect(r.platform).toBe('win32');
      expect(r.notices.map((n) => n.id)).toContain('windows-no-sandbox');
      expect((await get(member.token)).status).toBe(403);
      expect((await fetch(`${s.url}/api/v1/system/notices`)).status).toBe(401);
      const trust = await fetch(`${s.url}/api/v1/settings/agent-trust`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(((await trust.json()) as { defaultTrust: string }).defaultTrust).toBe('guarded');
      // the self-check is Windows-package only: not installed here
      const check = await fetch(`${s.url}/api/v1/system/check`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(check.status).toBe(409);
    } finally {
      await s.cleanup();
    }
  });
  it('an owner who already picked a default keeps it; macOS and Linux boots show no Windows card', async () => {
    const home = tempHome();
    // every server is closed before the folder goes, even when an assertion fails first: an open database is
    // locked on Windows, and a failed cleanup would hide the real failure behind EBUSY
    const open = new Set<TestServer>();
    const boot = async (platform: NodeJS.Platform) => {
      const s = await bootTestServer({ home: home.dir, platform });
      open.add(s);
      return s;
    };
    const close = async (s: TestServer) => {
      open.delete(s);
      await s.close();
    };
    try {
      // the platform is always named: left to the default, a Windows runner would boot as win32 and show the card
      for (const platform of ['darwin', 'linux'] as const) {
        const a = await boot(platform);
        const owner = seedUser(a.db, 'owner');
        const r = (await (
          await fetch(`${a.url}/api/v1/system/notices`, {
            headers: { authorization: `Bearer ${owner.token}` },
          })
        ).json()) as { notices: { id: string }[] };
        expect(r.notices.map((n) => n.id)).not.toContain('windows-no-sandbox');
        // and no careful default was written for the owner
        expect(
          a.db.prepare("SELECT 1 FROM settings WHERE key = 'agents.defaultTrust'").get(),
        ).toBeUndefined();
        if (platform === 'linux')
          a.db
            .prepare("INSERT INTO settings (key, value) VALUES ('agents.defaultTrust', ?)")
            .run(JSON.stringify('trusted'));
        await close(a);
      }
      const b = await boot('win32');
      const o2 = seedUser(b.db, 'owner');
      const t = await fetch(`${b.url}/api/v1/settings/agent-trust`, {
        headers: { authorization: `Bearer ${o2.token}` },
      });
      expect(((await t.json()) as { defaultTrust: string }).defaultTrust).toBe('trusted');
      await close(b);
    } finally {
      for (const s of open) await s.close().catch(() => {});
      home.cleanup();
    }
  });
});

describe('Windows data folder and child environment', () => {
  it('the data folder is checked first and only repaired when it is not this user’s alone (one PowerShell, no shell)', () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    let answer = { status: 0 as number | null, stdout: 'ok' };
    const run = (cmd: string, args: string[], env: Record<string, string | undefined>) => {
      calls.push({ cmd, args, env });
      return answer;
    };
    const home = tempHome();
    try {
      const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' };
      // already this user's alone: nothing is written, nothing walks the folder
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('ok');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(calls[0]!.args).toEqual(windowsAclCommand(env).args);
      // the path travels as a variable, never inside the script text (a ’ or $ in a folder name stays a name)
      expect(calls[0]!.env.PASABOT_ACL_DIR).toBe(home.dir);
      const script = Buffer.from(calls[0]!.args.at(-1)!, 'base64').toString('utf16le');
      expect(script).toBe(WINDOWS_DATA_DIR_ACL_SCRIPT);
      expect(script).not.toContain(home.dir);
      // what "alone" means: owner, inheritance off, no other account; the repair replaces the whole list and resets
      // the children, then checks again
      expect(script).toContain("return 'owner'");
      expect(script).toContain('AreAccessRulesProtected');
      expect(script).toContain("return 'other'");
      expect(script).toContain('SetAccessRuleProtection($true, $false)');
      expect(script).toContain('/reset /T /C /L /Q');
      expect(script.indexOf("Write('ok'); exit 0")).toBeLessThan(script.indexOf('SetAccessControl($d'));
      answer = { status: 0, stdout: 'fixed' };
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('ok');
      // a folder owned by another account (or one we may not change) cannot be made private: the card shows
      answer = { status: 3, stdout: 'open:owner' };
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('failed');
      answer = { status: 1, stdout: '' };
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('failed');
      answer = { status: null, stdout: '' };
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('failed');
      answer = { status: 0, stdout: 'something else' };
      expect(protectDataDir(home.dir, { platform: 'win32', run, env })).toBe('failed');
      expect(protectDataDir(home.dir, { platform: 'darwin', run })).toBe('skipped');
    } finally {
      home.cleanup();
    }
  });
  it('scrubbedEnv on Windows keeps SystemRoot/TEMP/APPDATA/PATHEXT (the CLI can open sockets) and no secret', () => {
    const env = {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PASABOT_VAULT_PASSPHRASE: 'never',
      ANTHROPIC_API_KEY: 'never',
    };
    const out = scrubbedEnv({}, env, 'win32');
    expect(out.SystemRoot).toBe('C:\\Windows');
    expect(out.TEMP).toBeTruthy();
    expect(out.APPDATA).toBeTruthy();
    expect(out.PATHEXT).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('never');
    expect(scrubbedEnv({}, env, 'linux').SystemRoot).toBeUndefined();
  });
});

describe('Linux sandbox card instead of a crash per turn', () => {
  it('names the cause: not installed, user namespaces blocked (Ubuntu 23.10+), or something else', () => {
    const base = { platform: 'linux' as const, works: () => false };
    expect(linuxSandboxProblem({ ...base, hasBwrap: () => false })).toBe('missing');
    expect(
      linuxSandboxProblem({
        ...base,
        hasBwrap: () => true,
        readSysctl: (p) => (p.endsWith('apparmor_restrict_unprivileged_userns') ? '1' : null),
      }),
    ).toBe('userns');
    expect(linuxSandboxProblem({ ...base, hasBwrap: () => true, readSysctl: () => null })).toBe('other');
    expect(linuxSandboxProblem({ platform: 'linux', works: () => true })).toBeNull();
    expect(linuxSandboxProblem({ platform: 'darwin' })).toBeNull();
  });
});
