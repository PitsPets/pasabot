/**
 * Static proof for the files in deploy/ that this machine cannot run (no Docker here): the image is non-root and
 * health-checked, compose publishes on loopback with seccomp + AppArmor + no-new-privileges, and the seccomp
 * profile refuses the dangerous kernel surfaces. The live `docker compose up` proof needs a Docker host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

/**
 * Docker's .dockerignore rules, written here from their documented behaviour: patterns apply in order, `!` lets a path
 * back in and the last match wins; a pattern also matches when it matches one of the path's parent folders; `*` and
 * `?` stay inside one path segment and `**` spans any number of them. Returns "is this path left out of the context".
 */
function dockerignore(text: string): (path: string) => boolean {
  const rules = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const neg = l.startsWith('!');
      const p = posix
        .normalize((neg ? l.slice(1) : l).trim())
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      let re = '';
      for (let i = 0; i < p.length; i++) {
        const c = p[i]!;
        if (c === '*' && p[i + 1] === '*') {
          i++;
          if (p[i + 1] === '/') i++;
          re += i + 1 >= p.length ? '.*' : '(.*/)?';
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      return { neg, re: new RegExp(`^${re}$`) };
    });
  return (path) => {
    const parts = path.split('/');
    let excluded = false;
    for (const r of rules)
      if (parts.some((_, i) => r.re.test(parts.slice(0, i + 1).join('/')))) excluded = !r.neg;
    return excluded;
  };
}

