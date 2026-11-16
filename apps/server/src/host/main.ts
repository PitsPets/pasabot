#!/usr/bin/env node
/** `pasabot-server`: boot with $PASABOT_HOME (default ~/.pasabot) on 127.0.0.1. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--help` / `-h` / `--version` print and exit before anything else is loaded: no server, no data dir, no keychain
const arg = process.argv[2];
if (arg === '--version' || arg === '--help' || arg === '-h') {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  process.stdout.write(
    arg === '--version'
      ? `PasaBot ${version}\n`
      : `PasaBot server ${version}\n\n` +
          'usage: pasabot-server [--help | --version]\n\n' +
          'Starts the PasaBot server on 127.0.0.1. Settings come from the environment:\n' +
          '  PASABOT_HOME          data dir (default ~/.pasabot)\n' +
          '  PASABOT_HOST          listen address (default 127.0.0.1)\n' +
          '  PASABOT_PORT          web/API port (default 7777)\n' +
          '  PASABOT_SITES_PORT    sandboxed sites origin port (default 7778)\n' +
          '  PASABOT_PUBLIC_URL    the URL people open, when behind a proxy\n' +
          '  PASABOT_ROOT          install or workspace root (default: found from this file)\n',
  );
  process.exit(0);
}

// loaded only once we really start (nothing above touches the disk beyond reading our package.json)
const { defaultRunnerMode } = await import('../runner/sandbox.js');
const { findServerRoot } = await import('./discovery.js');
const { startServer } = await import('./server.js');
const { hostMasterKeySource } = await import('../vault/index.js');

const home = process.env.PASABOT_HOME ?? join(homedir(), '.pasabot');
// adapters that keep their own data under the data dir (the OpenCode model list) read it from here
process.env.PASABOT_HOME = home;
// from the server's own install location, never the cwd (PASABOT_ROOT overrides); boot warns if nothing is found
const root = process.env.PASABOT_ROOT ?? findServerRoot(dirname(fileURLToPath(import.meta.url)));
if (!root) process.stderr.write('pasabot: no install or workspace root found; set PASABOT_ROOT\n');
const runnerMode = defaultRunnerMode();
const hostMode = runnerMode === 'host' || runnerMode === 'host-unsandboxed';
const server = await startServer({
  home,
  root,
  runnerMode,
  // host mode keeps the master key in the OS key store unless a passphrase is given (ARCHITECTURE 7.2, 7.3): macOS
  // keychain, Windows DPAPI, the Linux desktop keyring (else a 0600 key file the owner is told about). Only for the
  // standard data folder: a temp, QA or test server (another PASABOT_HOME, a test runner) keeps its key in its own
  // folder and never writes into the user's keychain.
  vault: { source: hostMasterKeySource({ home, hostMode }) },
  allowedHosts: (process.env.PASABOT_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
  allowedOrigins: (process.env.PASABOT_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  publicUrl: process.env.PASABOT_PUBLIC_URL,
  webDir: process.env.PASABOT_WEB_DIR ?? (root ? join(root, 'apps', 'web', 'dist') : null),
  host: process.env.PASABOT_HOST ?? '127.0.0.1',
  port: Number(process.env.PASABOT_PORT ?? 7777),
  sitesPort: Number(process.env.PASABOT_SITES_PORT ?? 7778),
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Parent channel (the desktop app, W26; ARCHITECTURE 4.3; parent-channel.ts). Only a parent that spawned us with an IPC
// channel has one, so nothing on the network can reach it. It takes the server down with it: a parent that exits or
// is killed closes the channel and the server shuts down, so it never leaves an orphan server.
if (process.send) {
  const { attachParentChannel } = await import('./parent-channel.js');
  process.on('disconnect', stop);
  attachParentChannel(server, {
    connected: () => process.connected,
    send: (m) => process.send?.(m),
    onMessage: (l) => process.on('message', l),
  });
}
