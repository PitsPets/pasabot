/**
 * An app window on Windows and Linux without any SDK: PasaBot opens in a Chromium-family browser that is already
 * installed, in app mode (`--app=<url>`: no tabs, no address bar, its own taskbar entry), with a profile of its own
 * under the data folder (`<PASABOT_HOME>/app-window`), so its cookies and storage are PasaBot's alone and never the
 * person's everyday browser profile. Windows: Microsoft Edge (every Windows 10/11 has it), found through the
 * registry's App Paths and the usual install folders, then Chrome, then Brave. Linux: chromium, google-chrome,
 * brave, microsoft-edge on PATH. With none of them, the default browser opens the link as before (opener.ts).
 *
 * Every command is an argument array, never a shell: the link (a setup link carries a one-time code) reaches the
 * browser exactly as it is. Starting the browser again with the same profile opens a new PasaBot window in the
 * running one, which is how a second launch or the tray's Open PasaBot brings the window back.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

export interface BrowserProbe {
  exists(path: string): boolean;
  /** `reg query <key> /ve` default value, or null (Windows) */
  regDefault(key: string): string | null;
}

const realProbe: BrowserProbe = {
  exists: existsSync,
  regDefault(key) {
    const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status !== 0) return null;
    return parseRegDefault(r.stdout ?? '');
  },
};

/** the `(Default)` value of a `reg query /ve` answer, with %VARS% of a REG_EXPAND_SZ left for the caller */
export function parseRegDefault(out: string): string | null {
  const m = /REG_(?:EXPAND_)?SZ[ \t]+(.+?)\s*$/m.exec(out);
  if (!m?.[1]) return null;
  return m[1].replace(/^"(.*)"$/, '$1');
}

const expand = (s: string, env: Record<string, string | undefined>) =>
  s.replace(/%([^%]+)%/g, (all, k: string) => {
    const hit = Object.entries(env).find(([n]) => n.toLowerCase() === k.toLowerCase());
    return hit?.[1] ?? all;
  });

const APP_PATHS = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const WIN_BROWSERS: { exe: string; dirs: string[] }[] = [
  { exe: 'msedge.exe', dirs: ['Microsoft\\Edge\\Application'] },
  { exe: 'chrome.exe', dirs: ['Google\\Chrome\\Application'] },
  { exe: 'brave.exe', dirs: ['BraveSoftware\\Brave-Browser\\Application'] },
];

/** Chromium-family browsers on this Windows PC, best first (Edge, Chrome, Brave), each an absolute .exe path */
export function windowsBrowsers(
  env: Record<string, string | undefined>,
  probe: BrowserProbe = realProbe,
): string[] {
  const out: string[] = [];
  const add = (p: string | null) => {
    if (!p) return;
    const full = expand(p, env);
    if (
      win32.isAbsolute(full) &&
      full.toLowerCase().endsWith('.exe') &&
      probe.exists(full) &&
      !out.includes(full)
    )
      out.push(full);
  };
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(
    (r): r is string => !!r,
  );
  for (const b of WIN_BROWSERS) {
    add(probe.regDefault(`HKCU\\${APP_PATHS}\\${b.exe}`));
    add(probe.regDefault(`HKLM\\${APP_PATHS}\\${b.exe}`));
    for (const r of roots) for (const d of b.dirs) add(win32.join(r, d, b.exe));
  }
  return out;
}

const LINUX_BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'brave-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
];

/**
 * Chromium-family browsers on PATH on Linux, best first, as absolute paths. A Linux PATH is always `:`-separated, so it
 * is split on `:` whatever OS this code runs on (node:path's `delimiter` is the host's, `;` on Windows).
 */
export function linuxBrowsers(path: string, probe: Pick<BrowserProbe, 'exists'> = realProbe): string[] {
  const out: string[] = [];
  for (const name of LINUX_BROWSERS)
    for (const dir of path.split(':')) {
      if (!dir || !posix.isAbsolute(dir)) continue;
      const p = posix.join(dir, name);
      if (probe.exists(p)) {
        if (!out.includes(p)) out.push(p);
        break;
      }
    }
  return out;
}

/** the browser's arguments for PasaBot's app window: app mode on `url`, PasaBot's own profile, no first-run pages */
export function appWindowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
  ];
}

/** the profile folder of PasaBot's app window: inside the data folder, which agents never reach */
export const appWindowProfile = (home: string, platform: NodeJS.Platform) =>
  (platform === 'win32' ? win32.join : join)(home, 'app-window');

/**
 * The app-window command for `url`, or null when no Chromium-family browser is installed (the caller then opens the
 * default browser). Only Windows and Linux: the macOS app has its own window.
 */
export function appWindowCommand(
  platform: NodeJS.Platform,
  url: string,
  o: { home: string; env: Record<string, string | undefined>; probe?: BrowserProbe },
): [string, string[]] | null {
  const found =
    platform === 'win32'
      ? windowsBrowsers(o.env, o.probe)
      : platform === 'linux'
        ? linuxBrowsers(o.env.PATH ?? '', o.probe)
        : [];
  const browser = found[0];
  return browser ? [browser, appWindowArgs(url, appWindowProfile(o.home, platform))] : null;
}