describe('deploy files', () => {
  it('Dockerfile: non-root user, container runner, healthcheck, no secrets baked in', () => {
    const df = read('deploy/docker/Dockerfile');
    const lastUser = [...df.matchAll(/^USER (.+)$/gm)].at(-1)?.[1];
    expect(lastUser).toBe('10001:10001');
    expect(df).toMatch(/PASABOT_RUNNER=container/);
    expect(df).toMatch(/PASABOT_HOME=\/data/);
    expect(df).toMatch(/HEALTHCHECK .*\n.*\/api\/v1\/health/);
    expect(df).not.toMatch(/PASSPHRASE|PASSWORD|TOKEN|SECRET/i);
    expect(read('deploy/docker/Dockerfile.dockerignore')).toMatch(/vault\.key/);
  });

  it('docker build context: an allowlist, so the dev data home, .qa and other local folders never reach the image', () => {
    const out = dockerignore(read('deploy/docker/Dockerfile.dockerignore'));
    // the Dockerfile copies the whole context into the runtime image, so anything let in here ships
    expect(read('deploy/docker/Dockerfile')).toMatch(/^COPY \. \.$/m);
    for (const p of [
      '.pasabot/pasabot.db', // `pnpm dev` data home: chats, users, audit, the encrypted vault
      '.pasabot/vault.key',
      '.pasabot/modules/link/tailcat/server.private.json', // the link's private key
      '.pasabot/modules/link/tailcat/server.addr',
      '.pasabot/blobs/ab/abcdef',
      'apps/web/.pasabot/pasabot.db',
      'modules/link/tailcat/server.private.json',
      '.qa/c4-results.json', // screenshots, diagnostic zips and logs with the owner's paths
      '.qa/shots/home.png',
      '.design/mock.html',
      '.impeccable/notes.md',
      '.claude/worktrees/wf_1/package.json',
      '.git/config',
      '.npmrc',
      'apps/web/.npmrc',
      'apps/desktop/out/PasaBot-darwin-arm64/PasaBot.app/Contents/Info.plist',
      'node_modules/.pnpm/x/index.js',
      'apps/server/node_modules/x/index.js',
      'apps/server/dist/host/main.js',
      'apps/web/test-results/run.json',
      '.env',
      'apps/server/.env.local',
      'vault.key',
      'server.log',
      'some-new-local-folder/notes.txt', // a folder nobody listed is still left out
      'scratch.txt',
    ])
      expect(out(p), p).toBe(true);
    const workspaceDirs = ['apps', 'packages', 'providers', 'channels', 'modules', 'plugins'];
    expect(read('pnpm-workspace.yaml')).toContain(workspaceDirs.map((d) => `  - ${d}/*`).join('\n'));
    const needed = [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'tsconfig.json',
      'LICENSE',
      'NOTICE',
      'apps/server/src/host/main.ts',
      'apps/cli/src/main.ts',
      'deploy/systemd/pasabot-system.service',
      'deploy/launchd/local.pasabot.server.plist',
      'deploy/release-keys/README.md',
      'catalog/connectors/filesystem/1.0.0.json',
    ];
    // every workspace package the frozen install and the build need
    for (const d of workspaceDirs)
      for (const pkg of readdirSync(join(repo, d)))
        if (existsSync(join(repo, d, pkg, 'package.json'))) needed.push(`${d}/${pkg}/package.json`);
    expect(needed.length).toBeGreaterThan(20);
    for (const p of needed) expect(out(p), p).toBe(false);
  });

  it('compose: loopback publish, read-only root, all caps dropped, seccomp + AppArmor + no-new-privileges', () => {
    const c = read('deploy/docker/compose.yaml');
    const ports = [...c.matchAll(/^\s+- ['"](\$\{PASABOT_PUBLISH_HOST:-([^}]+)\}):/gm)];
    expect(ports).toHaveLength(2);
    for (const p of ports) expect(p[2]).toBe('127.0.0.1');
    expect(c).toMatch(/read_only: true/);
    expect(c).toMatch(/cap_drop:\n\s+- ALL/);
    expect(c).toMatch(/no-new-privileges:true/);
    expect(c).toMatch(/seccomp=\.\/seccomp\.json/);
    expect(c).toMatch(/apparmor=\$\{PASABOT_APPARMOR:-docker-default\}/);
    expect(c).toMatch(/healthcheck:/);
  });

  it('seccomp profile refuses mounts, namespaces, module loading, tracing, keyrings, io_uring and bpf', () => {
    const p = JSON.parse(read('deploy/docker/seccomp.json'));
    const denied = new Set<string>(
      p.syscalls.filter((s: any) => s.action === 'SCMP_ACT_ERRNO' && !s.args).flatMap((s: any) => s.names),
    );
    for (const s of [
      'mount',
      'umount2',
      'unshare',
      'setns',
      'ptrace',
      'init_module',
      'finit_module',
      'kexec_load',
      'bpf',
      'keyctl',
      'add_key',
      'io_uring_setup',
      'userfaultfd',
      'perf_event_open',
      'clone3',
      'open_by_handle_at',
      'pivot_root',
    ])
      expect(denied.has(s), s).toBe(true);
    const cloneRules = p.syscalls.filter((s: any) => s.names.includes('clone') && s.args);
    // CLONE_NEWUSER and CLONE_NEWNS among the refused clone flags
    const masks = cloneRules.map((r: any) => r.args[0].value);
    expect(masks).toContain(0x10000000);
    expect(masks).toContain(0x20000);
    // never refuses what Node needs to run
    for (const s of ['read', 'write', 'openat', 'mmap', 'epoll_wait', 'clone', 'execve', 'socket', 'connect'])
      expect(denied.has(s), s).toBe(false);
  });

  it('AppArmor profile denies mount, ptrace and writes to /proc/sys and /sys', () => {
    const a = read('deploy/docker/apparmor/pasabot');
    for (const rule of ['deny mount,', 'deny ptrace,', 'deny /proc/sys/** w,', 'deny /sys/** w,'])
      expect(a).toContain(rule);
    expect(a).toMatch(/^profile pasabot /m);
  });

  it('release signing script: keygen + sign produce a key the verifier accepts', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pasabot-sign-'));
    try {
      const script = join(repo, 'deploy', 'release', 'sign.mjs');
      expect(spawnSync(process.execPath, [script, 'keygen', d]).status).toBe(0);
      const tb = join(d, 't.tar.gz');
      writeFileSync(tb, 'payload');
      expect(spawnSync(process.execPath, [script, 'sign', join(d, 'release.key'), tb]).status).toBe(0);
      const { createPublicKey } = await import('node:crypto');
      const { verifyRelease } = await import('./release.js');
      const key = createPublicKey(readFileSync(join(d, 'release.pub')));
      expect(() =>
        verifyRelease(Buffer.from('payload'), readFileSync(`${tb}.sig`, 'utf8'), [key]),
      ).not.toThrow();
      expect(() => verifyRelease(Buffer.from('payloaD'), readFileSync(`${tb}.sig`, 'utf8'), [key])).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('`pasabot doctor` as a real CLI run exits 1 for 0.0.0.0 without TLS and Host allowlist', () => {
    const d = mkdtempSync(join(tmpdir(), 'pasabot-doc-cli-'));
    try {
      const r = spawnSync(
        process.execPath,
        ['--conditions=source', '--import', 'tsx', join(repo, 'apps', 'cli', 'src', 'main.ts'), 'doctor'],
        {
          cwd: repo,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            HOME: d,
            PASABOT_HOME: join(d, 'home'),
            PASABOT_HOST: '0.0.0.0',
            PASABOT_PORT: '1',
            PASABOT_RUNNER: 'host-unsandboxed',
          },
        },
      );
      expect(r.stdout).toMatch(/\[FAIL\] bind: listens on 0\.0\.0\.0/);
      expect(r.stdout).toMatch(/\[FAIL\] host-allowlist: missing Host allowlist/);
      expect(r.status).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('ops verbs', () => {
  it('are discovered by the CLI loader', async () => {
    const { loadCommands } = await import('../../main.js');
    const names = [...(await loadCommands(fileURLToPath(new URL('..', import.meta.url)))).keys()];
    for (const v of ['start', 'stop', 'restart', 'service', 'update', 'uninstall', 'logs', 'doctor'])
      expect(names).toContain(v);
  });
});
