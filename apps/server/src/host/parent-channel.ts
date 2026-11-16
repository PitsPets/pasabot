/**
 * Parent channel (the desktop app, W26; ARCHITECTURE 4.3). Only a parent that spawned the server with a Node IPC
 * channel has one, so nothing on the network, no web page and no browser tab can reach it. The parent learns the real
 * URLs (port 0 works), may press the global stop as a `system` actor (resume stays owner + re-auth, on the web), and
 * may ask for a fresh first-run setup link for the window it shows the person in front of the machine
 * (`pasabot:setup-link`; null once an owner exists, the same link again while the last one is a few seconds old).
 * Setup links travel only over this channel: they are never logged here.
 */
import { asSystem } from '@pasabot/core';
import type { PasaBotServer } from './server.js';

export interface ParentChannel {
  /** false once the parent is gone */
  connected(): boolean;
  send(m: Record<string, unknown>): void;
  onMessage(listener: (m: unknown) => void): void;
}

export type ParentServer = Pick<PasaBotServer, 'url' | 'sitesUrl' | 'setupLink' | 'killSwitch' | 'auth'>;

/** wires the channel and says `pasabot:ready` (with the boot setup link, when there is one) */
export function attachParentChannel(server: ParentServer, ch: ParentChannel): void {
  const tell = (m: Record<string, unknown>) => {
    if (ch.connected()) ch.send(m);
  };
  const stopState = () => {
    const s = server.killSwitch.state();
    return { type: 'pasabot:state', stopped: s.stopped, since: s.since };
  };
  const freshSetupLink = () => {
    try {
      return server.auth.freshSetupLink();
    } catch {
      return null; // the window then says to reopen the app; the reason never carries a token
    }
  };
  server.killSwitch.watch(() => tell(stopState()));
  ch.onMessage((m: unknown) => {
    const type = typeof m === 'object' && m !== null ? (m as { type?: unknown }).type : undefined;
    if (type === 'pasabot:state') tell(stopState());
    else if (type === 'pasabot:stop-all')
      void server.killSwitch.stopAll(asSystem('desktop app'), 'stop all from the desktop app').then(
        () => tell(stopState()),
        (e: unknown) => tell({ type: 'pasabot:error', message: e instanceof Error ? e.message : String(e) }),
      );
    else if (type === 'pasabot:setup-link') tell({ type: 'pasabot:setup-link', setupLink: freshSetupLink() });
  });
  // the first-run setup link (single use, 30 min) goes only to the parent, which opens it for the person in front
  tell({
    type: 'pasabot:ready',
    url: server.url,
    sitesUrl: server.sitesUrl,
    setupLink: server.setupLink,
    stopped: server.killSwitch.state().stopped,
  });
}
