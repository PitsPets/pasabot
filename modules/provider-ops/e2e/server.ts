/**
 * A throwaway PasaBot server for the provider-ops Playwright spec: temp $PASABOT_HOME, port 0, the built web app,
 * this module, the FakeProvider (`fake`, runs `{"fakeScript": [...]}`) and a second Fake brain `acp:backup` that
 * always answers "echo: backup reply" (so a turn that failed on `fake` visibly continues on the fallback).
 * Prints `{ url, setupLink }` as one JSON line. Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter } from '@pasabot/core';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer } from '@pasabot/testkit';
import { createProviderOpsModule } from '../src/server.js';

const inner = new FakeProvider({ deltaMs: 5 });
const backup: ProviderAdapter = {
  id: 'acp:backup',
  displayName: 'Backup (e2e)',
  detect: () => inner.detect(),
  capabilities: () => inner.capabilities(),
  runTurn: (input, signal) =>
    inner.runTurn({ ...input, user: { ...input.user, text: 'backup reply' } }, signal),
};

const s = await bootTestServer({
  printSetupLink: false,
  providers: [new FakeProvider({ deltaMs: 10 }), backup],
  modules: [createProviderOpsModule()],
  webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});
process.stdout.write(`${JSON.stringify({ url: s.url, setupLink: s.setupLink })}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  rmSync(`${s.home}-accounts`, { recursive: true, force: true });
  await s.cleanup().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
