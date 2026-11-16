/**
 * macOS (opt-in only): the agent sees and drives the owner's OWN screen through PasaBot Screen Helper, a separate
 * app that alone holds Screen Recording and Accessibility. The server never gets those permissions (granting them
 * to the server would hand them to every agent CLI it starts); it only talks to the helper over the private socket
 * (helper/protocol.ts), and every call that sees or touches the screen carries a single-use grant the server mints
 * after the owner approved that one action. The helper checks the grant itself, limits the rate, refuses password
 * boxes and protected windows, and shows a border and a menu-bar dot while it is in control.
 *
 * Coordinates are pixels of the helper's screenshots (the main display in points, scaled to at most 1600 wide);
 * the helper turns them back into points.
 */
import type { DisplayInfo, Png, PointerOrKeyAction } from '@pasabot/core';
import { type HelperClient, HelperError } from '../helper/client.js';
import type { Authorize } from '../helper/grants.js';
import type { WireRequest } from '../helper/protocol.js';
import { checkAction, type ManagedDriver } from './types.js';

/** the helper request for one checked action */
export function toWire(a: PointerOrKeyAction): WireRequest {
  if (a.kind === 'click') return { verb: 'click', args: { x: a.x, y: a.y, button: a.button ?? 'left' } };
  if (a.kind === 'move') return { verb: 'move', args: { x: a.x, y: a.y } };
  if (a.kind === 'type') return { verb: 'type', args: { text: a.text } };
  return { verb: 'key', args: { keys: a.keys } };
}

/** what the agent and the owner read when the helper says no */
export function helperRefusalText(e: unknown): string {
  if (!(e instanceof HelperError)) return (e as Error).message;
  switch (e.code) {
    case 'secure_input':
      return 'a password box is active on the owner’s screen, and the Screen Helper never types into one: ask the owner to type it';
    case 'protected_window':
      return 'that spot is a protected window (System Settings, a password or keychain prompt, PasaBot itself or the Screen Helper); the Screen Helper never touches it';
    case 'focus_moved':
      return `the Screen Helper stopped: ${e.message}. Look again with a screenshot, and click the app you want instead of switching with keys`;
    case 'no_screen_recording':
      return 'Screen Recording is not turned on for PasaBot Screen Helper yet (the owner turns it on in the Computer screen)';
    case 'no_accessibility':
      return 'Accessibility is not turned on for PasaBot Screen Helper yet (the owner turns it on in the Computer screen)';
    case 'stopped':
      return 'the owner stopped control of this Mac; it stays stopped until the owner allows it again';
    case 'rate_limited':
      return 'too many actions in a short time; wait a moment';
    case 'not_running':
      return 'PasaBot Screen Helper is not running (it starts with the PasaBot app)';
    case 'unsafe_files':
      return `the Screen Helper's private files are not safe to use: ${e.message}`;
    default:
      return `the Screen Helper refused: ${e.message}`;
  }
}

export interface MacOptions {
  client: HelperClient;
}

export class MacDriver implements ManagedDriver {
  readonly kind = 'macos' as const;
  readonly sharesOwnerScreen = true;
  private size: DisplayInfo | null = null;
  constructor(private readonly o: MacOptions) {}

  label() {
    return 'this Mac';
  }
  pid() {
    return null;
  }
  alive() {
    return this.size !== null;
  }
  display(): DisplayInfo {
    if (!this.size) throw new Error('the display is not running');
    return this.size;
  }
  private need(auth: Authorize | undefined): Authorize {
    if (!auth) throw new Error('no approval for this action');
    return auth;
  }
  private call = async (r: WireRequest, auth: Authorize | undefined) => {
    try {
      return await this.o.client.request(r, this.need(auth)(r));
    } catch (e) {
      throw new Error(helperRefusalText(e));
    }
  };
  private sized(r: Record<string, unknown>) {
    const w = Number(r.width);
    const h = Number(r.height);
    const pw = Number(r.pointsWidth);
    if (!(w > 0 && h > 0 && pw > 0)) throw new Error('the Screen Helper sent no screen size');
    this.size = { width: Math.round(w), height: Math.round(h), scale: w / pw };
  }

  async start(auth?: Authorize): Promise<void> {
    this.sized(await this.call({ verb: 'displays', args: {} }, auth));
  }
  async stop(): Promise<void> {
    this.size = null;
  }
  async screenshot(auth?: Authorize): Promise<Png> {
    this.display();
    const r = await this.call({ verb: 'screenshot', args: {} }, auth);
    this.sized(r);
    if (typeof r.png !== 'string') throw new Error('the Screen Helper sent no picture');
    return new Uint8Array(Buffer.from(r.png, 'base64'));
  }
  async act(a: PointerOrKeyAction, auth?: Authorize): Promise<void> {
    checkAction(a, this.display());
    await this.call(toWire(a), auth);
  }
}
