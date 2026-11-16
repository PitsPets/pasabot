/**
 * Render the service units from the templates in `deploy/` (the templates are the source of truth; the CLI only
 * fills in absolute paths). Values are escaped for each format, never spliced raw.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manager } from './shared.js';
import { LAUNCHD_LABEL } from './shared.js';

export interface UnitVars {
  node: string;
  entry: string;
  root: string;
  pasabotHome: string;
  envFile: string;
  logFile: string;
  /** settings copied into the launchd plist (launchd has no env-file support) */
  env: Record<string, string>;
}

/** Settings never copied into a unit file: unit files are readable, secrets belong in the vault. */
export const NEVER_IN_UNIT = ['PASABOT_VAULT_PASSPHRASE', 'PASABOT_PASSWORD'];

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** systemd quoting: double quotes, backslash escapes, and `%` doubled (specifier escape). */
const sd = (s: string) => {
  if (/[\n\r\0]/.test(s)) throw new Error('unit values cannot contain line breaks');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
};

export function templatePath(root: string, manager: Exclude<Manager, 'process'>) {
  if (manager === 'launchd') return join(root, 'deploy', 'launchd', `${LAUNCHD_LABEL}.plist`);
  if (manager === 'systemd-user') return join(root, 'deploy', 'systemd', 'pasabot.service');
  return join(root, 'deploy', 'systemd', 'pasabot-system.service');
}

/** systemd path settings (WorkingDirectory=, EnvironmentFile=) take the rest of the line: no quotes, `%` doubled. */
const sdPath = (s: string) => {
  if (/[\n\r\0]/.test(s)) throw new Error('unit values cannot contain line breaks');
  return s.replace(/%/g, '%%');
};

export function renderUnit(template: string, manager: Exclude<Manager, 'process'>, v: UnitVars): string {
  const vars: Record<string, string> =
    manager === 'launchd'
      ? {
          NODE: xml(v.node),
          ENTRY: xml(v.entry),
          ROOT: xml(v.root),
          PASABOT_HOME: xml(v.pasabotHome),
          LOG_FILE: xml(v.logFile),
          ENV_DICT: `${Object.entries({ ...v.env, PASABOT_HOME: v.pasabotHome })
            .filter(([k]) => !NEVER_IN_UNIT.includes(k))
            .map(([k, val]) => `\n      <key>${xml(k)}</key><string>${xml(val)}</string>`)
            .join('')}\n    `,
        }
      : {
          NODE: sd(v.node),
          ENTRY: sd(v.entry),
          ROOT: sdPath(v.root),
          ENV_FILE: sdPath(v.envFile),
          HOME_ENV: sd(`PASABOT_HOME=${v.pasabotHome}`),
          PASABOT_HOME: sdPath(v.pasabotHome),
        };
  const out = template.replace(/@([A-Z_]+)@/g, (m, k: string) => {
    if (!(k in vars)) throw new Error(`unit template has an unknown placeholder ${m}`);
    return vars[k]!;
  });
  return out;
}

/** True when a rendered unit starts `entry` (the value as the unit format encodes it). */
export function unitRunsEntry(unit: string, manager: Exclude<Manager, 'process'>, entry: string) {
  return manager === 'launchd'
    ? unit.includes(`<string>${xml(entry)}</string>`)
    : unit.split('\n').some((l) => l.startsWith('ExecStart=') && l.includes(` ${sd(entry)}`));
}

export function renderFromRoot(root: string, manager: Exclude<Manager, 'process'>, v: UnitVars) {
  return renderUnit(readFileSync(templatePath(root, manager), 'utf8'), manager, v);
}
