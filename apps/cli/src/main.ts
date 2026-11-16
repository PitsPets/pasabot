#!/usr/bin/env node
/**
 * `pasabot` CLI skeleton. Commands are found by glob, never by a registry: every file under `commands/` (any depth)
 * whose default export is a `Command` becomes a verb. W20/W21/W22 add their verbs as new files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Command } from './command.js';

export async function loadCommands(dir = join(dirname(fileURLToPath(import.meta.url)), 'commands')) {
  const out = new Map<string, Command>();
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(js|ts)$/.test(f) || /\.(test|d)\.(js|ts)$/.test(f)) continue;
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: Command };
    const c = mod.default;
    if (!c?.name || typeof c.run !== 'function') continue;
    if (out.has(c.name)) throw new Error(`duplicate CLI verb "${c.name}" (${f})`);
    out.set(c.name, c);
  }
  return out;
}

/** this CLI's own version (from its package.json, next to both src/ and dist/) */
export const cliVersion = () =>
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
    .version;

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // answered before anything else: print and exit, never a server call, never a data dir
  if (verb === '--version') {
    process.stdout.write(`PasaBot ${cliVersion()}\n`);
    return 0;
  }
  const cmds = await loadCommands();
  const c = verb ? cmds.get(verb) : undefined;
  if (!c) {
    const asked = !verb || verb === 'help' || verb === '--help' || verb === '-h';
    const list = [...cmds.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    process.stdout.write(
      `PasaBot command-line tool ${cliVersion()}\n\nusage: pasabot <command>\n\n${list.map((x) => `  ${x.name.padEnd(12)} ${x.summary}`).join('\n')}\n\n  --help, -h   this help\n  --version    print the version\n`,
    );
    return asked ? 0 : 2;
  }
  try {
    return (await c.run(rest)) ?? 0;
  } catch (e) {
    process.stderr.write(`pasabot ${c.name}: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
