/** Settings > Quit PasaBot / Open at sign-in: offered only by a launcher over the parent channel, owner only. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthResolver } from '../core/services.js';
import { DesktopBridge, registerDesktopRoutes } from './desktop-bridge.js';
import { attachParentChannel, type ParentServer } from './parent-channel.js';

function harness(offer: Record<string, unknown> | null) {
  const desktop = new DesktopBridge();
  const sent: Record<string, unknown>[] = [];
  let listener: (m: unknown) => void = () => {};
  const server = {
    url: 'http://127.0.0.1:1',
    sitesUrl: 'http://127.0.0.1:2',
    setupLink: null,
    killSwitch: { state: () => ({ stopped: false, since: null }), watch: () => {} },
    auth: { freshSetupLink: () => null },
    desktop,
  } as unknown as ParentServer;
  attachParentChannel(server, {
    connected: () => true,
    send: (m) => {
      sent.push(m);
      // the launcher's answer to an autostart ask: its new offer
      if (m.type === 'pasabot:desktop-ask' && m.what === 'autostart')
        queueMicrotask(() =>
          listener({ type: 'pasabot:desktop', quit: true, autostart: m.on, autostartAvailable: true }),
        );
    },
    onMessage: (l) => {
      listener = l;
    },
  });
  if (offer) listener({ type: 'pasabot:desktop', ...offer });
  const app = Fastify();
  let kind = 'owner';
  const resolveAuth = (() => ({
    kind: 'session',
    userKind: kind,
    userId: 'u',
    sessionId: 's',
  })) as unknown as AuthResolver;
  registerDesktopRoutes(app, desktop, resolveAuth);
  return { app, sent, as: (k: string) => (kind = k) };
}

describe('desktop controls in Settings (desktop-bridge.ts)', () => {
  it('nothing is offered without a launcher that offers it', async () => {
    const { app } = harness(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/desktop' })).json()).toEqual({
      quit: false,
      autostart: false,
      autostartAvailable: false,
    });
    expect((await app.inject({ method: 'POST', url: '/api/v1/desktop/quit', payload: {} })).statusCode).toBe(
      409,
    );
  });

  it('the owner quits and turns open at sign-in on through the launcher; anyone else may not', async () => {
    const { app, sent, as } = harness({ quit: true, autostart: false, autostartAvailable: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/desktop' })).json()).toEqual({
      quit: true,
      autostart: false,
      autostartAvailable: true,
    });
    const on = await app.inject({ method: 'POST', url: '/api/v1/desktop/autostart', payload: { on: true } });
    expect(on.json()).toMatchObject({ autostart: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/desktop/quit', payload: {} })).json()).toEqual({
      quitting: true,
    });
    expect(sent.filter((m) => m.type === 'pasabot:desktop-ask')).toEqual([
      { type: 'pasabot:desktop-ask', what: 'autostart', on: true },
      { type: 'pasabot:desktop-ask', what: 'quit' },
    ]);
    as('member');
    expect((await app.inject({ method: 'GET', url: '/api/v1/desktop' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/desktop/quit', payload: {} })).statusCode).toBe(
      403,
    );
    expect(sent.filter((m) => m.type === 'pasabot:desktop-ask')).toHaveLength(2);
  });

  it('open at sign-in cannot be changed where the launcher cannot (no app path)', async () => {
    const { app, sent } = harness({ quit: true, autostart: false, autostartAvailable: false });
    const r = await app.inject({ method: 'POST', url: '/api/v1/desktop/autostart', payload: { on: true } });
    expect(r.statusCode).toBe(409);
    expect(sent.some((m) => m.type === 'pasabot:desktop-ask')).toBe(false);
  });
});
