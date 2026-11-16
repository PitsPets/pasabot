/**
 * One display per agent, started on the agent's first approved action and stopped by the owner, after an idle
 * period, or when the server process exits. The viewer reads frames through `frame()`, which reuses a frame for
 * a short moment so several open viewers never make the display busier than one.
 */
import type { Png } from '@pasabot/core';
import type { ManagedDriver } from './drivers/types.js';
import type { Authorize } from './helper/grants.js';

export interface DisplaySession {
  agentId: string;
  driver: ManagedDriver;
  startedAt: number;
  lastUsedAt: number;
  /** when the last action ran (0 = none yet): a picture taken before it is no longer the screen */
  actedAt: number;
  frame: { at: number; png: Png } | null;
}

export interface ManagerOptions {
  create(agentId: string): ManagedDriver;
  /** stop a display nobody used for this long (default 30 min; 0 = never) */
  idleMs?: number;
  /** a frame younger than this is reused (default 250 ms) */
  frameTtlMs?: number;
  onStart?(s: DisplaySession): void;
  onStop?(s: DisplaySession, reason: string): void;
  now?(): number;
}

export class DisplayManager {
  private readonly sessions = new Map<string, DisplaySession>();
  private readonly starting = new Map<string, Promise<DisplaySession>>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private readonly o: ManagerOptions) {
    const idle = o.idleMs ?? 30 * 60_000;
    if (idle > 0) {
      this.sweep = setInterval(() => void this.stopIdle(idle), Math.min(idle, 60_000));
      this.sweep.unref();
    }
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }

  list(): DisplaySession[] {
    return [...this.sessions.values()].filter((s) => s.driver.alive());
  }
  get(agentId: string): DisplaySession | null {
    const s = this.sessions.get(agentId);
    if (s && !s.driver.alive()) {
      this.sessions.delete(agentId);
      this.o.onStop?.(s, 'exited');
      return null;
    }
    return s ?? null;
  }

  /** the agent's display, started when it has none */
  async ensure(agentId: string, auth?: Authorize): Promise<DisplaySession> {
    const have = this.get(agentId);
    if (have) {
      have.lastUsedAt = this.now();
      return have;
    }
    const pending = this.starting.get(agentId);
    if (pending) return pending;
    const p = (async () => {
      const driver = this.o.create(agentId);
      await driver.start(auth);
      const s: DisplaySession = {
        agentId,
        driver,
        startedAt: this.now(),
        lastUsedAt: this.now(),
        actedAt: 0,
        frame: null,
      };
      this.sessions.set(agentId, s);
      this.o.onStart?.(s);
      return s;
    })();
    this.starting.set(agentId, p);
    try {
      return await p;
    } finally {
      this.starting.delete(agentId);
    }
  }

  async frame(agentId: string, auth?: Authorize): Promise<Png | null> {
    const s = this.get(agentId);
    if (!s) return null;
    const ttl = this.o.frameTtlMs ?? 250;
    if (s.frame && this.now() - s.frame.at < ttl) return s.frame.png;
    const png = await s.driver.screenshot(auth);
    s.frame = { at: this.now(), png };
    return png;
  }
  /**
   * The approval card's preview: the newest frame already taken (never a new capture), and only while it still
   * shows the screen, i.e. it was taken after the last action. After an action there is no current picture until
   * the next screenshot (a card must never show a dot on an old screen).
   */
  lastFrame(agentId: string): Png | null {
    const s = this.get(agentId);
    if (!s?.frame || s.frame.at < s.actedAt) return null;
    return s.frame.png;
  }
  /** after an action the old frame is out of date: the next view takes a fresh one, the card shows none */
  touched(s: DisplaySession) {
    s.lastUsedAt = this.now();
    s.actedAt = this.now();
    if (s.frame) s.frame.at = -1;
  }

  async stop(agentId: string, reason: string): Promise<boolean> {
    const s = this.sessions.get(agentId);
    if (!s) return false;
    this.sessions.delete(agentId);
    await s.driver.stop();
    this.o.onStop?.(s, reason);
    return true;
  }
  async stopWhere(pred: (s: DisplaySession) => boolean, reason: string) {
    for (const s of [...this.sessions.values()]) if (pred(s)) await this.stop(s.agentId, reason);
  }
  async stopIdle(idleMs: number) {
    const cut = this.now() - idleMs;
    await this.stopWhere((s) => s.lastUsedAt < cut, 'idle');
  }
  async close() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    await this.stopWhere(() => true, 'shutdown');
  }
}
