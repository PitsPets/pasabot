/**
 * A throwaway PasaBot server for the search Playwright spec: temp $PASABOT_HOME, port 0, the built web app, the
 * search module and the FakeProvider (echoes each message). Prints `{ url, setupLink }` as one JSON line.
 * Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { fileURLToPath } from 'node:url';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer } from '@pasabot/testkit';
import { createSearchModule } from '../src/server.js';

const s = await bootTestServer({
  printSetupLink: false,
  providers: [new FakeProvider({ deltaMs: 10 })],
  modules: [createSearchModule()],
  webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});
process.stdout.write(`${JSON.stringify({ url: s.url, setupLink: s.setupLink })}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await s.cleanup().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
