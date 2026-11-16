import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindKind, doctor, doctorChecks, type Facts } from './doctor.js';
import type { OpsCtx } from './shared.js';

const facts = (f: Partial<Facts> = {}): Facts => ({
  platform: 'linux',
  nodeVersion: 'v22.12.0',
  inContainer: false,
  desktop: true,
  homeMode: 0o700,
  vaultKeyMode: null,
  envFileMode: 0o600,
  sandboxTool: true,
  ...f,
});
const levelOf = (checks: ReturnType<typeof doctorChecks>, id: string) =>
  checks.find((c) => c.id === id)?.level;

describe('doctor checks', () => {
  it('flags 0.0.0.0 without TLS', () => {
    const c = doctorChecks({ PASABOT_HOST: '0.0.0.0', PASABOT_ALLOWED_HOSTS: 'box.lan' }, facts());
    expect(levelOf(c, 'bind')).toBe('fail');
    expect(c.find((x) => x.id === 'bind')!.message).toMatch(/0\.0\.0\.0.*without TLS/);
    expect(levelOf(doctorChecks({ PASABOT_HOST: '::', PASABOT_ALLOWED_HOSTS: 'x' }, facts()), 'bind')).toBe(
      'fail',
    );
  });

  it('0.0.0.0 behind an https public URL is a warning, not a failure', () => {
    const c = doctorChecks(
      {
        PASABOT_HOST: '0.0.0.0',
        PASABOT_PUBLIC_URL: 'https://pasabot.example.ts.net',
        PASABOT_ALLOWED_HOSTS: 'pasabot.example.ts.net',
      },
      facts(),
    );
    expect(levelOf(c, 'bind')).toBe('warn');
    expect(levelOf(c, 'host-allowlist')).toBe('ok');
  });

  it('flags a missing Host allowlist when reachable beyond this machine', () => {
    const c = doctorChecks({ PASABOT_HOST: '100.64.0.7' }, facts());
    expect(levelOf(c, 'host-allowlist')).toBe('fail');
    expect(c.find((x) => x.id === 'host-allowlist')!.message).toMatch(/missing Host allowlist/);
    const pub = doctorChecks({ PASABOT_PUBLIC_URL: 'https://pasabot.example.ts.net' }, facts());
    expect(levelOf(pub, 'host-allowlist')).toBe('fail');
    const wrong = doctorChecks(
      { PASABOT_PUBLIC_URL: 'https://pasabot.example.ts.net', PASABOT_ALLOWED_HOSTS: 'other.host' },
      facts(),
    );
    expect(wrong.find((x) => x.id === 'host-allowlist')!.message).toMatch(/does not include/);
  });

  it('a default loopback install is clean', () => {
    const c = doctorChecks({}, facts());
    expect(c.filter((x) => x.level === 'fail')).toEqual([]);
    expect(levelOf(c, 'bind')).toBe('ok');
    expect(levelOf(c, 'host-allowlist')).toBe('ok');
  });

  it('in Docker judges where compose publishes the port, not the in-container 0.0.0.0', () => {
    const ok = doctorChecks(
      { PASABOT_HOST: '0.0.0.0', PASABOT_PUBLISH_HOST: '127.0.0.1', PASABOT_RUNNER: 'container' },
      facts({ inContainer: true }),
    );
    expect(levelOf(ok, 'bind')).toBe('ok');
    const open = doctorChecks(
      { PASABOT_HOST: '0.0.0.0', PASABOT_PUBLISH_HOST: '0.0.0.0' },
      facts({ inContainer: true }),
    );
    expect(levelOf(open, 'bind')).toBe('fail');
    expect(levelOf(open, 'host-allowlist')).toBe('fail');
  });

  it('flags open permissions, an old Node and a missing sandbox tool', () => {
    const c = doctorChecks(
      { PASABOT_RUNNER: 'host' },
      facts({ homeMode: 0o755, vaultKeyMode: 0o644, nodeVersion: 'v20.1.0', sandboxTool: false }),
    );
    expect(levelOf(c, 'home')).toBe('fail');
    expect(levelOf(c, 'vault-key')).toBe('fail');
    expect(levelOf(c, 'node')).toBe('fail');
    expect(levelOf(c, 'runner')).toBe('fail');
  });

  it('classifies bind addresses', () => {
    expect(bindKind('127.0.0.1')).toBe('loopback');
    expect(bindKind('127.1.2.3')).toBe('loopback');
    expect(bindKind('::1')).toBe('loopback');
    expect(bindKind('0.0.0.0')).toBe('wildcard');
    expect(bindKind('192.168.1.5')).toBe('other');
  });
});

describe('pasabot doctor (verb)', () => {
  let dir: string;
  let srv: Server;
  let port: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pasabot-doctor-'));
    srv = createServer((_q, r) => r.end(JSON.stringify({ ok: true, version: '9.9.9' })));
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    port = (srv.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise((res) => srv.close(res));
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (envFile: string) => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'pasabot.env'), envFile, { mode: 0o600 });
    const out: string[] = [];
    const ctx: OpsCtx = {
      env: { HOME: dir, PASABOT_HOME: home, PATH: process.env.PATH, PASABOT_ROOT: dir },
      platform: process.platform,
      out: (s) => out.push(s),
      err: () => {},
    };
    const code = await doctor(ctx, {});
    return { code, text: out.join('') };
  };

  it('reads the service env file and exits 1 on 0.0.0.0 without TLS or Host allowlist', async () => {
    const r = await run(`PASABOT_HOST=0.0.0.0\nPASABOT_PORT=${port}\nPASABOT_RUNNER=host-unsandboxed\n`);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/\[FAIL\] bind: listens on 0\.0\.0\.0/);
    expect(r.text).toMatch(/\[FAIL\] host-allowlist: missing Host allowlist/);
    expect(r.text).toMatch(/\[ ok \] server: answering at 127\.0\.0\.1:\d+ \(version 9\.9\.9\)/);
  });

  it('exits 0 for the loopback default', async () => {
    const r = await run(`PASABOT_HOST=127.0.0.1\nPASABOT_PORT=${port}\nPASABOT_RUNNER=host-unsandboxed\n`);
    expect(r.text).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
  });
});
