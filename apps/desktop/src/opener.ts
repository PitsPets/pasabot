/**
 * Opening a link in the default browser for a launcher that has no shell window to do it (the Linux starter,
 * `--open-urls`), and what such a launcher writes to stdout. A setup link carries a one-time code, so:
 *   - it is opened with an argument array, never through a shell: no quoting, no interpolation, so `#`, `&` and `?`
 *     reach the browser as they are (Windows: `rundll32 url.dll,FileProtocolHandler`, never `cmd /c start`, which
 *     cuts a URL at `&`; Linux: `xdg-open`, then `gio open` when there is no xdg-open; macOS: `open`);
 *   - only a plain http(s) address with no spaces, quotes or control characters is opened at all;
 *   - when the launcher opens links itself nobody reads its stdout but a log file (the starter appends it to
 *     `desktop.log`), so the code is hidden in what it writes there. The server log's boot line stays the only place
 *     a setup link is ever written.
 */
import { spawn } from 'node:child_process';
import type { ShellEvent } from './launcher.js';

/** a started opener: only its failure to start matters (the browser runs on its own) */
export interface Spawned {
  on(event: 'error', listener: (e: NodeJS.ErrnoException) => void): unknown;
}
export type Spawner = (cmd: string, args: string[]) => Spawned;

/** an http(s) address with nothing a command line or a browser could read as something else */
export function isOpenable(url: string): boolean {
  if (!/^https?:\/\/[^\s"'`<>\\^|]+$/.test(url)) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** the commands that open `url` in the default browser on `platform`, in the order they are tried */
export function openCommands(platform: NodeJS.Platform, url: string): [string, string[]][] {
  if (platform === 'darwin') return [['open', [url]]];
  if (platform === 'win32') return [['rundll32.exe', ['url.dll,FileProtocolHandler', url]]];
  return [
    ['xdg-open', [url]],
    ['gio', ['open', url]],
  ];
}

const defaultSpawner: Spawner = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
  child.unref();
  return child;
};

/**
 * Opens a link in the default browser; false when it is not a plain http(s) address. A command that is not installed
 * (ENOENT) moves on to the next one; any other failure is left alone (the link is never retried or reported).
 */
export function createOpener(
  platform: NodeJS.Platform,
  spawner: Spawner = defaultSpawner,
  /** PasaBot's app window (app-window.ts) when a Chromium-family browser is installed; tried before the default browser */
  appWindow?: (url: string) => [string, string[]] | null,
): (url: string) => boolean {
  return (url) => {
    if (!isOpenable(url)) return false;
    const win = appWindow?.(url) ?? null;
    const tries = [...(win ? [win] : []), ...openCommands(platform, url)];
    const attempt = (i: number) => {
      const next = tries[i];
      if (!next) return;
      try {
        spawner(next[0], next[1]).on('error', (e) => {
          // not installed, or (an app-window browser) it could not start: the next way to open it
          if (e.code === 'ENOENT' || (win !== null && i === 0)) attempt(i + 1);
        });
      } catch {
        attempt(i + 1);
      }
    };
    attempt(0);
    return true;
  };
}

/** `…#/setup?token=<code>` with the code replaced, for anything that is written where people or logs can read it */
export function hideSetupCode(url: string): string {
  return url.replace(/([?&]token=)[^&#\s]*/g, '$1<hidden>');
}

/** the event as written to stdout by a launcher that opens links itself: no setup code in it */
export function redacted(e: ShellEvent): ShellEvent {
  if ((e.event === 'open' || e.event === 'setup-link' || e.event === 'already-running') && e.url)
    return { ...e, url: hideSetupCode(e.url) } as ShellEvent;
  return e;
}

export interface ShellSink {
  /** the launcher opens links itself (no shell window reads its events) */
  selfOpens: boolean;
  open(url: string): unknown;
  /** one wire line (JSON, no newline) */
  write(line: string): void;
}

/**
 * The launcher's `emit`: every event goes to the wire as one JSON line; with `selfOpens` the launcher also opens what
 * the shell would have (an `open`, a second launch that was not handed to the first copy) and hides setup codes on
 * the wire. A handed-off second launch opens nothing: the first copy opens a fresh link itself.
 */
export function shellSink(s: ShellSink): (e: ShellEvent) => void {
  return (e) => {
    if (s.selfOpens) {
      if (e.event === 'open') s.open(e.url);
      if (e.event === 'already-running' && e.url && !e.handedOff) s.open(e.url);
    }
    s.write(JSON.stringify(s.selfOpens ? redacted(e) : e));
  };
}
