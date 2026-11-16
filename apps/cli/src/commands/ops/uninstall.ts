/**
 * `pasabot uninstall [--remove-releases]`: stop the server and remove its service unit. Installed releases are
 * removed only with `--remove-releases`. The data folder ($PASABOT_HOME: chats, vault, workspaces) is never deleted
 * by this command; the owner deletes it by hand if they really want it gone.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from '../../command.js';
import { stopServer } from './lifecycle.js';
import { uninstallService } from './service.js';
import { defaultCtx, type OpsCtx, parseFlags, pasabotHomeOf, prefixOf } from './shared.js';

export async function uninstall(ctx: OpsCtx, o: { removeReleases?: boolean } = {}): Promise<string[]> {
  const lines: string[] = [];
  lines.push(await stopServer(ctx));
  const unit = uninstallService(ctx);
  lines.push(unit ? `service removed: ${unit}` : 'no service installed');
  const prefix = prefixOf(ctx);
  if (o.removeReleases) {
    // only the folders `pasabot update` creates, never the prefix itself (it may be shared)
    for (const p of [join(prefix, 'releases'), join(prefix, 'current')])
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    lines.push(`releases removed from ${prefix}`);
  }
  lines.push(`your data is kept in ${pasabotHomeOf(ctx)}`);
  return lines;
}

export default defineCommand({
  name: 'uninstall',
  summary: 'stop the server and remove its service (data is kept)',
  async run(args) {
    const ctx = defaultCtx();
    const { flags } = parseFlags(args);
    for (const l of await uninstall(ctx, { removeReleases: !!flags['remove-releases'] }))
      ctx.out(`pasabot: ${l}\n`);
    return 0;
  },
});
