#!/usr/bin/env node
// Stand-in for `npm install --prefix <dir> ... -- <pkg>@<ver>` (tests only, no network): records its argv and lays
// out a package the way npm does: the ACP echo agent is copied into `<dir>/node_modules/@example/acp-agent/` and
// `<dir>/node_modules/.bin/example-acp` is a relative symlink to it, so the agent's code lives inside the install
// folder (as a real npm agent's does). FAKE_NPM_FAIL=1 fails.
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (process.env.FAKE_NPM_FAIL) {
  process.stderr.write('npm ERR! 404 Not Found\n');
  process.exit(1);
}
const dir = argv[argv.indexOf('--prefix') + 1];
const pkg = join(dir, 'node_modules', '@example', 'acp-agent');
const bin = join(dir, 'node_modules', '.bin');
mkdirSync(pkg, { recursive: true });
mkdirSync(bin, { recursive: true });
const echo = fileURLToPath(
  new URL('../../../../providers/acp/src/__fixtures__/echo-agent.mjs', import.meta.url),
);
copyFileSync(echo, join(pkg, 'agent.mjs'));
chmodSync(join(pkg, 'agent.mjs'), 0o755);
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@example/acp-agent', type: 'module' }));
symlinkSync('../@example/acp-agent/agent.mjs', join(bin, 'example-acp'));
writeFileSync(join(dir, 'argv.json'), JSON.stringify(argv));
