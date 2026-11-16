/**
 * "Open PasaBot when I log in". One plain file per platform, in the user's own folders, no admin rights:
 * macOS a LaunchAgent that runs `open` on the app, Linux an XDG autostart entry, Windows a Startup-folder script.
 * On = the file exists. Turning it on never starts anything now; it takes effect at the next login.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUTOSTART_LABEL = 'local.pasabot.desktop';

export interface AutostartTarget {
  platform: NodeJS.Platform;
  /** the user's home folder */
  userHome: string;
  /** what to start: the .app bundle (macOS), the launcher command (Linux) or the .exe/.cmd (Windows) */
  appPath: string;
  /** %APPDATA% on Windows (default `<home>\AppData\Roaming`) */
  appData?: string;
  /**
   * Windows: LOCALAPPDATA / APPDATA / USERPROFILE (the Startup script names them, never the literal user folder);
   * Linux: XDG_CONFIG_HOME
   */
  env?: Record<string, string | undefined>;
}

const USER_VARS = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE'] as const;

/**
 * Windows: the path as the Startup `.cmd` should spell it. cmd.exe reads a `.cmd` file in the OEM code page, so a
 * user folder such as `C:\Users\Peña` written into it would be the wrong path, and a `%` would be expanded. So the
 * user's own folders are written as %LOCALAPPDATA% / %APPDATA% / %USERPROFILE% (cmd expands those itself, in
 * Unicode); null when the rest still has a character cmd.exe could misread (then open-at-login is offered as
 * unavailable rather than silently broken).
 */
export function cmdSafePath(p: string, env: Record<string, string | undefined> = {}): string | null {
  let out = p;
  for (const v of USER_VARS) {
    const val = env[v]?.replace(/\\+$/, '');
    if (val && out.toLowerCase().startsWith(`${val.toLowerCase()}\\`)) {
      out = `%${v}%${out.slice(val.length)}`;
      break;
    }
  }
  const rest = out.replace(/^%(LOCALAPPDATA|APPDATA|USERPROFILE)%/, '');
  if (!/^[\x20-\x7e]*$/.test(rest) || /[%"^&|<>]/.test(rest)) return null;
  return out;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function autostartFile(t: AutostartTarget): string {
  if (t.platform === 'darwin') return join(t.userHome, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
  if (t.platform === 'win32')
    return join(
      t.appData ?? join(t.userHome, 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'PasaBot.cmd',
    );
  const xdg = t.env?.XDG_CONFIG_HOME;
  return join(xdg?.startsWith('/') ? xdg : join(t.userHome, '.config'), 'autostart', 'pasabot.desktop');
}

export function autostartContent(t: AutostartTarget): string {
  if (/[\r\n\0]/.test(t.appPath)) throw new Error('app path has a line break');
  if (t.platform === 'darwin')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>${xml(t.appPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
  if (t.platform === 'win32') {
    if (t.appPath.includes('"')) throw new Error('app path has a quote');
    const safe = cmdSafePath(t.appPath, t.env);
    if (!safe) throw new Error('app path has characters a Windows startup script cannot spell');
    // a batch file is CALLed, never STARTed: START runs a batch as `cmd /K`, which leaves a console on screen at
    // every sign-in; CALL runs it in this script's own console, which closes when both are done
    if (/\.(cmd|bat)$/i.test(t.appPath)) return `@echo off\r\ncall "${safe}"\r\n`;
    return `@echo off\r\nstart "" "${safe}"\r\n`;
  }
  // XDG desktop entry: quote the path; inside double quotes \ " ` $ are escaped
  const q = `"${t.appPath.replace(/([\\"`$])/g, '\\$1')}"`;
  return `[Desktop Entry]
Type=Application
Name=PasaBot
Exec=${q}
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
}

export const isAutostartOn = (t: AutostartTarget) => existsSync(autostartFile(t));

/** whether open-at-login can be written for this target at all (a Windows path cmd.exe could misread cannot) */
export function autostartPossible(t: AutostartTarget): boolean {
  try {
    autostartContent(t);
    return true;
  } catch {
    return false;
  }
}

export function setAutostart(t: AutostartTarget, on: boolean): void {
  const file = autostartFile(t);
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, autostartContent(t), { mode: 0o644 });
}
