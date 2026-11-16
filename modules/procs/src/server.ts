/**
 * Background processes (W8): a registry of processes that PasaBot tools started, with list + stop for the owner
 * and for the agent that owns them. Modules report processes with the `procs.started` / `procs.exited` events
 * (modules never import each other); this module only ever signals a pid it recorded, only while that record is
 * open, and only while the process's start time still matches the one read when it was recorded (a reused pid is
 * someone else's). Records left open by a previous server instance are closed at boot. Process trees started with
 * `detached: true` are stopped as a group.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  type ExecFileLike,
  HttpError,
  killTree,
  type ModuleHost,
  type PasaBotModule,
  ulid,
  windowsPowerShellPath,
} from '@pasabot/core';
import { z } from 'zod';

export interface ProcStarted {
  agentId: string;
  runId?: string | null;
  pid: number;
  cmd: string;
  /** the reporter's own id for the process, echoed back in `procs.exited` */
  ref?: string;
  /** reporting module id */
  reporter?: string;
}
export interface ProcDTO {
  id: string;
  agentId: string;
  runId: string | null;
  pid: number;
  cmd: string;
  reporter: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  stoppedBy: string | null;
}

declare module '@pasabot/protocol' {
  interface EventMap {
    'procs.started': ProcStarted;
    'procs.exited': { pid: number; agentId: string; exitCode: number | null };
    'procs.changed': ProcDTO;
  }
}

interface ProcRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  pid: number;
  cmd: string;
  reporter: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  stopped_by: string | null;
  ident: string | null;
}
const toDTO = (r: ProcRow): ProcDTO => ({
  id: r.id,
  agentId: r.agent_id,
  runId: r.run_id,
  pid: r.pid,
  cmd: r.cmd,
  reporter: r.reporter,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  exitCode: r.exit_code,
  stoppedBy: r.stopped_by,
});

const here = dirname(fileURLToPath(import.meta.url));

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Runs a program without a shell: exit status (null when it could not start) and stdout. */
export type SyncRun = (cmd: string, args: string[]) => { status: number | null; stdout: string };
const runSync: SyncRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** The PowerShell that prints a process's start time (UTC ticks), or nothing when there is no such process. */
export const windowsStartTimeScript = (pid: number) =>
  `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) }`;

/**
 * A process identity that a reused pid cannot share: its start time (`/proc/<pid>/stat` field 22 on Linux, the
 * process's StartTime through Windows PowerShell on Windows, which has no `ps`, `ps -o lstart=` elsewhere). null when
 * the pid is gone or the start time cannot be read (then the process is never signalled).
 */
