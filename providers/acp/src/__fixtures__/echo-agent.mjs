#!/usr/bin/env node
// A tiny Agent Client Protocol agent for tests (no network, no account). Written for PasaBot from the public
// protocol description: JSON-RPC 2.0, one object per line on stdio.
//   ACP_FIXTURE      a .jsonl of `session/update` payloads to replay for an ordinary prompt (SESSION is replaced)
//   ACP_ECHO_NO_LOAD set: do not offer `loadSession`
//   ACP_ECHO_NO_HTTP set: do not offer HTTP MCP servers
// The user text is the last paragraph of the prompt. "ECHO" answers with what the agent saw; "PERMIT" asks for a
// permission and reports the outcome; "FS" calls fs/read_text_file and reports the error; "FAIL:<text>" answers
// the prompt with a JSON-RPC error; "AUTH" answers with ACP's auth-required error; "CRASH" dies without an answer;
// "SLOW" streams until `session/cancel`; "REFUSE" ends with stopReason refusal.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('acp-echo 1.2.3\n');
  process.exit(0);
}
const delay = Number(process.env.ACP_ECHO_DELAY_MS ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sessions = new Map();
let cancelled = null;
let n = 0;

async function prompt(id, p) {
  const s = sessions.get(p.sessionId) ?? { mcpServers: [], cwd: process.cwd() };
  const full = (p.prompt ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  const text = full.split('\n\n').at(-1) ?? '';
  const sid = p.sessionId;
  if (text.startsWith('FAIL:')) return send({ id, error: { code: -32603, message: text.slice(5) } });
  if (text === 'AUTH') return send({ id, error: { code: -32000, message: 'Authentication required' } });
  if (text === 'CRASH') {
    process.stderr.write('agent panicked: boom\n');
    process.exit(3);
  }
  if (text === 'REFUSE') return send({ id, result: { stopReason: 'refusal' } });
  if (text === 'ECHO') {
    chunk(
      sid,
      JSON.stringify({ argv, prompt: full, mcpServers: s.mcpServers, cwd: s.cwd, loaded: !!s.loaded }),
    );
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text === 'PERMIT') {
    const r = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'call_p',
        title: 'Edit notes.md',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: `${s.cwd}/notes.md` }],
      },
      options: [
        { optionId: 'yes-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const o = r.result?.outcome;
    chunk(sid, `outcome:${o?.outcome === 'selected' ? o.optionId : 'cancelled'}`);
    return send({ id, result: { stopReason: cancelled === sid ? 'cancelled' : 'end_turn' } });
  }
  if (text === 'GATEWAY') {
    // asks to call a tool on the client's `pasabot` MCP server, the way CLIs ask for any MCP tool (kind other)
    const r = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'call_gw',
        title: 'memory_search (pasabot MCP Server)',
        kind: 'other',
        status: 'pending',
        rawInput: { query: 'notes' },
      },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const o = r.result?.outcome;
    chunk(sid, `outcome:${o?.outcome === 'selected' ? o.optionId : 'cancelled'}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text === 'FS') {
    const r = await ask('fs/read_text_file', { sessionId: sid, path: '/etc/hosts' });
    chunk(sid, `fs:${r.error ? r.error.code : 'allowed'}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text === 'SLOW') {
    for (let i = 0; cancelled !== sid && i < 2000; i++) {
      chunk(sid, '.');
      await sleep(20);
    }
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (process.env.ACP_FIXTURE) {
    for (const raw of readFileSync(process.env.ACP_FIXTURE, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      await sleep(delay);
      if (cancelled === sid) return send({ id, result: { stopReason: 'cancelled' } });
      update(sid, JSON.parse(raw.replaceAll('SESSION', sid)));
    }
    return send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 7 } } });
  }
  await sleep(delay);
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'echoing' } });
  update(sid, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    title: 'Read input',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'input.txt' },
  });
  update(sid, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  });
  chunk(sid, 'echo: ');
  await sleep(delay);
  chunk(sid, text);
  send({
    id,
    result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, cachedReadTokens: 1 } },
  });
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    continue;
  }
  switch (m.method) {
    case 'initialize':
      send({
        id: m.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: !process.env.ACP_ECHO_NO_LOAD,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: !process.env.ACP_ECHO_NO_HTTP, sse: false },
          },
          authMethods: [],
        },
      });
      break;
    case 'session/new': {
      const sessionId = `sess-${process.pid}-${n++}`;
      sessions.set(sessionId, { mcpServers: m.params.mcpServers ?? [], cwd: m.params.cwd });
      send({ id: m.id, result: { sessionId } });
      break;
    }
    case 'session/load':
      sessions.set(m.params.sessionId, {
        mcpServers: m.params.mcpServers ?? [],
        cwd: m.params.cwd,
        loaded: true,
      });
      // a load replays the history as updates before answering
      chunk(m.params.sessionId, 'OLD HISTORY');
      send({ id: m.id, result: null });
      break;
    case 'session/prompt':
      void prompt(m.id, m.params);
      break;
    case 'session/cancel':
      cancelled = m.params.sessionId;
      break;
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}
