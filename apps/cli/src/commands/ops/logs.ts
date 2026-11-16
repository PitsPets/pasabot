/** `pasabot logs [-n 200] [-f]`: server logs (journald for systemd, the log file for launchd and background runs). */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineCommand } from '../../command.js';
import {
  defaultCtx,
  installedManager,
  logFilePath,
  type OpsCtx,
  parseFlags,
  SYSTEMD_UNIT,
} from './shared.js';

/** The last `n` lines of the log file (reads at most the final 4 MB). */
export function tailFile(path: string, n: number): string {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return '';
  }
  const text = buf.subarray(Math.max(0, buf.length - 4 * 1024 * 1024)).toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n') + (lines.length ? '\n' : '');
}

export function showLogs(ctx: OpsCtx, n: number, follow: boolean): number {
  const m = installedManager(ctx);
  if (m === 'systemd-user' || m === 'systemd-system') {
    const args = [
      ...(m === 'systemd-user' ? ['--user'] : []),
      '-u',
      SYSTEMD_UNIT,
      '-n',
      String(n),
      '--no-pager',
    ];
    const r = spawnSync('journalctl', follow ? [...args, '-f'] : args, { env: ctx.env, stdio: 'inherit' });
    return r.status ?? 1;
  }
  const path = logFilePath(ctx);
  if (follow) return spawnSync('tail', ['-n', String(n), '-f', path], { stdio: 'inherit' }).status ?? 1;
  const out = tailFile(path, n);
  if (!out) ctx.err(`no logs yet at ${path}\n`);
  ctx.out(out);
  return 0;
}

export default defineCommand({
  name: 'logs',
  summary: 'show server logs (-n lines, -f to follow)',
  async run(args) {
    const { flags } = parseFlags(args, ['lines']);
    const n = Number(flags.lines ?? 200);
    if (!Number.isInteger(n) || n <= 0 || n > 100_000)
      throw new Error('-n must be a whole number from 1 to 100000');
    return showLogs(defaultCtx(), n, !!flags.follow);
  },
});
