/**
 * Two throwaway PasaBot servers for the link Playwright spec, linked over one in-memory network in this process:
 * temp homes, port 0, the built web app, the link module and the FakeProvider. Prints
 * `{ alpha: { url, setupLink }, beta: { url, setupLink } }` as one JSON line.
 * Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { fileURLToPath } from 'node:url';
import { createMemoryNetwork } from '@pasabot/link-transport';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer } from '@pasabot/testkit';
import { createLinkModule } from '../src/server.js';

const net = createMemoryNetwork();
const webDir = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
const boot = (name: string) =>
  bootTestServer({
    printSetupLink: false,
    providers: [new FakeProvider({ deltaMs: 10 })],
    modules: [createLinkModule({ name, transport: (keys) => net.transport(keys) })],
    webDir,
  });
const alpha = await boot('alpha');
const beta = await boot('beta');
process.stdout.write(
  `${JSON.stringify({
    alpha: { url: alpha.url, setupLink: alpha.setupLink },
    beta: { url: beta.url, setupLink: beta.setupLink },
  })}\n`,
);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await Promise.all([alpha.cleanup(), beta.cleanup()]).catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
