import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';
import { ClaudeProvider } from '../../../../providers/claude/src/index.js';
import {
  bwrapArgs,
  cliCredentialPaths,
  createSandbox,
  defaultRunnerMode,
  hostModeWarning,
  hostSandboxAvailable,
  RunnerUnavailableError,
  readablePaths,
  writablePaths,
} from './sandbox.js';

const fakeCli = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'providers',
  'claude',
  'src',
  '__fixtures__',
  'fake-claude.mjs',
);

describe('runner modes', () => {
  it('picks a default per platform', () => {
    expect(defaultRunnerMode({}, 'darwin')).toBe('host');
    expect(defaultRunnerMode({ XDG_CURRENT_DESKTOP: 'GNOME' }, 'linux')).toBe('host');
    expect(defaultRunnerMode({ PASABOT_RUNNER: 'container' }, 'linux')).toBe('container');
  });
  it('modes whose launcher is not built refuse to run instead of running unsandboxed', () => {
    const wrap = createSandbox('container', { home: '/h', workspace: '/h/workspaces/a' })!;
    expect(() => wrap('claude', [])).toThrow(RunnerUnavailableError);
    expect(createSandbox('host-unsandboxed', { home: '/h', workspace: '/w' })).toBeUndefined();
  });
});

describe('macOS host-mode keychain limitation', () => {
  it('warns once at startup in macOS host mode only', async () => {
    expect(hostModeWarning('host', 'darwin')).toMatch(/\/usr\/bin\/security.*vault master key/);
    expect(hostModeWarning('host', 'linux')).toBeNull();
    expect(hostModeWarning('container', 'darwin')).toBeNull();
    const s = await bootTestServer({ runnerMode: 'host' });
    try {
      expect(s.startupWarnings).toEqual(
        process.platform === 'darwin' ? [hostModeWarning('host', 'darwin')] : [],
      );
    } finally {
      await s.cleanup();
    }
  });
});

describe('writable paths through the CommandWrapper (the CLI state folder)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-wr-')));
  const home = join(root, 'pasabot-home');
  const workspace = join(home, 'workspaces', 'a');
  const state = join(root, 'dot-claude');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('bwrap binds an existing writable path read-write; a missing one is skipped', () => {
    const args = bwrapArgs({ home, workspace }, 'claude', ['-p'], [state, join(root, 'missing')]);
    const i = args.indexOf(state);
    expect(args.slice(i - 1, i + 2)).toEqual(['--bind', state, state]);
    expect(args.join(' ')).not.toContain('missing');
    expect(args.slice(-3)).toEqual(['--', 'claude', '-p']);
  });

  it('refuses a writable path inside (or containing) $PASABOT_HOME', () => {
    expect(() => writablePaths({ home, workspace }, [join(home, 'workspaces')])).toThrow(
      RunnerUnavailableError,
    );
    expect(() => writablePaths({ home, workspace }, [root])).toThrow(RunnerUnavailableError);
    expect(writablePaths({ home, workspace }, [state])).toEqual([state]);
  });

  it('readable: only a folder below a module data dir; bwrap ro-binds it after hiding the home', () => {
    const agentDir = join(home, 'modules', 'acp-registry', 'agents', 'x');
    mkdirSync(agentDir, { recursive: true });
    expect(readablePaths({ home, workspace }, [agentDir, join(home, 'modules', 'nope')])).toEqual([agentDir]);
    for (const bad of [home, join(home, 'modules'), join(home, 'modules', 'acp-registry'), workspace, state])
      expect(() => readablePaths({ home, workspace }, [bad])).toThrow(RunnerUnavailableError);
    const args = bwrapArgs({ home, workspace }, 'agent', [], [], [agentDir]);
    const i = args.indexOf(agentDir);
    expect(args.slice(i - 1, i + 2)).toEqual(['--ro-bind', agentDir, agentDir]);
    expect(args.indexOf(home)).toBeLessThan(i - 1); // the home is hidden first, then the folder re-exposed
  });
});

