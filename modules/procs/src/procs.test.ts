/** W8 done-criterion: a background process started through a PasaBot tool is listed and stopped. */
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../packages/testkit/src/index.js';
import { alive, createProcsModule, procIdentity } from './server.js';

let s: TestServer | null = null;
afterEach(async () => {
  await s?.cleanup();
  s = null;
});

async function until<T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('procs', () => {
  it('a reported process is listed, stopped by the owner, and its record closed', async () => {
    const mod = createProcsModule({ killAfterMs: 500, sweepMs: 0 });
    s = await bootTestServer({ modules: [mod] });
    const owner = seedUser(s.db);
    const member = seedUser(s.db, 'member', 'M');
    const agent = seedAgent(s.db);
    // a tool of some module starts a process and reports it on its own topic
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid!;
    s.bus.publish('module:sometool' as never, 'procs.started', {
      agentId: agent,
      runId: null,
      pid,
      cmd: 'node -e …',
    });
    const get = (token: string, q = '') =>
      fetch(`${s!.url}/api/m/procs/procs${q}`, { headers: { authorization: `Bearer ${token}` } });
    const r = await get(owner.token);
    expect(r.status).toBe(200);
    const { procs } = (await r.json()) as { procs: { id: string; pid: number; reporter: string }[] };
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid, reporter: 'sometool' });
    expect((await get(member.token)).status).toBe(403);

    const stop = await fetch(`${s.url}/api/m/procs/procs/${procs[0]!.id}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(stop.status).toBe(200);
    const { proc } = (await stop.json()) as { proc: { endedAt: number | null; stoppedBy: string } };
    expect(proc.endedAt).not.toBeNull();
    expect(proc.stoppedBy).toBe(`user:${owner.id}`);
    await until(() => !alive(pid));
    expect(((await (await get(owner.token)).json()) as { procs: unknown[] }).procs).toHaveLength(0);
    expect(((await (await get(owner.token, '?all=1')).json()) as { procs: unknown[] }).procs).toHaveLength(1);
  });

  it('an agent sees and stops only its own processes', async () => {
    const mod = createProcsModule({ killAfterMs: 500, sweepMs: 0 });
    s = await bootTestServer({ modules: [mod] });
    const a = seedAgent(s.db);
    const b = seedAgent(s.db);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      s.bus.publish('module:sometool' as never, 'procs.started', {
        agentId: a,
        pid: child.pid!,
        cmd: 'sleeper',
      });
      const ctx = (id: string) => ({ agent: { id }, signal: new AbortController().signal }) as never;
      const mine = (await s.tools.invoke('procs_list', {}, ctx(a))) as { procs: { id: string }[] };
      expect(mine.procs).toHaveLength(1);
      expect(((await s.tools.invoke('procs_list', {}, ctx(b))) as { procs: unknown[] }).procs).toHaveLength(
        0,
      );
      await expect(s.tools.invoke('procs_stop', { id: mine.procs[0]!.id }, ctx(b))).rejects.toThrow();
      await s.tools.invoke('procs_stop', { id: mine.procs[0]!.id }, ctx(a));
      await until(() => child.exitCode !== null || child.signalCode !== null);
      // an exit reported for a pid that is not open changes nothing
      s.bus.publish('module:sometool' as never, 'procs.exited', { agentId: a, pid: 999_999, exitCode: 0 });
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a pid now owned by another process is never signalled: Stop only closes the record', async () => {
    const mod = createProcsModule({ killAfterMs: 200, sweepMs: 0 });
    s = await bootTestServer({ modules: [mod] });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const pid = child.pid!;
      expect(procIdentity(pid)).toBeTruthy();
      s.bus.publish('module:sometool' as never, 'procs.started', { agentId: agent, pid, cmd: 'sleeper' });
      const rec = mod.registry().list()[0]!;
      // the recorded process died and its pid was reused by an unrelated process (simulated: identity differs)
      s.db.prepare('UPDATE procs_proc SET ident = ? WHERE id = ?').run('ps:some other start', rec.id);
      const stop = await fetch(`${s.url}/api/m/procs/procs/${rec.id}/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(stop.status).toBe(200);
      expect(((await stop.json()) as { proc: { endedAt: number | null } }).proc.endedAt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 400));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(alive(pid)).toBe(true);
      // the sweep closes such a record too, without signalling
      s.bus.publish('module:sometool' as never, 'procs.started', { agentId: agent, pid, cmd: 'again' });
      const again = mod.registry().list()[0]!;
      s.db.prepare('UPDATE procs_proc SET ident = NULL WHERE id = ?').run(again.id);
      mod.registry().sweep();
      expect(mod.registry().list()).toHaveLength(0);
      expect(alive(pid)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('Windows (no `ps`): the start time comes from PowerShell, so Stop reaches taskkill and the sweep keeps a live process', async () => {
    // a fake Windows: PowerShell answers with the process's start ticks, taskkill really ends the process
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const runs: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      runs.push([cmd, ...args]);
      const script = args.at(-1) ?? '';
      return { status: 0, stdout: script.includes(`-Id ${pid} `) && alive(pid) ? '638650000000000000' : '' };
    };
    const kills: string[][] = [];
    const execFile = (cmd: string, args: string[]) => {
      kills.push([cmd, ...args]);
      child.kill('SIGKILL');
    };
    try {
      expect(procIdentity(pid, { platform: 'win32', run })).toBe('win:638650000000000000');
      expect(runs[0]?.[0]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      expect(procIdentity(pid, { platform: 'win32', run: () => ({ status: 0, stdout: '' }) })).toBeNull();
      const mod = createProcsModule({ killAfterMs: 300, sweepMs: 0, platform: 'win32', run, execFile });
      s = await bootTestServer({ modules: [mod] });
      const agent = seedAgent(s.db);
      s.bus.publish('module:sometool' as never, 'procs.started', { agentId: agent, pid, cmd: 'miner' });
      const rec = mod.registry().list()[0]!;
      // the 30 s sweep must not close the record of a process that is still running
      mod.registry().sweep();
      expect(mod.registry().list()).toHaveLength(1);
      const stopped = await mod.registry().stop(rec.id, 'user:owner');
      expect(kills[0]).toEqual(['taskkill', '/PID', String(pid), '/T', '/F']);
      expect(stopped.endedAt).not.toBeNull();
      await until(() => child.exitCode !== null || child.signalCode !== null);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('records left open by a previous server instance are closed at boot, never signalled', async () => {
    const home = tempHome();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const a = await bootTestServer({ modules: [createProcsModule({ sweepMs: 0 })], home: home.dir });
      const agent = seedAgent(a.db);
      a.bus.publish('module:sometool' as never, 'procs.started', {
        agentId: agent,
        pid: child.pid!,
        cmd: 'x',
      });
      await until(
        () => (a.db.prepare('SELECT count(*) AS n FROM procs_proc').get() as { n: number }).n === 1,
      );
      await a.close();
      const mod = createProcsModule({ sweepMs: 0 });
      s = await bootTestServer({ modules: [mod], home: home.dir });
      expect(mod.registry().list()).toHaveLength(0);
      expect(mod.registry().list({ includeEnded: true })).toHaveLength(1);
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await s?.cleanup();
      s = null;
      home.cleanup();
    }
  });
});
