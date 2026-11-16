#!/usr/bin/env node
// Replays a stream-json transcript the way `claude -p --output-format stream-json --input-format stream-json`
// prints it. Test-only stand-in for the real CLI (no network, no account).
//   FAKE_CLAUDE_FIXTURE  path of the .jsonl to replay (default: stream.jsonl next to this file)
//   FAKE_CLAUDE_DELAY_MS delay between lines (default 5)
// A first user message "READ:<path>" instead tries to read that file and reports the outcome (sandbox tests);
// "FAIL:<text>" ends with an error result carrying <text>.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.0'} (Claude Code)\n`);
  process.exit(0);
}
// `claude auth status --json`: FAKE_CLAUDE_AUTH = in (default) | out | garbage
if (argv[0] === 'auth' && argv[1] === 'status') {
  const a = process.env.FAKE_CLAUDE_AUTH ?? 'in';
  if (a === 'garbage') process.stdout.write('not json\n');
  else process.stdout.write(`${JSON.stringify({ loggedIn: a === 'in', authMethod: 'none' })}\n`);
  process.exit(a === 'in' ? 0 : 1);
}
const resumeAt = argv.indexOf('--resume');
const session = resumeAt >= 0 ? argv[resumeAt + 1] : `sess-${process.pid}-${Date.now()}`;
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 5);
const fixture = process.env.FAKE_CLAUDE_FIXTURE ?? fileURLToPath(new URL('./stream.jsonl', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const first = await lines.next();
const text = first.done ? '' : (JSON.parse(first.value).message?.content?.[0]?.text ?? '');

if (text.startsWith('READ:')) {
  const path = text.slice(5);
  let result;
  try {
    readFileSync(path);
    result = `READ_OK ${path}`;
  } catch (e) {
    result = `READ_DENIED ${e.code ?? e.message}`;
  }
  out({ type: 'system', subtype: 'init', session_id: session });
  out({
    type: 'assistant',
    message: { content: [{ type: 'text', text: result }] },
    parent_tool_use_id: null,
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: session,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
} else if (text.startsWith('FAIL:')) {
  out({ type: 'system', subtype: 'init', session_id: session });
  out({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: text.slice(5),
    session_id: session,
    usage: {},
  });
} else {
  for (const raw of readFileSync(fixture, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    await sleep(delay);
    process.stdout.write(`${raw.replaceAll('SESSION', session)}\n`);
  }
}
// like the real CLI in stream-json input mode: stay until stdin closes
for await (const _ of lines) {
  /* steering messages would be read here */
}
process.exit(0);
