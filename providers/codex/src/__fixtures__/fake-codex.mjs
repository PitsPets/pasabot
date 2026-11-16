#!/usr/bin/env node
// Replays a JSONL transcript the way `codex exec --json` prints it. Test-only stand-in for the real CLI
// (no network, no account). Written for PasaBot from the documented event shapes.
//   FAKE_CODEX_FIXTURE  path of the .jsonl to replay (default: stream.jsonl next to this file)
//   FAKE_CODEX_DELAY_MS delay between lines (default 5)
// The prompt is read from stdin (`-`). A prompt starting with "FAIL:<text>" ends with an error + turn.failed;
// "ECHO" answers with what the CLI saw (argv after `exec`, the bearer env var's presence, the prompt);
// "CRASH" writes to stderr and exits 3 without a result.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.167.0\n');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT) {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
const resumeAt = argv.indexOf('resume');
const thread = resumeAt >= 0 ? argv[resumeAt + 1] : `0199-${process.pid}-${Date.now()}`;
const delay = Number(process.env.FAKE_CODEX_DELAY_MS ?? 5);
const fixture = process.env.FAKE_CODEX_FIXTURE ?? fileURLToPath(new URL('./stream.jsonl', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
// the instructions lead the first prompt of a session; the user text is the last paragraph
const text = prompt.split('\n\n').at(-1) ?? '';

if (text.startsWith('FAIL:')) {
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  out({ type: 'error', message: text.slice(5) });
  out({ type: 'turn.failed', error: { message: text.slice(5) } });
} else if (text === 'CRASH') {
  process.stderr.write('thread panicked: boom\n');
  process.exit(3);
} else if (text === 'ECHO') {
  const seen = JSON.stringify({
    argv,
    bearer: process.env.PASABOT_MCP_TOKEN ?? null,
    prompt,
    codexHome: process.env.CODEX_HOME ?? null,
  });
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: seen } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
} else {
  for (const raw of readFileSync(fixture, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    await sleep(delay);
    process.stdout.write(`${raw.replaceAll('THREAD', thread)}\n`);
  }
}
process.exit(0);
