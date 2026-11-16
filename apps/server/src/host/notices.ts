/**
 * Things about this computer the owner should know, found once at startup and shown as plain cards (web
 * `SystemNotices`, on the first-run screen and in Settings > Advanced > This computer) instead of only a log line:
 * no helper sandbox on Windows, a Linux sandbox that cannot start, a vault that could not open, where the vault key
 * is kept, a data folder Windows could not lock, sign-in links that need Developer Mode. Owner only. Each notice is an
 * id (the web app has the words, in every language); nothing secret or path-like is sent.
 *
 * Also the Windows "Check this computer" button: it starts the installed `selftest.ps1` in its own window.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AuthResolver } from '../core/services.js';
import { windowsPowerShell } from '../vault/os-key.js';

export type NoticeId =
  /** Windows: helpers run with no OS sandbox; new helpers start on "asks before anything outside its folder" */
  | 'windows-no-sandbox'
  /** Linux desktop: bubblewrap is not installed, so no helper can run */
  | 'linux-sandbox-missing'
  /** Linux desktop: the kernel blocks user namespaces for bubblewrap (Ubuntu 23.10+), so no helper can run */
  | 'linux-sandbox-userns'
  /** Linux desktop: the sandbox cannot start for another reason */
  | 'linux-sandbox-other'
  /** the vault could not open: no keys or tokens can be saved this run */
  | 'vault-unavailable'
  /** Linux with no desktop keyring: the vault key is a file only this user can read */
  | 'vault-key-file'
  /** Windows: the data folder could not be locked to this user */
  | 'data-folder-open'
  /** Windows without Developer Mode: Codex and OpenCode cannot share their sign-in with clean helpers */
  | 'signin-links';

export interface SystemNotice {
  id: NoticeId;
}

export interface NoticeDeps {
  resolveAuth: AuthResolver;
  notices: () => SystemNotice[];
  platform: NodeJS.Platform;
  /** the server's install root (`<app>\pasabot` in the Windows package): selftest.ps1 sits beside it */
  root: string | null;
  /** starts the check (tests pass a fake) */
  startCheck?: (script: string) => void;
}

/** where the Windows package keeps its self-test: `<app>\selftest.ps1`, next to the `pasabot` folder */
export const selftestPath = (root: string | null) => (root ? join(dirname(root), 'selftest.ps1') : null);

const startCheckWindow = (script: string) => {
  // its own console window (detached on Windows), so the person sees the PASS/FAIL table; an argument array, no shell
  const c = spawn(
    windowsPowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Pause'],
    { detached: true, stdio: 'ignore', windowsHide: false },
  );
  c.on('error', () => {});
  c.unref();
};

export function registerNoticeRoutes(app: FastifyInstance, d: NoticeDeps): void {
  const owner = (req: { headers: Record<string, unknown>; ip: string }) => {
    const p = d.resolveAuth({ headers: req.headers as never, ip: req.ip });
    if (p?.kind !== 'session') return 401;
    return p.userKind === 'owner' ? 0 : 403;
  };
  app.get('/api/v1/system/notices', async (req, reply) => {
    const code = owner(req);
    if (code) return reply.code(code).send({ error: code === 401 ? 'unauthorized' : 'owner_only' });
    const script = selftestPath(d.root);
    return {
      notices: d.notices(),
      platform:
        d.platform === 'win32' || d.platform === 'darwin' || d.platform === 'linux' ? d.platform : 'other',
      canCheck: d.platform === 'win32' && !!script && existsSync(script),
    };
  });
  app.post('/api/v1/system/check', async (req, reply) => {
    const code = owner(req);
    if (code) return reply.code(code).send({ error: code === 401 ? 'unauthorized' : 'owner_only' });
    const script = selftestPath(d.root);
    if (d.platform !== 'win32' || !script || !existsSync(script))
      return reply.code(409).send({ error: 'not_available' });
    (d.startCheck ?? startCheckWindow)(script);
    return { started: true };
  });
}
