/**
 * `pasabot doctor [--json]`: check the settings the server runs with (shell PASABOT_* overlaid by the service's
 * `pasabot.env`) for unsafe exposure and broken setup. Exit 1 when any check fails.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../../command.js';
import { serviceState } from './lifecycle.js';
import {
  defaultCtx,
  effectiveSettings,
  envFilePath,
  modeOf,
  type OpsCtx,
  parseFlags,
  pasabotHomeOf,
  runTool,
} from './shared.js';

export type Level = 'ok' | 'warn' | 'fail';
export interface Check {
  id: string;
  level: Level;
  message: string;
}

export interface Facts {
  platform: NodeJS.Platform;
  nodeVersion: string;
  inContainer: boolean;
  desktop: boolean;
  homeMode: number | null;
  vaultKeyMode: number | null;
  envFileMode: number | null;
  sandboxTool: boolean;
  service?: { manager: string; running: boolean; detail: string };
  health?: { ok: boolean; detail: string };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*', '']);

export function bindKind(host: string): 'loopback' | 'wildcard' | 'other' {
  const h = host.trim().toLowerCase();
  if (WILDCARD.has(h)) return 'wildcard';
  if (LOOPBACK.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return 'loopback';
  return 'other';
}

function runnerMode(s: Record<string, string>, f: Facts) {
  if (s.PASABOT_RUNNER) return s.PASABOT_RUNNER;
  if (f.inContainer) return 'container';
  if (f.platform === 'linux') return f.desktop ? 'host' : 'user';
  // the server's own default there (runner/sandbox.ts defaultRunnerMode): no sandbox, said plainly
  if (f.platform === 'win32') return 'host-unsandboxed';
  return 'host';
}

/** Pure: settings + observed facts → checks. */
export function doctorChecks(s: Record<string, string>, f: Facts): Check[] {
  const out: Check[] = [];
  const add = (id: string, level: Level, message: string) => out.push({ id, level, message });

  const major = Number(f.nodeVersion.replace(/^v/, '').split('.')[0]);
  add(
    'node',
    major >= 22 ? 'ok' : 'fail',
    `Node ${f.nodeVersion}${major >= 22 ? '' : ' (PasaBot needs 22 or newer)'}`,
  );

  // In Docker the server must listen on 0.0.0.0 inside the container; what matters is where compose publishes it.
  const host = f.inContainer ? (s.PASABOT_PUBLISH_HOST ?? '0.0.0.0') : (s.PASABOT_HOST ?? '127.0.0.1');
  const where = f.inContainer ? 'published on' : 'listens on';
  const kind = bindKind(host);
  let publicUrl: URL | null = null;
  if (s.PASABOT_PUBLIC_URL) {
    try {
      publicUrl = new URL(s.PASABOT_PUBLIC_URL);
    } catch {
      add('public-url', 'fail', `PASABOT_PUBLIC_URL is not a valid URL: ${s.PASABOT_PUBLIC_URL}`);
    }
  }
  const tls = publicUrl?.protocol === 'https:';
  if (kind === 'loopback')
    add('bind', 'ok', `${where} ${host} only (reach it remotely through Tailscale serve or a tunnel)`);
  else if (kind === 'wildcard' && !tls)
    add(
      'bind',
      'fail',
      `${where} ${host || '0.0.0.0'} (every network interface) without TLS: passwords and sessions cross the network in plain HTTP. ` +
        'Bind 127.0.0.1 and put Tailscale serve or a TLS tunnel in front (deploy/REMOTE-ACCESS.md).',
    );
  else if (kind === 'wildcard')
    add(
      'bind',
      'warn',
      `${where} every interface; TLS is only at ${publicUrl!.host}, the LAN still sees plain HTTP`,
    );
  else if (!tls) add('bind', 'warn', `${where} ${host} in plain HTTP; prefer 127.0.0.1 behind a TLS front`);
  else add('bind', 'ok', `${where} ${host}, TLS at ${publicUrl!.host}`);

  if (publicUrl && publicUrl.protocol === 'http:' && bindKind(publicUrl.hostname) !== 'loopback')
    add('public-url', 'warn', `PASABOT_PUBLIC_URL uses plain http (${publicUrl.origin}); use https`);

  const allowed = (s.PASABOT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const exposed = kind !== 'loopback' || !!publicUrl;
  if (exposed && !allowed.length)
    add(
      'host-allowlist',
      'fail',
      'missing Host allowlist: the server is reachable beyond this machine but PASABOT_ALLOWED_HOSTS is empty ' +
        '(set it to the names you open PasaBot with, e.g. pasabot.tailnet-name.ts.net)',
    );
  else if (
    publicUrl &&
    bindKind(publicUrl.hostname) !== 'loopback' &&
    !allowed.includes(publicUrl.hostname.toLowerCase())
  )
    add(
      'host-allowlist',
      'fail',
      `PASABOT_ALLOWED_HOSTS does not include the public URL host ${publicUrl.hostname}`,
    );
  else
    add(
      'host-allowlist',
      'ok',
      allowed.length ? `allowed hosts: ${allowed.join(', ')}` : 'loopback names only',
    );

  if (f.homeMode === null) add('home', 'warn', 'data folder does not exist yet (created on first start)');
  else if (f.platform === 'win32')
    // Windows has no chmod: the server gives the folder an access list for this user only at every start, and
    // selftest.ps1 checks it; the mode bits Node reports there mean nothing
    add('home', 'ok', 'data folder: locked to this Windows user at every start (selftest.ps1 checks it)');
  else if (f.homeMode & 0o077)
    add(
      'home',
      'fail',
      `data folder is open to other users (mode ${f.homeMode.toString(8)}); run chmod 700 on it`,
    );
  else add('home', 'ok', 'data folder is private (700)');

  const mode = runnerMode(s, f);
  if (f.vaultKeyMode !== null) {
    if (f.vaultKeyMode & 0o077 && f.platform !== 'win32')
      add(
        'vault-key',
        'fail',
        `vault.key is readable by others (mode ${f.vaultKeyMode.toString(8)}); chmod 600`,
      );
    else if (mode === 'host' && f.platform === 'darwin')
      add(
        'vault-key',
        'warn',
        'vault.key file found in macOS host mode, where the key belongs in the keychain',
      );
    else add('vault-key', 'ok', 'vault.key is private (600)');
  }
  if (f.envFileMode !== null && f.envFileMode & 0o077)
    add(
      'env-file',
      'warn',
      `pasabot.env is readable by others (mode ${f.envFileMode.toString(8)}); chmod 600`,
    );

  if (mode === 'host' && f.platform === 'win32')
    add(
      'runner',
      'fail',
      'runner host: PasaBot has no helper sandbox on Windows yet, so agents cannot run; unset PASABOT_RUNNER ' +
        '(helpers then run without a sandbox and ask before anything outside their folder) or use Docker/WSL',
    );
  else if (mode === 'host-unsandboxed' && f.platform === 'win32')
    add(
      'runner',
      'warn',
      'Windows: no OS sandbox for agents; they can read everything you can (new helpers ask first). Hardened: Docker or WSL',
    );
  else if (mode === 'host')
    add(
      'runner',
      f.sandboxTool ? 'ok' : 'fail',
      f.sandboxTool
        ? `runner host with the OS sandbox (${f.platform === 'darwin' ? 'sandbox-exec' : 'bubblewrap'})`
        : `runner host needs ${f.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bubblewrap (bwrap)'}; agents cannot run`,
    );
  else if (mode === 'host-unsandboxed')
    add('runner', 'warn', 'runner host-unsandboxed: agents can read everything you can');
  else if (mode === 'user' || mode === 'container')
    add(
      'runner',
      'warn',
      `runner ${mode}: its agent launcher is not in this build yet, so agent runs will be refused`,
    );
  else add('runner', 'fail', `unknown PASABOT_RUNNER "${mode}"`);

  if (f.service)
    add(
      'service',
      f.service.running || f.service.manager === 'process' ? 'ok' : 'warn',
      `${f.service.manager}: ${f.service.running ? 'running' : 'not running'} (${f.service.detail})`,
    );
  if (f.health) add('server', f.health.ok ? 'ok' : 'warn', f.health.detail);
  return out;
}

async function health(port: string): Promise<{ ok: boolean; detail: string }> {
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json().catch(() => ({}))) as { version?: string };
    return r.ok
      ? { ok: true, detail: `answering at 127.0.0.1:${port} (version ${j.version ?? '?'})` }
      : { ok: false, detail: `HTTP ${r.status} from ${url}` };
  } catch {
    return { ok: false, detail: `not answering at 127.0.0.1:${port}` };
  }
}

