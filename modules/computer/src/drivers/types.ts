/**
 * The module's side of the core `ComputerDriver` port: every driver can also start and stop its display, says
 * which one it is and whether it shares the owner's own screen. Input checks live here so every driver gets the
 * same ones (plain loops, never a regex on agent text).
 */
import { spawn } from 'node:child_process';
import type { ComputerDriver, Png, PointerOrKeyAction } from '@pasabot/core';
import type { Authorize } from '../helper/grants.js';

export type DriverKind = 'xvfb' | 'macos' | 'practice';

/**
 * `auth` mints the single-use grant for one call; the server passes it only on paths the owner approved (a
 * tier-3 handler, an owner session). The macOS driver refuses without it; separate displays ignore it.
 */
export interface ManagedDriver extends ComputerDriver {
  readonly kind: DriverKind;
  /** true when the agent sees and drives the owner's own screen (macOS); false for a separate display */
  readonly sharesOwnerScreen: boolean;
  start(auth?: Authorize): Promise<void>;
  screenshot(auth?: Authorize): Promise<Png>;
  act(a: PointerOrKeyAction, auth?: Authorize): Promise<void>;
  stop(): Promise<void>;
  /** what the owner sees as the display's name, e.g. ":97" */
  label(): string;
  /** pid of the display server this driver started, if any */
  pid(): number | null;
  /** false once stopped, or when its display server went away */
  alive(): boolean;
}

export const MAX_TEXT = 2000;
export const MAX_KEY_TOKENS = 16;

/** Text to type: at most 2000 characters, no control characters except newline and tab. */
export function checkText(text: string): string {
  if (text.length === 0) throw new Error('nothing to type');
  if (text.length > MAX_TEXT) throw new Error(`text is longer than ${MAX_TEXT} characters`);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 10 && c !== 9) || c === 127) throw new Error('text has a control character');
  }
  return text;
}

const keyChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45;

/**
 * Key chords like `ctrl+a Return`: up to 16 space-separated tokens of letters, digits, `_`, `+`, `-` (X keysym
 * names joined by `+`), each at most 40 characters and never starting with `-` (no option injection).
 */
export function checkKeys(keys: string): string[] {
  const tokens = keys.split(' ').filter((k) => k.length > 0);
  if (tokens.length === 0) throw new Error('no keys given');
  if (tokens.length > MAX_KEY_TOKENS) throw new Error(`more than ${MAX_KEY_TOKENS} keys`);
  for (const t of tokens) {
    if (t.length > 40) throw new Error('a key name is too long');
    if (t.charCodeAt(0) === 45) throw new Error('a key name cannot start with "-"');
    for (let i = 0; i < t.length; i++) if (!keyChar(t.charCodeAt(i))) throw new Error(`bad key name: ${t}`);
    for (const part of t.split('+')) if (part.length === 0) throw new Error(`bad key chord: ${t}`);
  }
  return tokens;
}

/** Coordinates must be whole pixels inside the display. */
export function checkAction(a: PointerOrKeyAction, d: { width: number; height: number }): PointerOrKeyAction {
  if (a.kind === 'click' || a.kind === 'move') {
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) throw new Error('x and y must be whole pixels');
    if (a.x < 0 || a.y < 0 || a.x >= d.width || a.y >= d.height)
      throw new Error(`(${a.x}, ${a.y}) is outside the ${d.width}x${d.height} display`);
  } else if (a.kind === 'type') checkText(a.text);
  else if (a.kind === 'key') checkKeys(a.keys);
  return a;
}

export interface RunResult {
  stdout: Buffer;
}
export type Runner = (
  cmd: string,
  args: string[],
  o: { env: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number },
) => Promise<RunResult>;

/** Run a helper to completion (no shell), with a time and output cap; reject on a non-zero exit. */
export const runCommand: Runner = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const max = o.maxBytes ?? 32 * 1024 * 1024;
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 15_000);
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > max) child.kill('SIGKILL');
      else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 2000) err += b.toString('utf8');
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out) });
      else reject(new Error(`${cmd.split('/').pop()} failed (${sig ?? code}): ${err.trim().slice(0, 300)}`));
    });
  });
