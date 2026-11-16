/**
 * A throwaway PasaBot server for the W34 Playwright spec: temp $PASABOT_HOME, port 0, the built web app, the local
 * models module (its "detect" candidates point at a stub Ollama on 127.0.0.1 port 0 started here), routines, the
 * W3 policy and the FakeProvider. Prints `{ url, setupLink, ollama }` as one JSON line; stops the stub and the server
 * on SIGTERM / stdin end. Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter } from '@pasabot/core';
import { createProviderOpsModule } from '@pasabot/mod-provider-ops/server';
import { createRoutinesModule } from '@pasabot/mod-routines/server';
import { createTemplatesModule } from '@pasabot/mod-templates/server';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer } from '@pasabot/testkit';
import { ollamaStub } from '../src/__fixtures__/stub.js';
import { createLocalModule } from '../src/server.js';

const ollama = await ollamaStub();
// wave 5: the free starter (templates) with a stub installer and a Fake "OpenCode" that always answers 429, for the
// routine skip-and-report spec (never the real binary, never a download)
const tools = mkdtempSync(join(tmpdir(), 'pasabot-local-e2e-bin-'));
const limitedOpenCode: ProviderAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  detect: async () => ({ installed: true, version: '0.0.0-e2e', signedIn: 'unknown' }),
  capabilities: () => new FakeProvider().capabilities(),
  async *runTurn() {
    yield { type: 'error', kind: 'rate_limit', message: '429 Too Many Requests' };
    yield { type: 'done', stop: 'error' };
  },
};
const s = await bootTestServer({
  printSetupLink: false,
  providers: [new FakeProvider({ deltaMs: 5 })],
  modules: [
    createLocalModule({ candidates: [{ api: 'ollama', url: ollama.url, name: 'Ollama' }], timeoutMs: 3000 }),
    createProviderOpsModule(),
    createRoutinesModule(),
    createTemplatesModule({
      binDir: tools,
      makeOpenCode: () => limitedOpenCode,
      installer: (_app, binDir) => ({
        describe: () => ({
          what: 'OpenCode CLI',
          where: join(binDir, 'opencode'),
          from: 'https://example.invalid/r',
        }),
        async install({ consent }) {
          if (!consent) throw new Error('no consent');
          writeFileSync(join(binDir, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          return { binPath: join(binDir, 'opencode'), version: 'v0.0.0-e2e' };
        },
      }),
    }),
  ],
  webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});
process.stdout.write(`${JSON.stringify({ url: s.url, setupLink: s.setupLink, ollama: ollama.url })}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await ollama.close().catch(() => {});
  rmSync(tools, { recursive: true, force: true });
  rmSync(`${s.home}-accounts`, { recursive: true, force: true });
  await s.cleanup().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
