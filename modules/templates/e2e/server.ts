/**
 * A throwaway server for the templates e2e spec: temp home, port 0, the built web app, the templates module with a
 * stub installer (never a real download; `TPL_E2E_INSTALL=fail` makes it fail) and a FakeProvider presented as the
 * installed OpenCode CLI (never the real binary). Also the local models module (its detect candidate is a tiny
 * Ollama stub on 127.0.0.1 port 0 started here). The free-model
 * list is a temp copy of the catalog the spec may edit. Prints `{ url, setupLink, catalog }` as one JSON line, runs
 * until stdin closes or SIGTERM. Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter } from '@pasabot/core';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer } from '@pasabot/testkit';
// test harness only: reached by path, not as a workspace dependency, because providers/local already depends on
// this module for its own specs and a dependency back would make the workspace build a cycle
import { createLocalModule } from '../../../providers/local/src/server.js';
import { InstallError } from '../src/install/installer.js';
import { createTemplatesModule, DEFAULT_CATALOG } from '../src/server.js';

const tools = mkdtempSync(join(tmpdir(), 'pasabot-tpl-e2e-bin-'));
const catalog = mkdtempSync(join(tmpdir(), 'pasabot-tpl-e2e-cat-'));
cpSync(DEFAULT_CATALOG, catalog, { recursive: true });
const inner = new FakeProvider({ deltaMs: 5 });
const fakeOpenCode = (): ProviderAdapter => ({
  id: 'opencode',
  displayName: 'OpenCode',
  detect: async () => ({ installed: true, version: '0.0.0-e2e', signedIn: 'unknown' }),
  capabilities: () => inner.capabilities(),
  runTurn: (input, signal) => inner.runTurn(input, signal),
});

// just enough of Ollama for detection: one model, on loopback, port 0
const ollama = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'chatty:latest' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
  res.statusCode = 404;
  res.end('{}');
});
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

const s = await bootTestServer({
  printSetupLink: false,
  providers: [new FakeProvider({ deltaMs: 10 })],
  modules: [
    createTemplatesModule({
      catalog,
      binDir: tools,
      makeOpenCode: fakeOpenCode,
      installer: (_app, binDir) => ({
        describe: () => ({
          what: 'OpenCode CLI',
          where: join(binDir, 'opencode'),
          from: 'https://github.com/sst/opencode/releases',
        }),
        async install({ consent }) {
          if (!consent) throw new InstallError('no_consent', 'no consent');
          if (process.env.TPL_E2E_INSTALL === 'fail')
            throw new InstallError('download', 'stub download failed');
          mkdirSync(binDir, { recursive: true });
          writeFileSync(join(binDir, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          return { binPath: join(binDir, 'opencode'), version: 'v0.0.0-e2e' };
        },
      }),
    }),
    createLocalModule({ candidates: [{ api: 'ollama', url: ollamaUrl, name: 'Ollama' }], timeoutMs: 3000 }),
  ],
  webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});
process.stdout.write(`${JSON.stringify({ url: s.url, setupLink: s.setupLink, catalog })}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await new Promise<void>((r) => ollama.close(() => r()));
  rmSync(tools, { recursive: true, force: true });
  rmSync(catalog, { recursive: true, force: true });
  await s.cleanup().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
