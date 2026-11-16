// `pnpm dev`: the PasaBot server (from TypeScript sources) + the Vite dev server with hot reload.
// The web dev server proxies /api and /ws to the server, and the server allows the dev origin
// (PASABOT_ALLOWED_ORIGINS), so the cookie, the socket and the Origin checks behave as in production.
// Data lives in $PASABOT_HOME (default: <repo>/.pasabot, git-ignored). Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const web = fileURLToPath(new URL('..', import.meta.url));
const serverPort = process.env.PASABOT_PORT ?? '7777';
const webPort = process.env.PASABOT_WEB_PORT ?? '5173';
const devOrigins = [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];

const env = {
  ...process.env,
  PASABOT_HOME: process.env.PASABOT_HOME ?? `${repo}.pasabot`,
  PASABOT_PORT: serverPort,
  PASABOT_SITES_PORT: process.env.PASABOT_SITES_PORT ?? String(Number(serverPort) + 1),
  PASABOT_ALLOWED_ORIGINS: [process.env.PASABOT_ALLOWED_ORIGINS, ...devOrigins].filter(Boolean).join(','),
  // the first-run setup link opens the dev web server
  PASABOT_PUBLIC_URL: process.env.PASABOT_PUBLIC_URL ?? devOrigins[0],
  PASABOT_WEB_DIR: '',
  PASABOT_SOURCE: '1',
  PASABOT_DEV_SERVER: `http://127.0.0.1:${serverPort}`,
  PASABOT_WEB_PORT: webPort,
};

const kids = [
  spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'apps/server/src/host/main.ts'], {
    cwd: repo,
    env,
    stdio: 'inherit',
  }),
  spawn(`${web}node_modules/.bin/vite`, [], {
    cwd: web,
    env,
    stdio: 'inherit',
  }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
};
for (const k of kids) k.on('exit', (c) => stop(c ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.stdout.write(
  `\npasabot dev: web http://localhost:${webPort}  ·  server http://127.0.0.1:${serverPort}\n\n`,
);
