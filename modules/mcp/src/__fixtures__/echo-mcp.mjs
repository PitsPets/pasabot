#!/usr/bin/env node
// A tiny stdio MCP server for tests (written for PasaBot): tools `echo_text`, `add_numbers` and `read_env`.
// ECHO_EXTRA=1 adds `send_message` and `pay_order` tools; ECHO_DESTRUCTIVE (see below) adds `archive_box`; ECHO_FLAKY_MARK=<file> makes the first start fail (a transient error).
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.ECHO_FLAKY_MARK && !existsSync(process.env.ECHO_FLAKY_MARK)) {
  writeFileSync(process.env.ECHO_FLAKY_MARK, 'started once');
  process.exit(1);
}

const tools = [
  {
    name: 'echo_text',
    description: 'Echo the given text back, upper-cased.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'read_env',
    description: 'Read one environment variable of this server process.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];
const extra = process.env.ECHO_EXTRA === '1';
if (extra)
  tools.push(
    {
      name: 'send_message',
      description: 'Send a message to someone.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' } },
        required: ['to', 'text'],
      },
    },
    {
      name: 'pay_order',
      description: 'Pay a merchant.',
      inputSchema: {
        type: 'object',
        properties: {
          merchant: { type: 'string' },
          amount: { type: 'string' },
          currency: { type: 'string' },
          card: { type: 'string' },
        },
        required: ['merchant', 'amount'],
      },
    },
  );
// ECHO_DESTRUCTIVE=1 adds `archive_box`, a neutrally named tool the server marks destructive; =0 lists the same tool
// without the mark (a server that later drops the tag)
if (process.env.ECHO_DESTRUCTIVE)
  tools.push({
    name: 'archive_box',
    description: 'Put a box away.',
    inputSchema: { type: 'object', properties: { box: { type: 'string' } }, required: ['box'] },
    ...(process.env.ECHO_DESTRUCTIVE === '1' ? { annotations: { destructiveHint: true } } : {}),
  });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp', version: '1.0.0' },
      });
    case 'tools/list':
      return ok({ tools });
    case 'tools/call': {
      const a = m.params?.arguments ?? {};
      if (m.params?.name === 'echo_text') return ok(text(String(a.text ?? '').toUpperCase()));
      if (m.params?.name === 'add_numbers') return ok(text(String(Number(a.a) + Number(a.b))));
      if (extra && m.params?.name === 'send_message')
        return ok(text(`sent to ${a.to}: ${String(a.text ?? '').toUpperCase()}`));
      if (extra && m.params?.name === 'pay_order') return ok(text(`paid ${a.merchant}`));
      if (process.env.ECHO_DESTRUCTIVE && m.params?.name === 'archive_box')
        return ok(text(`archived ${a.box}`));
      if (m.params?.name === 'read_env') return ok(text(process.env[String(a.name)] ?? '(unset)'));
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
    }
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