export async function gatherFacts(
  ctx: OpsCtx,
  s: Record<string, string>,
  o: { live?: boolean } = {},
): Promise<Facts> {
  const home = pasabotHomeOf(ctx);
  const sandboxTool =
    ctx.platform === 'darwin'
      ? existsSync('/usr/bin/sandbox-exec')
      : ctx.platform === 'linux'
        ? runTool(ctx, 'bwrap', ['--version']).status === 0
        : false;
  return {
    platform: ctx.platform,
    nodeVersion: process.version,
    inContainer: ctx.env.PASABOT_IN_CONTAINER === '1' || existsSync('/.dockerenv'),
    desktop: !!(ctx.env.DISPLAY || ctx.env.WAYLAND_DISPLAY || ctx.env.XDG_CURRENT_DESKTOP),
    homeMode: modeOf(home),
    vaultKeyMode: modeOf(join(home, 'vault.key')),
    envFileMode: modeOf(envFilePath(ctx)),
    sandboxTool,
    ...(o.live === false
      ? {}
      : { service: serviceState(ctx), health: await health(s.PASABOT_PORT ?? '7777') }),
  };
}

const TAG: Record<Level, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' };

export async function doctor(ctx: OpsCtx, o: { json?: boolean; live?: boolean } = {}): Promise<number> {
  const s = effectiveSettings(ctx);
  const checks = doctorChecks(s, await gatherFacts(ctx, s, o));
  if (o.json) ctx.out(`${JSON.stringify({ checks }, null, 2)}\n`);
  else for (const c of checks) ctx.out(`${TAG[c.level]} ${c.id}: ${c.message}\n`);
  const failed = checks.filter((c) => c.level === 'fail').length;
  if (!o.json) ctx.out(failed ? `\n${failed} problem(s) found.\n` : '\nNo problems found.\n');
  return failed ? 1 : 0;
}

export default defineCommand({
  name: 'doctor',
  summary: 'check this install for unsafe exposure and setup problems (--json)',
  async run(args) {
    const { flags } = parseFlags(args);
    return doctor(defaultCtx(), { json: !!flags.json });
  },
});
