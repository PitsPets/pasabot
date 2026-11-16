#!/usr/bin/env node
// Replays a JSON-lines transcript the way `opencode run --format json` prints it. Test-only stand-in for the real
// CLI (no network, no account). Written for PasaBot from the documented event shapes.
//   FAKE_OPENCODE_FIXTURE  path of the .jsonl to replay (default: stream.jsonl next to this file)
//   FAKE_OPENCODE_DELAY_MS delay between lines (default 5)
// The prompt is read from stdin. "FAIL:<text>" prints an error event and exits 1; "AUTHFAIL" prints a provider
// auth error; "ECHO" answers with what the CLI saw (argv, the per-turn config file and its mode, the inline
// config, the prompt) and the effective config it would run with; "CRASH" writes to stderr and exits 3; "SILENT"
// prints nothing and exits 0.
// The effective config models OpenCode's documented layering, lowest to highest: global
// ($XDG_CONFIG_HOME/opencode/opencode.json), OPENCODE_CONFIG, project (opencode.json and .opencode/opencode.json
// in the cwd, skipped when OPENCODE_DISABLE_PROJECT_CONFIG is set), OPENCODE_CONFIG_CONTENT. Objects merge deeply;
// arrays are concatenated (the worst case for PasaBot: nothing a lower layer adds is dropped).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('0.15.2\n');
  process.exit(0);
}
// OpenCode opens its database in its data dir ($XDG_DATA_HOME/opencode, else ~/.local/share/opencode): a database
// file that reads "BROKEN" stands for one a newer OpenCode wrote, which this CLI fails on, the way the real one did
const dataDir = join(
  process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), '.local', 'share'),
  'opencode',
);
const dbFile = join(dataDir, 'opencode.db');
if (existsSync(dbFile) && readFileSync(dbFile, 'utf8') === 'BROKEN') {
  process.stderr.write('Error: Database is not empty and has no session table\n');
  process.exit(1);
}
if (argv[0] === 'models') {
  // FAKE_OPENCODE_MODELS_LOG: where the model list was run from (its data, state and config homes)
  if (process.env.FAKE_OPENCODE_MODELS_LOG)
    writeFileSync(
      process.env.FAKE_OPENCODE_MODELS_LOG,
      JSON.stringify({
        xdgData: process.env.XDG_DATA_HOME ?? null,
        xdgState: process.env.XDG_STATE_HOME ?? null,
        xdgConfig: process.env.XDG_CONFIG_HOME ?? null,
        xdgCache: process.env.XDG_CACHE_HOME ?? null,
        disableClaude: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
      }),
    );
  process.stdout.write(
    'anthropic/claude-sonnet-4-5\nopenai/gpt-5\nopencode/glm-5.3-flash-free\n\nsome banner line\n',
  );
  process.exit(0);
}
const sessAt = argv.indexOf('--session');
const session = sessAt >= 0 ? argv[sessAt + 1] : `ses_${process.pid}${Date.now()}`;
const delay = Number(process.env.FAKE_OPENCODE_DELAY_MS ?? 5);
const fixture =
  process.env.FAKE_OPENCODE_FIXTURE ?? fileURLToPath(new URL('./stream.jsonl', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const text = prompt.split('\n\n').at(-1) ?? '';

if (text.startsWith('FAIL:')) {
  out({ type: 'error', sessionID: session, error: { name: 'APIError', data: { message: text.slice(5) } } });
  process.exit(1);
} else if (text === 'AUTHFAIL') {
  out({
    type: 'error',
    sessionID: session,
    error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'no credentials' } },
  });
  process.exit(1);
} else if (text === 'CRASH') {
  process.stderr.write('Error: unexpected EOF\n');
  process.exit(3);
} else if (text === 'SILENT') {
  process.exit(0);
} else if (text === 'ECHO') {
  const path = process.env.OPENCODE_CONFIG;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
  const instructions = readFileSync(inline.instructions[0], 'utf8');
  const merge = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
      return out;
    }
    return b === undefined ? a : b;
  };
  const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config');
  const layers = [load(join(configHome, 'opencode', 'opencode.json')), config];
  if (!process.env.OPENCODE_DISABLE_PROJECT_CONFIG)
    layers.push(
      load(join(process.cwd(), 'opencode.json')),
      load(join(process.cwd(), '.opencode', 'opencode.json')),
    );
  layers.push(inline);
  const effective = layers.reduce((acc, l) => merge(acc, l), {});
  const seen = JSON.stringify({
    argv,
    configPath: path,
    configMode: statSync(path).mode & 0o777,
    config,
    inline,
    effective,
    instructions,
    prompt,
    xdgData: process.env.XDG_DATA_HOME ?? null,
    xdgConfig: process.env.XDG_CONFIG_HOME ?? null,
    xdgState: process.env.XDG_STATE_HOME ?? null,
    xdgCache: process.env.XDG_CACHE_HOME ?? null,
    // the sign-in OpenCode would read from its data dir (`opencode auth login`)
    auth: existsSync(join(dataDir, 'auth.json')) ? readFileSync(join(dataDir, 'auth.json'), 'utf8') : null,
    disableProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
    configDir: process.env.OPENCODE_CONFIG_DIR ?? null,
    // the switches that keep the user's ~/.claude/CLAUDE.md, ~/.claude/skills and external skills out
    disableClaude: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k.startsWith('OPENCODE_DISABLE_CLAUDE') || k === 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      ),
    ),
  });
  out({ type: 'text', sessionID: session, part: { type: 'text', text: seen } });
} else {
  for (const raw of readFileSync(fixture, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    await sleep(delay);
    process.stdout.write(`${raw.replaceAll('SESSION', session)}\n`);
  }
}
process.exit(0);
