/**
 * Stub local model servers on 127.0.0.1 port 0, speaking just enough of Ollama's API and the OpenAI-compatible API
 * for the W34 proofs. Models: `chatty` (tools), `plain` (no tools: a request with `tools` answers 400 like Ollama
 * does). A user text `call <tool> <json>` makes a tools-capable model call that tool once; after a tool result it
 * answers `tool said: <result>`. Ollama: a user text starting `hang` streams one part and never finishes (until the
 * client goes away). Anything else is echoed as `local: <text>`, streamed in two parts.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Stub {
  url: string;
  origin: string;
  requests: { path: string; body: any }[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => resolve(b));
  });

type Msg = { role: string; content?: string };
/** What the model "decides": a tool call, or text. */
function decide(messages: Msg[]): { call?: { name: string; args: unknown }; text?: string } {
  const last = messages[messages.length - 1]!;
  if (last.role === 'tool') return { text: `tool said: ${last.content}` };
  const user = String(last.content ?? '');
  const m = user.match(/^call (\S+) (\{.*\})$/s);
  if (m) return { call: { name: m[1]!, args: JSON.parse(m[2]!) } };
  return { text: `local: ${user}` };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const closer = (server: Server) => () =>
  new Promise<void>((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });

/** `models`: the names `/api/tags` lists (default `chatty:latest`, `plain:latest`; `[]` = an Ollama with no model) */
export async function ollamaStub(o: { models?: string[] } = {}): Promise<Stub> {
  const tags = o.models ?? ['chatty:latest', 'plain:latest'];
  const requests: Stub['requests'] = [];
  const server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url ?? '', body });
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ models: tags.map((name) => ({ name })) }));
    }
    if (req.url === '/api/show') {
      res.setHeader('content-type', 'application/json');
      const caps = body?.model === 'plain:latest' ? ['completion'] : ['completion', 'tools'];
      return res.end(JSON.stringify({ capabilities: caps }));
    }
    if (req.url === '/api/chat') {
      if (body.tools && body.model === 'plain:latest') {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({ error: 'registry.ollama.ai/library/plain:latest does not support tools' }),
        );
      }
      res.setHeader('content-type', 'application/x-ndjson');
      const d = decide(body.messages);
      if (d.text?.startsWith('local: hang')) {
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: 'thinking' }, done: false })}\n`,
        );
        return; // never ends; the client's abort (or the stub's close) ends it
      }
      if (d.call) {
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: d.call.name, arguments: d.call.args } }] }, done: false })}\n`,
        );
      } else {
        const text = d.text!;
        const half = Math.ceil(text.length / 2);
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: text.slice(0, half) }, done: false })}\n`,
        );
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: text.slice(half) }, done: false })}\n`,
        );
      }
      return res.end(
        `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 11, eval_count: 7 })}\n`,
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const url = await listen(server);
  return { url, origin: url, requests, close: closer(server) };
}

export async function openAiStub(): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url ?? '', body });
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'chatty' }, { id: 'plain' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      if (body.tools && body.model === 'plain') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'This model does not support tools' } }));
      }
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const d = decide(body.messages);
      if (d.call) {
        const args = JSON.stringify(d.call.args);
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: d.call.name, arguments: '' } }],
              },
            },
          ],
        });
        send({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 3) } }] } }],
        });
        send({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(3) } }] } }],
        });
      } else {
        const text = d.text!;
        const half = Math.ceil(text.length / 2);
        send({ choices: [{ delta: { content: text.slice(0, half) } }] });
        send({ choices: [{ delta: { content: text.slice(half) } }] });
      }
      send({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 5 } });
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const origin = await listen(server);
  return { url: `${origin}/v1`, origin, requests, close: closer(server) };
}

/** A loopback address with nothing listening (the "primary is down" case). */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  const url = await listen(server);
  await closer(server)();
  return url;
}