export function procIdentity(
  pid: number,
  o: { platform?: NodeJS.Platform; run?: SyncRun } = {},
): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const platform = o.platform ?? process.platform;
  const run = o.run ?? runSync;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19]; // field 22 (starttime); fields here start at field 3
      return start ? `linux:${start}` : null;
    }
    if (platform === 'win32') {
      const r = run(windowsPowerShellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        windowsStartTimeScript(pid),
      ]);
      const ticks = r.status === 0 ? r.stdout.trim() : '';
      return /^[0-9]{6,}$/.test(ticks) ? `win:${ticks}` : null;
    }
    const r = run('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

export interface ProcsOptions {
  /** grace before SIGKILL after SIGTERM (default 3 s) */
  killAfterMs?: number;
  /** liveness sweep interval (default 30 s; 0 = off) */
  sweepMs?: number;
  /** tests: the platform the identity read and the kill act for, and their program runners */
  platform?: NodeJS.Platform;
  run?: SyncRun;
  execFile?: ExecFileLike;
}

export class ProcRegistry {
  constructor(
    private readonly app: ModuleHost,
    private readonly o: ProcsOptions = {},
  ) {}

  row(id: string): ProcRow | null {
    return (this.app.raw.prepare('SELECT * FROM procs_proc WHERE id = ?').get(id) as ProcRow) ?? null;
  }
  list(o: { agentId?: string; includeEnded?: boolean } = {}): ProcDTO[] {
    return (
      this.app.raw
        .prepare(
          `SELECT * FROM procs_proc WHERE (? IS NULL OR agent_id = ?) AND (? OR ended_at IS NULL)
           ORDER BY started_at DESC LIMIT 200`,
        )
        .all(o.agentId ?? null, o.agentId ?? null, o.includeEnded ? 1 : 0) as ProcRow[]
    ).map(toDTO);
  }
  record(p: ProcStarted): ProcDTO {
    if (!Number.isInteger(p.pid) || p.pid <= 1) throw new Error('bad pid');
    const id = ulid();
    this.app.raw
      .prepare(
        'INSERT INTO procs_proc (id, agent_id, run_id, pid, cmd, reporter, started_at, ident) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        p.agentId,
        p.runId ?? null,
        p.pid,
        p.cmd.slice(0, 500),
        p.reporter ?? '',
        Date.now(),
        this.identity(p.pid),
      );
    return this.changed(id);
  }
  private identity(pid: number): string | null {
    return procIdentity(pid, { platform: this.o.platform, run: this.o.run });
  }
  /** The recorded process is still the one running under that pid (never true when its identity was unreadable). */
  private same(r: ProcRow): boolean {
    return r.ident !== null && alive(r.pid) && this.identity(r.pid) === r.ident;
  }
  ended(id: string, exitCode: number | null, by?: string) {
    this.app.raw
      .prepare(
        'UPDATE procs_proc SET ended_at = ?, exit_code = ?, stopped_by = coalesce(?, stopped_by) WHERE id = ? AND ended_at IS NULL',
      )
      .run(Date.now(), exitCode, by ?? null, id);
    return this.changed(id);
  }
  private changed(id: string): ProcDTO {
    const d = toDTO(this.row(id)!);
    this.app.bus.publish('module:procs', 'procs.changed', d);
    return d;
  }

  /**
   * SIGTERM (group first), then SIGKILL after the grace; resolves once the pid is gone or the grace ran out. A pid
   * whose identity no longer matches the record (gone, or reused by another process) is never signalled: the
   * record is just closed.
   */
  async stop(id: string, by: string): Promise<ProcDTO> {
    const r = this.row(id);
    if (!r) throw new HttpError(404, 'process not found', 'not_found');
    if (r.ended_at !== null) return toDTO(r);
    if (!this.same(r)) return this.ended(id, null, by);
    // the whole group when the reporter started it detached, else the pid (Windows: the whole tree, taskkill /T)
    const signal = (sig: NodeJS.Signals) =>
      killTree(r.pid, sig, { platform: this.o.platform, execFile: this.o.execFile });
    this.app.raw.prepare('UPDATE procs_proc SET stopped_by = ? WHERE id = ?').run(by, id);
    signal('SIGTERM');
    const grace = this.o.killAfterMs ?? 3000;
    const t0 = Date.now();
    while (alive(r.pid) && Date.now() - t0 < grace) await new Promise((res) => setTimeout(res, 50));
    if (this.same(r)) signal('SIGKILL');
    const t1 = Date.now();
    while (alive(r.pid) && Date.now() - t1 < 1000) await new Promise((res) => setTimeout(res, 25));
    return this.ended(id, null, by);
  }

  /** Close records whose process is gone or whose pid now belongs to another process (no exit was reported). */
  sweep() {
    if (!this.app.raw.open) return;
    for (const r of this.app.raw
      .prepare('SELECT * FROM procs_proc WHERE ended_at IS NULL')
      .all() as ProcRow[])
      if (!this.same(r)) this.ended(r.id, null);
  }
  /** At boot: every record still open was left by the previous server instance; close it, never trust the pid. */
  closeStale() {
    for (const r of this.app.raw.prepare('SELECT id FROM procs_proc WHERE ended_at IS NULL').all() as {
      id: string;
    }[])
      this.ended(r.id, null);
  }
}

function session(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p;
}

export function createProcsModule(o: ProcsOptions = {}): PasaBotModule & { registry(): ProcRegistry } {
  let reg: ProcRegistry | null = null;
  return {
    id: 'procs',
    migrations: join(here, '..', 'migrations'),
    registry() {
      if (!reg) throw new Error('procs module not registered yet');
      return reg;
    },
    register(app) {
      const r = new ProcRegistry(app, o);
      reg = r;
      r.closeStale();
      app.bus.subscribe((ev) => {
        if (ev.live) return;
        try {
          if (ev.type === 'procs.started' && ev.topic.startsWith('module:')) {
            const d = ev.data as ProcStarted;
            r.record({ ...d, reporter: d.reporter ?? ev.topic.slice('module:'.length) });
          } else if (ev.type === 'procs.exited') {
            const d = ev.data as { pid: number; agentId: string; exitCode: number | null };
            const row = app.raw
              .prepare(
                'SELECT id FROM procs_proc WHERE pid = ? AND agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
              )
              .get(d.pid, d.agentId) as { id: string } | undefined;
            if (row) r.ended(row.id, d.exitCode);
          }
        } catch (e) {
          app.log.warn('procs bookkeeping failed', { error: String(e) });
        }
      });
      const ms = o.sweepMs ?? 30_000;
      if (ms > 0) {
        const t = setInterval(() => (app.raw.open ? r.sweep() : clearInterval(t)), ms);
        t.unref?.();
      }

      app.http.route({
        method: 'GET',
        url: '/procs',
        auth: 'session',
        handler: (ctx) => {
          session(ctx);
          const agentId = typeof ctx.query.agentId === 'string' ? ctx.query.agentId : undefined;
          return { procs: r.list({ agentId, includeEnded: ctx.query.all === '1' }) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/procs/:id/stop',
        auth: 'session',
        handler: async (ctx) => {
          const p = session(ctx);
          return { proc: await r.stop(ctx.params.id!, `user:${p.userId}`) };
        },
      });

      app.tools.add({
        name: 'procs_list',
        title: 'List my background processes',
        description: 'Lists the background processes this agent started through PasaBot tools.',
        input: z.object({ includeEnded: z.boolean().default(false) }),
        tier: 0,
        handler: async (i, ctx) => ({
          procs: r.list({ agentId: ctx.agent.id, includeEnded: i.includeEnded }),
        }),
      });
      app.tools.add({
        name: 'procs_stop',
        title: 'Stop one of my background processes',
        description: 'Stops a background process this agent started.',
        input: z.object({ id: z.string() }),
        tier: 1,
        handler: async (i, ctx) => {
          const row = r.row(i.id);
          if (!row || row.agent_id !== ctx.agent.id) throw new Error('process not found');
          return { proc: await r.stop(row.id, `agent:${ctx.agent.id}`) };
        },
      });
    },
  };
}

export default defineModule(createProcsModule());
