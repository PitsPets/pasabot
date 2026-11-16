/**
 * The desktop app's own settings, `$PASABOT_HOME/desktop.json` (0600, no secrets). Every field is optional on disk;
 * anything missing or malformed falls back to the default, so a hand-edited file never stops the app from starting.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DesktopConfig {
  /** preferred web/API port; when it is taken the server gets a free one and that one is remembered */
  port: number;
  /** preferred sandboxed sites port, same rule */
  sitesPort: number;
  /** read a static release file now and then; OFF unless the person turns it on */
  updateCheck: boolean;
  /** https URL of that release file; null = use the one baked into the build (if any) */
  updateUrl: string | null;
}

export const DEFAULT_CONFIG: Readonly<DesktopConfig> = Object.freeze({
  port: 7777,
  sitesPort: 7778,
  updateCheck: false,
  updateUrl: null,
});

export const configPath = (home: string) => join(home, 'desktop.json');

/** 0 = any free port (tests, or a person who never wants a fixed one) */
const isPort = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < 65536;

export function readConfig(home: string): DesktopConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(home), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      raw = parsed as Record<string, unknown>;
  } catch {
    // missing or unreadable: defaults
  }
  return {
    port: isPort(raw.port) ? raw.port : DEFAULT_CONFIG.port,
    sitesPort: isPort(raw.sitesPort) ? raw.sitesPort : DEFAULT_CONFIG.sitesPort,
    updateCheck: raw.updateCheck === true,
    updateUrl:
      typeof raw.updateUrl === 'string' && raw.updateUrl.startsWith('https://') ? raw.updateUrl : null,
  };
}

export function writeConfig(home: string, c: DesktopConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = configPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