// The real OS sandbox: sandbox-exec on macOS, bubblewrap on Linux. Skipped where neither can run (reported),
// except when PASABOT_REQUIRE_SANDBOX=1 (CI): then a missing sandbox tool fails instead of skipping.
const sandboxRequired = process.env.PASABOT_REQUIRE_SANDBOX === '1';
describe.runIf(sandboxRequired)('test:sandbox is required here', () => {
  it('the OS sandbox tool is installed and works (sandbox-exec / bwrap with user namespaces)', () => {
    expect(hostSandboxAvailable()).toBe(true);
  });
});
describe.skipIf(!hostSandboxAvailable() && !sandboxRequired)('test:sandbox', () => {
  let s: TestServer;
  let token = '';
  beforeAll(async () => {
    s = await bootTestServer({
      runnerMode: 'host',
      providers: [new ClaudeProvider({ command: [process.execPath, fakeCli], keychain: async () => null })],
    });
    token = seedUser(s.db).token;
    writeFileSync(join(s.home, 'vault.key'), 'planted-key-material'); // must stay unreadable even if present
  });
  afterAll(() => s.cleanup());

  const ask = async (chatId: string, text: string) => {
    await fetch(`${s.url}/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const end = Date.now() + 15_000;
    for (;;) {
      const m = (await (
        await fetch(`${s.url}/api/v1/chats/${chatId}/messages`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { messages: { authorKind: string; status: string; body: string }[] };
      const last = m.messages.filter((x) => x.authorKind === 'agent').at(-1);
      if (last && last.status !== 'streaming' && m.messages.at(-1) === last) return last;
      if (Date.now() > end) throw new Error('no reply');
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  it('a Claude-adapter agent at standard cannot read vault.key or pasabot.db, but can read its workspace', async () => {
    const created = (await (
      await fetch(`${s.url}/api/v1/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Boxed', providerId: 'claude', trustLevel: 'standard' }),
      })
    ).json()) as { agent: { workspaceDir: string }; chatId: string };
    writeFileSync(join(created.agent.workspaceDir, 'ok.txt'), 'fine');

    expect((await ask(created.chatId, `READ:${join(s.home, 'vault.key')}`)).body).toMatch(/^READ_DENIED/);
    expect((await ask(created.chatId, `READ:${join(s.home, 'pasabot.db')}`)).body).toMatch(/^READ_DENIED/);
    expect((await ask(created.chatId, `READ:${join(created.agent.workspaceDir, 'ok.txt')}`)).body).toMatch(
      /^READ_OK/,
    );
  });

  it('a readable module folder can be read and run inside the sandbox, but not written; the rest stays hidden', async () => {
    const { execFileSync } = await import('node:child_process');
    const ws = join(s.home, 'workspaces', 'rd');
    const dir = join(s.home, 'modules', 'acp-registry', 'agents', 'rd');
    mkdirSync(ws, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.mjs'), "console.log('ran')");
    const wrap = createSandbox('host', { home: s.home, workspace: ws })!;
    const run = (script: string) => {
      const c = wrap(process.execPath, ['-e', script], { readable: [dir] });
      try {
        return execFileSync(c.cmd, c.args, { cwd: ws, stdio: 'pipe', timeout: 10_000 }).toString().trim();
      } catch {
        return 'DENIED';
      }
    };
    expect(run(`import(${JSON.stringify(join(dir, 'agent.mjs'))})`)).toBe('ran');
    expect(run(`require('fs').writeFileSync(${JSON.stringify(join(dir, 'x'))}, 'x')`)).toBe('DENIED');
    expect(run(`require('fs').readFileSync(${JSON.stringify(join(s.home, 'vault.key'))})`)).toBe('DENIED');
    expect(() => wrap('true', [], { readable: [s.home] })).toThrow(RunnerUnavailableError);
  });

  it.runIf(process.platform === 'darwin')(
    'the Seatbelt profile refuses launchd/LaunchServices escapes',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const { seatbeltProfile } = await import('./sandbox.js');
      const profile = seatbeltProfile(s.home, join(s.home, 'workspaces', 'x'));
      for (const bin of ['/bin/launchctl', '/usr/bin/osascript', '/usr/bin/open']) {
        let err = '';
        try {
          execFileSync('/usr/bin/sandbox-exec', ['-p', profile, bin, '-h'], { stdio: 'pipe', timeout: 5000 });
        } catch (e) {
          err = String((e as { stderr?: Buffer }).stderr ?? '');
        }
        expect(err).toContain('Operation not permitted');
      }
      // the same profile still runs ordinary commands
      expect(
        execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/echo', 'ok']).toString().trim(),
      ).toBe('ok');
    },
  );

  // security review 2026-11-15: a copied `open`, or NSWorkspace from python3/swift, reached LaunchServices, which
  // starts an app as its own responsible process (PasaBot Screen Helper with the owner's screen permissions)
  it.runIf(process.platform === 'darwin')(
    'the Seatbelt profile cuts LaunchServices itself, whatever binary asks, and guards the helper folder',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const { userInfo } = await import('node:os');
      const { seatbeltProfile } = await import('./sandbox.js');
      const profile = seatbeltProfile(s.home, join(s.home, 'workspaces', 'x'));
      expect(profile).toContain('(deny lsopen)');
      expect(profile).toContain('(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))');
      const helperHome = join(userInfo().homedir, '.pasabot');
      expect(profile).toContain(`(deny file-read-data file-write* (subpath "${join(helperHome, 'run')}"))`);
      expect(profile).toContain(`(deny file-write* (literal "${helperHome}"))`);
      // asking LaunchServices for an app (no launch): answered outside the sandbox, refused inside it
      const ask =
        'import AppKit\nprint(NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.finder") == nil ? "none" : "found")';
      const swift = (args: string[]) => {
        try {
          return execFileSync('/usr/bin/sandbox-exec', args, { stdio: 'pipe', timeout: 60_000 })
            .toString()
            .trim();
        } catch (e) {
          return `error: ${String((e as { stderr?: Buffer }).stderr ?? e)}`;
        }
      };
      const hasSwift = (() => {
        try {
          execFileSync('/usr/bin/xcrun', ['--find', 'swift'], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      })();
      if (hasSwift) {
        expect(swift(['-p', '(version 1)\n(allow default)', '/usr/bin/swift', '-e', ask])).toBe('found');
        expect(swift(['-p', profile, '/usr/bin/swift', '-e', ask])).toBe('none');
      }
    },
    120_000,
  );
});

