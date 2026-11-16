/**
 * `pasabot update <pasabot-x.y.z.tar.gz> [--sig file] [--check] [--allow-downgrade] [--no-restart]`: install a signed
 * release. The signature is checked against the keys pinned in the installed copy before anything is unpacked;
 * a tampered or unsigned tarball is refused and nothing changes. Never runs on its own (owner-triggered).
 */
import { readFileSync, statSync } from 'node:fs';
import { defineCommand } from '../../command.js';
import { restartServer, runningEntry, serviceState } from './lifecycle.js';
import { applyRelease, loadTrustedKeys, MAX_TARBALL_BYTES, ReleaseError } from './release.js';
import { installService, unitPath } from './service.js';
import {
  currentLinkOf,
  defaultCtx,
  installedManager,
  installRoot,
  type OpsCtx,
  parseFlags,
  prefixOf,
  serverEntry,
} from './shared.js';
import { unitRunsEntry } from './units.js';

/** The unit installed for `m` still starts `entry` (false when the file is missing or points elsewhere). */
function unitRuns(ctx: OpsCtx, m: Exclude<ReturnType<typeof installedManager>, 'process'>, entry: string) {
  try {
    return unitRunsEntry(readFileSync(unitPath(ctx, m), 'utf8'), m, entry);
  } catch {
    return false;
  }
}

export async function update(
  ctx: OpsCtx,
  tarballPath: string,
  o: { sig?: string; check?: boolean; allowDowngrade?: boolean; restart?: boolean } = {},
): Promise<string> {
  const root = installRoot(ctx);
  if (!root) throw new ReleaseError('cannot find the installed PasaBot (set PASABOT_ROOT)');
  if (statSync(tarballPath).size > MAX_TARBALL_BYTES) throw new ReleaseError('tarball is larger than 512 MB');
  const tarball = readFileSync(tarballPath);
  let sig: string;
  try {
    sig = readFileSync(o.sig ?? `${tarballPath}.sig`, 'utf8');
  } catch {
    throw new ReleaseError(`signature file not found (${o.sig ?? `${tarballPath}.sig`}); refusing to update`);
  }
  const r = applyRelease({
    tarball,
    sig,
    keys: loadTrustedKeys(root),
    prefix: prefixOf(ctx),
    allowDowngrade: o.allowDowngrade,
    checkOnly: o.check,
  });
  if (o.check) return `signature OK: release ${r.version} (installed: ${r.previous ?? 'none'})`;
  let msg = `installed ${r.version} at ${r.path} (was ${r.previous ?? 'none'})`;
  const want = serverEntry(currentLinkOf(ctx));
  const m = installedManager(ctx);
  if (m !== 'process' && !unitRuns(ctx, m, want)) {
    // a unit written before units ran `<prefix>/current` (or by hand): restarting it would keep the old code
    if (o.restart === false)
      throw new ReleaseError(
        `${msg}, but the ${m} service does not run ${want}; run \`pasabot service install\` to switch it`,
      );
    installService(ctx, { system: m === 'systemd-system' });
    if (!unitRuns(ctx, m, want))
      throw new ReleaseError(`${msg}, but the ${m} service still does not run ${want}; it was not switched`);
    msg += `; service unit switched to ${currentLinkOf(ctx)}`;
  }
  if (o.restart === false || !serviceState(ctx).running) return msg;
  msg += `; ${await restartServer(ctx)}`;
  if (m === 'process') {
    // the restarted process must be the new release, not the folder it was first started from
    const runs = runningEntry(ctx);
    if (runs !== want)
      throw new ReleaseError(
        `${msg}, but the server runs ${runs ?? 'nothing'}, not ${want}` +
          (ctx.env.PASABOT_ROOT ? ' (PASABOT_ROOT is set; unset it to run installed releases)' : ''),
      );
  }
  return msg;
}

export default defineCommand({
  name: 'update',
  summary: 'install a signed release tarball (--check to verify only)',
  async run(args) {
    const ctx = defaultCtx();
    const { flags, rest } = parseFlags(args, ['sig']);
    if (!rest[0]) {
      ctx.err(
        'usage: pasabot update <pasabot-x.y.z.tar.gz> [--sig file] [--check] [--allow-downgrade] [--no-restart]\n' +
          'Download the tarball and its .sig from the release page first; both are checked before install.\n',
      );
      return 2;
    }
    try {
      ctx.out(
        `pasabot: ${await update(ctx, rest[0], {
          sig: typeof flags.sig === 'string' ? flags.sig : undefined,
          check: !!flags.check,
          allowDowngrade: !!flags['allow-downgrade'],
          restart: !flags['no-restart'],
        })}\n`,
      );
      return 0;
    } catch (e) {
      if (e instanceof ReleaseError) {
        ctx.err(`pasabot update: refused: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  },
});
