/**
 * The practice display: an in-memory screen with one small test app (a button, a text box, a pointer), drawn as
 * a real PNG. Used by tests and the e2e server (`PASABOT_COMPUTER_DRIVER=practice`) behind the same driver
 * interface as Xvfb, so the tools, approvals, viewer and action log are proven without an X server.
 */
import type { DisplayInfo, Png, PointerOrKeyAction } from '@pasabot/core';
import { encodePng } from '../png.js';
import { checkAction, type ManagedDriver } from './types.js';

export const PRACTICE = {
  width: 640,
  height: 400,
  /** the test app's button */
  button: { x: 240, y: 150, w: 160, h: 60 },
  /** its colour before and after it is pressed */
  idle: [47, 111, 222] as const,
  pressed: [46, 158, 91] as const,
};

let seq = 0;

export class PracticeDriver implements ManagedDriver {
  readonly kind = 'practice' as const;
  readonly sharesOwnerScreen = false;
  private running = false;
  private readonly n = ++seq;
  /** what the test app saw */
  readonly app = { presses: 0, typed: '', keys: [] as string[], pointer: { x: 20, y: 20 } };

  async start() {
    this.running = true;
  }
  async stop() {
    this.running = false;
  }
  label() {
    return `practice-${this.n}`;
  }
  pid() {
    return null;
  }
  alive() {
    return this.running;
  }
  display(): DisplayInfo {
    return { width: PRACTICE.width, height: PRACTICE.height, scale: 1 };
  }
  private live() {
    if (!this.running) throw new Error('the display is not running');
  }

  async act(a: PointerOrKeyAction): Promise<void> {
    this.live();
    checkAction(a, this.display());
    if (a.kind === 'click' || a.kind === 'move') {
      this.app.pointer = { x: a.x, y: a.y };
      const b = PRACTICE.button;
      if (a.kind === 'click' && (a.button ?? 'left') === 'left')
        if (a.x >= b.x && a.x < b.x + b.w && a.y >= b.y && a.y < b.y + b.h) this.app.presses++;
    } else if (a.kind === 'type') this.app.typed = (this.app.typed + a.text).slice(-200);
    else this.app.keys.push(a.keys);
  }

  async screenshot(): Promise<Png> {
    this.live();
    const { width: w, height: h } = PRACTICE;
    const px = new Uint8Array(w * h * 4);
    const fill = (x0: number, y0: number, ww: number, hh: number, c: readonly number[]) => {
      for (let y = Math.max(0, y0); y < Math.min(h, y0 + hh); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x0 + ww); x++) {
          const i = (y * w + x) * 4;
          px[i] = c[0]!;
          px[i + 1] = c[1]!;
          px[i + 2] = c[2]!;
          px[i + 3] = 255;
        }
    };
    fill(0, 0, w, h, [232, 236, 240]); // desktop
    fill(120, 80, 400, 260, [255, 255, 255]); // window
    fill(120, 80, 400, 24, [60, 64, 72]); // title bar
    const b = PRACTICE.button;
    fill(b.x, b.y, b.w, b.h, this.app.presses > 0 ? PRACTICE.pressed : PRACTICE.idle);
    fill(160, 250, 320, 36, [210, 214, 220]); // text box
    const chars = Math.min(this.app.typed.length, 38);
    for (let i = 0; i < chars; i++) fill(166 + i * 8, 258, 6, 20, [30, 30, 30]); // one bar per typed character
    fill(this.app.pointer.x - 3, this.app.pointer.y - 3, 7, 7, [220, 40, 40]); // pointer
    return encodePng(w, h, px);
  }
}