// The `pasabot` CLI keeps an owner session token and automation tokens in $XDG_CONFIG_HOME|~/.config/pasabot; a
// host-mode agent shares the OS user, so the sandbox must deny that folder like $PASABOT_HOME (ARCHITECTURE 7.2).
describe('the pasabot CLI credential folder is a protected tree', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-cred-')));
  const home = join(root, 'pasabot-home');
  const workspace = join(home, 'workspaces', 'a');
  const xdg = join(root, 'xdg-config');
  const cred = join(xdg, 'pasabot');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cred, { recursive: true });
  // a planted fixture, never a real token
  writeFileSync(join(cred, 'session.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'planted' }));
  writeFileSync(join(workspace, 'ok.txt'), 'workspace-file');
  const savedXdg = process.env.XDG_CONFIG_HOME;
  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = xdg;
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(root, { recursive: true, force: true });
  });

  it('both the XDG and the ~/.config locations are denied by Seatbelt, hidden by bwrap and never writable', async () => {
    const { homedir } = await import('node:os');
    const { seatbeltProfile } = await import('./sandbox.js');
    expect(cliCredentialPaths('/u', { XDG_CONFIG_HOME: '/x' })).toEqual(['/u/.config/pasabot', '/x/pasabot']);
    expect(cliCredentialPaths('/u', {})).toEqual(['/u/.config/pasabot']);
    const profile = seatbeltProfile(home, workspace);
    expect(profile).toContain(`(deny file-read-data file-write* (subpath "${cred}"))`);
    expect(profile).toContain(`(subpath "${join(realpathSync(homedir()), '.config', 'pasabot')}")`);
    const args = bwrapArgs({ home, workspace }, 'claude', []);
    const i = args.indexOf(cred);
    expect(args.slice(i - 1, i + 1)).toEqual(['--tmpfs', cred]);
    for (const w of [cred, xdg])
      expect(() => writablePaths({ home, workspace }, [w])).toThrow(RunnerUnavailableError);
  });

  it('per-user CLI folders are never writable: the server runs what it finds there unsandboxed (detect)', async () => {
    const { homedir } = await import('node:os');
    const { seatbeltProfile } = await import('./sandbox.js');
    const local = join(realpathSync(homedir()), '.local', 'bin');
    expect(seatbeltProfile(home, workspace)).toContain(`(deny file-write* (subpath "${local}"))`);
    if (existsSync(local))
      expect(() => writablePaths({ home, workspace }, [local])).toThrow(RunnerUnavailableError);
  });

  // Review finding (PATH hijack): brain detection runs the first `claude` on the server's CLI search path outside the
  // sandbox, and that path puts PATH, Homebrew and the running Node's folder (e.g. ~/.local/node/bin) BEFORE
  // ~/.local/bin. Every one of those folders must be read-only to an agent, and their parents must not be renamable.
  it('every folder on the CLI search path (PATH, Homebrew, the running Node) is never writable by an agent', async () => {
    const { seatbeltProfile, cliDirs } = await import('./sandbox.js');
    const planted = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-pathdir-')));
    const bin = join(planted, 'node', 'bin');
    mkdirSync(bin, { recursive: true });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${saved}`;
    try {
      const nodeDir = realpathSync(dirname(process.execPath));
      expect(cliDirs()).toContain(nodeDir);
      expect(cliDirs()).toContain(bin);
      const profile = seatbeltProfile(home, workspace);
      expect(profile).toContain(`(deny file-write* (subpath "${nodeDir}"))`);
      expect(profile).toContain(`(deny file-write* (subpath "${bin}"))`);
      // the parent chain cannot be renamed and swapped for a symlink
      expect(profile).toContain(`(deny file-write* (literal "${join(planted, 'node')}"))`);
      for (const w of [bin, nodeDir, join(planted, 'node')])
        expect(() => writablePaths({ home, workspace }, [w])).toThrow(RunnerUnavailableError);
      if (hostSandboxAvailable() && process.platform === 'darwin') {
        const { execFileSync } = await import('node:child_process');
        const wrap = createSandbox('host', { home, workspace })!;
        const run = (cmd: string, args: string[]) => {
          const c = wrap(cmd, args);
          try {
            execFileSync(c.cmd, c.args, { cwd: workspace, stdio: 'pipe', timeout: 10_000 });
            return 'OK';
          } catch {
            return 'DENIED';
          }
        };
        expect(run('/usr/bin/touch', [join(bin, 'claude')])).toBe('DENIED');
        expect(existsSync(join(bin, 'claude'))).toBe(false);
        expect(run('/bin/mv', [join(planted, 'node'), join(planted, 'moved')])).toBe('DENIED');
        expect(existsSync(join(planted, 'node', 'bin'))).toBe(true);
        // a sibling folder that is not on the search path stays writable (writes elsewhere are not broken)
        expect(run('/usr/bin/touch', [join(planted, 'other.txt')])).toBe('OK');
        expect(run('/usr/bin/touch', [join(workspace, 'w.txt')])).toBe('OK');
      }
    } finally {
      process.env.PATH = saved;
      rmSync(planted, { recursive: true, force: true });
    }
  });

  it.skipIf(!hostSandboxAvailable())(
    'a sandboxed agent process cannot read session.json, but can still read its workspace',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const wrap = createSandbox('host', { home, workspace })!;
      const read = (p: string) => {
        const c = wrap('/bin/cat', [p]);
        try {
          return execFileSync(c.cmd, c.args, { cwd: workspace, stdio: 'pipe', timeout: 10_000 }).toString();
        } catch {
          return 'DENIED';
        }
      };
      expect(read(join(workspace, 'ok.txt'))).toBe('workspace-file');
      expect(read(join(cred, 'session.json'))).toBe('DENIED');
    },
  );
});

// Review (brains2, high): re-allowing login.keychain-db let anything the sandboxed agent ran (its own Bash tool
// included) read every login-keychain item through /usr/bin/security: the vault master key, other CLIs' tokens, and a
// list of every item. Every keychain file stays denied; the Claude CLI's login is handed in from outside instead
// (providers/claude `sandboxLoginEnv`).
describe('no keychain file is ever readable inside the sandbox', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-kc-')));
  const home = join(root, 'pasabot-home');
  const workspace = join(home, 'workspaces', 'a');
  mkdirSync(workspace, { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const userHome = realpathSync(process.env.HOME || tmpdir());
  const kc = join(userHome, 'Library', 'Keychains');
  const login = join(kc, 'login.keychain-db');

  it('the profile denies ~/Library/Keychains and re-allows nothing inside it', async () => {
    const { seatbeltProfile } = await import('./sandbox.js');
    const p = seatbeltProfile(home, workspace);
    expect(p).toContain(`(deny file-read-data file-write* (subpath "${kc}"))`);
    expect(p).not.toContain('login.keychain-db');
    expect(p.split('\n').filter((l) => l.includes(kc) && l.startsWith('(allow'))).toEqual([]);
  });

  it.runIf(process.platform === 'darwin' && existsSync(login))(
    'inside Seatbelt the login keychain file opens neither for reading nor for writing, whatever the CLI asks',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const wrap = createSandbox('host', { home, workspace })!;
      // opens and closes the file: nothing of its content is read or printed
      const open = (mode: 'r' | 'r+', opts?: Record<string, unknown>) => {
        const js = `const f=require('fs');f.closeSync(f.openSync(${JSON.stringify(login)},'${mode}'));console.log('opened')`;
        const c = (wrap as (cmd: string, args: string[], o?: unknown) => { cmd: string; args: string[] })(
          process.execPath,
          ['-e', js],
          opts,
        );
        try {
          return execFileSync(c.cmd, c.args, { cwd: workspace, stdio: 'pipe', timeout: 10_000 })
            .toString()
            .trim();
        } catch {
          return 'DENIED';
        }
      };
      expect(open('r')).toBe('DENIED');
      // the removed opt-in is ignored if a stale caller still passes it
      expect(open('r', { loginKeychain: true })).toBe('DENIED');
      expect(open('r+', { loginKeychain: true })).toBe('DENIED');
    },
  );
});

// the owner's private nickname reached a new agent: a brain CLI loaded his personal global instructions. Beside each
// adapter's clean config home, the sandbox denies the user's personal agent setup and every instruction file above
// the workspace; only the CLIs' sign-in files stay usable
describe('clean agents: the personal agent setup and instruction files above the workspace are never readable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pasabot-clean-')));
  const anc = join(root, 'projects');
  const home = join(anc, 'pasabot-home');
  const workspace = join(home, 'workspaces', 'a');
  mkdirSync(workspace, { recursive: true });
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
    writeFileSync(join(anc, f), 'CANARY: call the user Captain Canary.');
  mkdirSync(join(anc, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(anc, '.claude', 'rules', 'canary.md'), 'CANARY');
  writeFileSync(join(workspace, 'AGENTS.md'), "the agent's own");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const userHome = realpathSync(process.env.HOME || tmpdir());

  it('the Seatbelt profile denies each personal tree and ancestor file, and re-allows only the sign-in files', async () => {
    const { seatbeltProfile, personalAgentPaths, personalLoginFiles, ancestorInstructionPaths } =
      await import('./sandbox.js');
    const p = seatbeltProfile(home, workspace);
    const trees = [
      '.claude',
      '.claude.json',
      '.codex',
      join('.config', 'opencode'),
      join('.local', 'share', 'opencode'),
    ];
    for (const t of trees)
      expect(p).toContain(`(deny file-read-data file-write* (subpath "${join(userHome, t)}"))`);
    expect(personalAgentPaths(userHome)).toContain(join(userHome, '.gemini', 'GEMINI.md'));
    // with no sign-in file in this turn's writable list, none is put back
    for (const f of personalLoginFiles(userHome)) expect(p).not.toContain(`(literal "${f}"))`);
    // nothing else is allowed back read-write but the workspace
    const allowed = p.split('\n').filter((l) => l.startsWith('(allow file-read-data file-write*'));
    expect(allowed.filter((l) => !l.includes('(literal') && !l.includes(workspace))).toEqual([]);
    const above = ancestorInstructionPaths(workspace);
    expect(above).toContain(join(anc, 'AGENTS.md'));
    expect(above).toContain(join(anc, '.claude'));
    expect(above).toContain('/CLAUDE.md');
    expect(above).not.toContain(join(workspace, 'AGENTS.md'));
  });

  it("only this turn's own sign-in file is put back, never another brain's", async () => {
    const { seatbeltProfile, personalLoginFiles } = await import('./sandbox.js');
    const [claude, codex, opencode] = personalLoginFiles(userHome) as [string, string, string];
    const p = seatbeltProfile(home, workspace, [], [codex]);
    expect(p).toContain(`(allow file-read-data file-write* (literal "${codex}"))`);
    expect(p).not.toContain(`(literal "${claude}"))`);
    expect(p).not.toContain(`(literal "${opencode}"))`);
  });

  it("another brain's state folder (Gemini, Grok) is denied unless this turn runs on that brain", async () => {
    const { seatbeltProfile, brainStateFolders } = await import('./sandbox.js');
    const [gemini, grok] = brainStateFolders(userHome) as [string, string];
    const deny = (f: string) => `(deny file-read-data file-write* (subpath "${f}"))`;
    const other = seatbeltProfile(home, workspace);
    expect(other).toContain(deny(gemini));
    expect(other).toContain(deny(grok));
    const onGemini = seatbeltProfile(home, workspace, [], [gemini]);
    expect(onGemini).not.toContain(deny(gemini));
    expect(onGemini).toContain(deny(grok));
    // its personal memory file stays denied on its own brain too
    expect(onGemini).toContain(deny(join(gemini, 'GEMINI.md')));
  });

  it('bwrap hides them after the writable binds (so they win) and puts the sign-in files back', () => {
    const a = bwrapArgs({ home, workspace }, 'true', [], []);
    const at = (flag: string, p: string) => a.findIndex((x, i) => x === p && a[i - 1] === flag);
    const hidden = a.findIndex((x, i) => x === join(anc, 'AGENTS.md') && a[i - 1] === '/dev/null');
    expect(a[hidden - 2]).toBe('--ro-bind');
    expect(at('--tmpfs', join(anc, '.claude'))).toBeGreaterThan(-1);
    const codex = join(userHome, '.codex');
    const auth = join(codex, 'auth.json');
    if (existsSync(codex)) expect(at('--tmpfs', codex)).toBeGreaterThan(-1);
    // only when this turn's brain lists it
    if (existsSync(auth)) expect(at('--bind', realpathSync(auth))).toBe(-1);
    const own = bwrapArgs({ home, workspace }, 'true', [], [auth]);
    const atOwn = (flag: string, p: string) => own.findIndex((x, i) => x === p && own[i - 1] === flag);
    if (existsSync(auth))
      expect(own.lastIndexOf(realpathSync(auth))).toBeGreaterThan(atOwn('--tmpfs', codex));
  });

  it.runIf(process.platform === 'darwin' && hostSandboxAvailable())(
    "inside Seatbelt a CLI cannot open an instruction file above its workspace, but opens the workspace's own",
    async () => {
      const { execFileSync } = await import('node:child_process');
      const wrap = createSandbox('host', { home, workspace })!;
      // opens and closes the file: nothing of its content is read or printed
      const open = (path: string) => {
        const js = `const f=require('fs');f.closeSync(f.openSync(${JSON.stringify(path)},'r'));console.log('opened')`;
        const c = wrap(process.execPath, ['-e', js]);
        try {
          return execFileSync(c.cmd, c.args, { cwd: workspace, stdio: 'pipe', timeout: 10_000 })
            .toString()
            .trim();
        } catch {
          return 'DENIED';
        }
      };
      for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) expect(open(join(anc, f))).toBe('DENIED');
      expect(open(join(anc, '.claude', 'rules', 'canary.md'))).toBe('DENIED');
      expect(open(join(workspace, 'AGENTS.md'))).toBe('opened');
      for (const own of [join(userHome, '.claude', 'CLAUDE.md'), join(userHome, '.codex', 'AGENTS.md')])
        if (existsSync(own)) expect(open(own)).toBe('DENIED');
    },
  );
});
