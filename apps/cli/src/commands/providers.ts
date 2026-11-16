/**
 * `pasabot providers install <id>` (W22): installs a brain's CLI on the server through the owner's session. It first
 * shows what will be installed, where and from where (the server's own consent text), then asks the owner; only a
 * `y` (or `--yes`) sends the consent. The server downloads the vendor's release, checks its SHA-256 against the
 * published digest before writing anything, and records the version. `pasabot providers` alone lists what can be
 * installed. Owner only: the server refuses members, guests, agents and automation tokens.
 */
import { api, defineCommand, prompt } from '../command.js';

const BASE = '/api/m/templates/providers';
const USAGE = 'usage: pasabot providers install <id> [--yes]\n       pasabot providers list\n';

interface Installable {
  id: string;
  what: string;
  where: string;
  from: string;
  checksum: string;
  installed: { binPath: string; version: string } | null;
}

function fail(r: { status: number; json: any }): never {
  if (r.status === 401) throw new Error('not signed in; run `pasabot login` first');
  if (r.status === 404 && !r.json?.message)
    throw new Error('this server has no installer (templates module missing)');
  throw new Error(r.json?.message ?? `HTTP ${r.status}`);
}

export function providersCommand(o: { ask?: (q: string) => Promise<string>; isTTY?: () => boolean } = {}) {
  const ask = o.ask ?? ((q: string) => prompt(q));
  const isTTY = o.isTTY ?? (() => process.stdin.isTTY === true);
  return defineCommand({
    name: 'providers',
    summary: 'install <id>: install a brain CLI (asks first, SHA-256 checked); list',
    async run(args) {
      const [sub, id, ...rest] = args;
      const yes = rest.includes('--yes') || rest.includes('-y') || id === '--yes';
      const list = async () => {
        const r = await api(`${BASE}/installable`);
        if (r.status !== 200) fail(r);
        return r.json.providers as Installable[];
      };
      if (!sub || sub === 'list') {
        const all = await list();
        if (all.length === 0) process.stdout.write('nothing can be installed on this server\n');
        for (const p of all)
          process.stdout.write(
            `${p.id.padEnd(12)} ${p.what}${p.installed ? ` (installed ${p.installed.version})` : ''}\n`,
          );
        return 0;
      }
      if (sub !== 'install' || !id || id.startsWith('-')) {
        process.stderr.write(USAGE);
        return 2;
      }
      const p = (await list()).find((x) => x.id === id);
      if (!p) {
        const ids = (await list()).map((x) => x.id).join(', ') || 'none';
        throw new Error(`no installer for "${id}" (installable: ${ids})`);
      }
      process.stdout.write(
        `This installs ${p.what}\n  to:   ${p.where}\n  from: ${p.from}\n  check: ${p.checksum.toUpperCase()} of the download against the published digest\n`,
      );
      if (!yes) {
        if (!isTTY()) throw new Error('the owner has to agree: run it in a terminal, or add --yes');
        const a = (await ask('Install it now? [y/N] ')).trim().toLowerCase();
        if (a !== 'y' && a !== 'yes') {
          process.stdout.write('nothing installed\n');
          return 1;
        }
      }
      const r = await api(`${BASE}/${encodeURIComponent(id)}/install`, { body: { consent: true } });
      if (r.status !== 200) fail(r);
      process.stdout.write(
        `installed ${p.what} ${r.json.installed.version} at ${r.json.installed.binPath}\n`,
      );
      return 0;
    },
  });
}

export default providersCommand();
