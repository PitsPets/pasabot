/**
 * The Docker proof (deploy/computer): a real Xvfb + xdotool + ImageMagick, a real X test app (one big Tk button
 * that prints `pressed` and exits), the agent's screenshot and click through `/mcp` with tier-3 approvals, and the
 * owner's viewer frame from REST. Runs only with `PASABOT_LIVE_XVFB=1` on a Linux box that has the helpers (the
 * computer image); skipped everywhere else.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestServer, seedAgent, seedRunToken, seedUser } from '@pasabot/testkit';
import { describe, expect, it } from 'vitest';
import { runCommand } from './drivers/types.js';
import { missingXvfbBins, XvfbDriver } from './drivers/xvfb.js';
import { pngSize } from './png.js';
import { createComputerModule } from './server.js';

const live =
  process.env.PASABOT_LIVE_XVFB === '1' && process.platform === 'linux' && missingXvfbBins().length === 0;
const testApp = fileURLToPath(new URL('../../../deploy/computer/test-app.py', import.meta.url));

describe.skipIf(!live)('Xvfb live (computer image)', () => {
  it('the agent screenshots, clicks the test app button, and the owner sees the frame', async () => {
    let display = '';
    let xauth = '';
    const s = await bootTestServer({
      modules: [
        createComputerModule({
          driver: 'xvfb',
          create: () => {
            const d = new XvfbDriver({ width: 800, height: 600 });
            const start = d.start.bind(d);
            d.start = async () => {
              await start();
              display = d.label();
              xauth = d.env().XAUTHORITY ?? '';
            };
            return d;
          },
        }),
      ],
    });
    const ws = mkdtempSync(join(tmpdir(), 'pasabot-xvfb-live-'));
    try {
      const owner = seedUser(s.db).token;
      const agent = seedAgent(s.db, { trust: 'trusted' });
      s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(ws, agent);
      const { token } = seedRunToken(s.db, agent);
      const call = async (name: string, args: unknown) => {
        const p = fetch(`${s.url}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }).then((r) => r.json() as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>);
        let row: { id: string; tier: number } | undefined;
        for (let i = 0; i < 200 && !row; i++) {
          row = s.db.prepare("SELECT id, tier FROM approvals WHERE state = 'pending'").get() as typeof row;
          if (!row) await new Promise((r) => setTimeout(r, 20));
        }
        expect(row?.tier).toBe(3);
        s.approvals.decide(row!.id, 'approved', 'owner');
        const j = await p;
        expect(j.result.isError).toBeFalsy();
        return JSON.parse(j.result.content[0]!.text);
      };

      const shot = await call('computer_screenshot', {});
      expect(shot).toMatchObject({ width: 800, height: 600 });
      expect(display).not.toBe(process.env.DISPLAY ?? '');

      // the test app on the agent's display only (it needs that display's cookie, like any other client)
      const app = spawn('python3', [testApp], {
        env: { PATH: process.env.PATH, DISPLAY: display, XAUTHORITY: xauth },
      });
      let out = '';
      app.stdout.on('data', (b) => {
        out += b;
      });
      const exited = new Promise<number | null>((r) => app.once('exit', (c) => r(c)));
      await new Promise((r) => setTimeout(r, 1500)); // window mapped
      await call('computer_click', { x: 200, y: 100 });
      expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])).toBe(0);
      expect(out).toContain('pressed');

      const f = await fetch(`${s.url}/api/m/computer/displays/${agent}/frame`, {
        headers: { authorization: `Bearer ${owner}` },
      });
      expect(f.status).toBe(200);
      expect(pngSize(new Uint8Array(await f.arrayBuffer()))).toEqual({ width: 800, height: 600 });
      app.kill('SIGKILL');
    } finally {
      await s.cleanup();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  it('a client without the display cookie is refused, and there is no abstract or TCP socket', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'pasabot-xvfb-auth-'));
    const d = new XvfbDriver({ width: 320, height: 200, authDir });
    await d.start();
    try {
      const env = d.env();
      const n = d.label().slice(1);
      // PasaBot's own helper (with the cookie) gets in
      await runCommand('xdotool', ['getmouselocation'], { env, timeoutMs: 10_000 });
      // an agent's shell knows the display number but not the cookie: refused
      await expect(
        runCommand('xdotool', ['getmouselocation'], {
          env: { PATH: env.PATH, DISPLAY: env.DISPLAY },
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow();
      // a wrong cookie file is refused too
      const other = new XvfbDriver({ width: 320, height: 200, authDir });
      await other.start();
      try {
        await expect(
          runCommand('xdotool', ['getmouselocation'], {
            env: { ...env, XAUTHORITY: other.env().XAUTHORITY },
            timeoutMs: 10_000,
          }),
        ).rejects.toThrow();
      } finally {
        await other.stop();
      }
      // only the path socket: no `@/tmp/.X11-unix/X<n>` abstract socket that a sandbox with its own /tmp could reach
      const unix = readFileSync('/proc/net/unix', 'utf8');
      expect(unix).not.toContain(`@/tmp/.X11-unix/X${n}`);
      const port = (6000 + Number(n)).toString(16).toUpperCase().padStart(4, '0');
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let text = '';
        try {
          text = readFileSync(f, 'utf8');
        } catch {}
        // a listening socket: local address ends in `:<port>`, state 0A
        const listening = text
          .split('\n')
          .map((l) => l.trim().split(' ').filter(Boolean))
          .filter((c) => c[1]?.endsWith(`:${port}`) && c[3] === '0A');
        expect(listening).toEqual([]);
      }
    } finally {
      await d.stop();
      rmSync(authDir, { recursive: true, force: true });
    }
  }, 60_000);
});
