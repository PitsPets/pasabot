/**
 * The desktop app's own controls, offered in the web app's Settings (Windows and Linux, where there may be no tray
 * icon): "Quit PasaBot" and "Open at sign-in". The launcher says over the parent channel (parent-channel.ts, never
 * HTTP) what it offers, `pasabot:desktop`; the owner's tap goes back the same way, `pasabot:desktop-ask`. With no
 * launcher (a server started any other way, or the macOS app, whose own menus have both), nothing is offered.
 */
import { httpResponse, type Principal } from '@pasabot/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthResolver } from '../core/services.js';
import { mountAuthedRoute } from './module-host.js';

export interface DesktopView {
  /** the launcher can quit from here */
  quit: boolean;
  /** open at sign-in is on */
  autostart: boolean;
  /** open at sign-in can be changed here */
  autostartAvailable: boolean;
}

const NONE: DesktopView = { quit: false, autostart: false, autostartAvailable: false };

export class DesktopBridge {
  private state: DesktopView | null = null;
  private ask: ((m: Record<string, unknown>) => boolean) | null = null;
  private readonly waiters = new Set<() => void>();

  /** the parent channel: how to ask the launcher (false when it is gone) */
  connect(ask: (m: Record<string, unknown>) => boolean): void {
    this.ask = ask;
  }

  /** a `pasabot:desktop` message from the launcher */
  update(m: unknown): void {
    if (typeof m !== 'object' || m === null) return;
    const o = m as Record<string, unknown>;
    this.state = {
      quit: o.quit === true,
      autostart: o.autostart === true,
      autostartAvailable: o.autostartAvailable === true,
    };
    for (const w of [...this.waiters]) w();
  }

  view(): DesktopView {
    return this.ask && this.state ? { ...this.state } : { ...NONE };
  }

  quit(): boolean {
    if (!this.view().quit || !this.ask) return false;
    return this.ask({ type: 'pasabot:desktop-ask', what: 'quit' });
  }

  /** asks the launcher, then waits (briefly) for its new state; null when it cannot be asked */
  async setAutostart(on: boolean, timeoutMs = 3000): Promise<DesktopView | null> {
    if (!this.view().autostartAvailable || !this.ask) return null;
    const answered = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
    if (!this.ask({ type: 'pasabot:desktop-ask', what: 'autostart', on })) return null;
    await answered;
    return this.view();
  }
}

export function registerDesktopRoutes(
  app: FastifyInstance,
  bridge: DesktopBridge,
  resolveAuth: AuthResolver,
) {
  type Session = Extract<Principal, { kind: 'session' }>;
  const ownerOnly = () => httpResponse(403, { error: 'owner_only' });
  const notAvailable = () => httpResponse(409, { error: 'not_available' });
  mountAuthedRoute(
    app,
    '/api/v1',
    {
      method: 'GET',
      url: '/desktop',
      auth: 'session',
      handler: (ctx) => ((ctx.principal as Session).userKind === 'owner' ? bridge.view() : ownerOnly()),
    },
    resolveAuth,
  );
  mountAuthedRoute(
    app,
    '/api/v1',
    {
      method: 'POST',
      url: '/desktop/quit',
      auth: 'session',
      handler: (ctx) => {
        if ((ctx.principal as Session).userKind !== 'owner') return ownerOnly();
        return bridge.quit() ? { quitting: true } : notAvailable();
      },
    },
    resolveAuth,
  );
  mountAuthedRoute(
    app,
    '/api/v1',
    {
      method: 'POST',
      url: '/desktop/autostart',
      auth: 'session',
      body: z.object({ on: z.boolean() }),
      handler: async (ctx) => {
        if ((ctx.principal as Session).userKind !== 'owner') return ownerOnly();
        const v = await bridge.setAutostart((ctx.body as { on: boolean }).on);
        return v ?? notAvailable();
      },
    },
    resolveAuth,
  );
}
