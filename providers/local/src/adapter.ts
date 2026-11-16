/**
 * One owner-configured local model endpoint as a ProviderAdapter (`local:<id>`). Two wire protocols: Ollama's own
 * (`/api/tags`, `/api/show`, `/api/chat` as NDJSON) and the OpenAI-compatible one LM Studio, llama.cpp and vLLM speak
 * (`/v1/models`, `/v1/chat/completions` as SSE). Every request goes through safe-net's `fetchLocalModel`, which reaches
 * only this endpoint's own origin (and the run's PasaBot MCP gateway for tool calls).
 *
 * Tools: the run's gateway tools are offered to the model as functions; a call runs through the gateway (where the
 * approval tiers apply) and its result goes back to the model, up to MAX_ROUNDS times. A model that cannot call tools
 * runs in degraded mode: chat only, said once in the turn.
 */
import {
  type ModelInfo,
  type ProviderAdapter,
  type ProviderCaps,
  type ProviderEvent,
  type ProviderId,
  type ProviderStatus,
  type TurnInput,
  withAttachments,
} from '@pasabot/core';
import { fetchLocalModel } from '@pasabot/safe-net';

export type LocalApi = 'ollama' | 'openai';
export interface LocalEndpoint {
  id: string;
  name: string;
  api: LocalApi;
  /** e.g. `http://127.0.0.1:11434` or `http://127.0.0.1:1234/v1` */
  baseUrl: string;
  origin: string;
  scope: 'loopback' | 'lan';
  tools: 'auto' | 'off';
}
export interface LocalModel extends ModelInfo {
  /** true = can call tools; false = chat only (degraded); null = not known until a turn tries */
  tools: boolean | null;
}

/** The degraded-mode line a chat-only turn starts with (also shown on the endpoint card). */
export const TOOLS_OFF_NOTE = 'Tools are off for this model: chat only.';
const MAX_ROUNDS = 8;
const MAX_HISTORY = 40;

export type LocalMsg = Msg;
type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireCall[] }
  | { role: 'tool'; content: string; tool_call_id?: string; name?: string };
interface WireCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: unknown };
}
interface GatewayTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Untrusted text must never close PasaBot's quoted block (ARCHITECTURE 8). */
export const quoteUntrusted = (s: string) =>
  s.replace(/<(?=\s*\/?\s*(?:instructions|earlier-conversation)\b)/gi, '&lt;');

const codeOf = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } })?.code ?? (e as any)?.cause?.code ?? '';
/**
 * Is this error "the endpoint could not be reached at all"? (→ `offline`, W34's fallback trigger.) `ETIMEDOUT` is the
 * connect timeout (an asleep or black-holed LAN/Tailscale box). Only meaningful before the endpoint answered: see
 * `fail()`, which reads a later reset as a crash.
 */
export function isUnreachable(e: unknown): boolean {
  return [
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EHOSTDOWN',
    'ECONNRESET',
    'EADDRNOTAVAIL',
    'ETIMEDOUT',
  ].includes(codeOf(e));
}
/** The endpoint accepted the connection, then sent nothing for `timeoutMs` (reachable, but stuck or very slow). */
export const isIdleTimeout = (e: unknown) => codeOf(e) === 'ESOCKETTIMEDOUT';

/**
 * Where a native session's conversation lives between turns. The module keeps it in its own table, so a restart, an
 * update or a failed turn never silently drops the chat; a bare adapter (tests) keeps it in memory.
 */
export interface LocalHistoryStore {
  get(ref: string): LocalMsg[] | undefined;
  set(ref: string, endpointId: string, history: LocalMsg[]): void;
}
export function memoryHistoryStore(max = 200): LocalHistoryStore {
  const m = new Map<string, LocalMsg[]>();
  return {
    get: (ref) => m.get(ref),
    set(ref, _ep, h) {
      m.delete(ref);
      m.set(ref, h);
      if (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}
/** The history kept for the next turn: the last MAX_HISTORY messages, starting at a user message (never an orphaned
 * tool result or a tool call without its result, which OpenAI-compatible servers refuse). */
export function trimHistory(msgs: LocalMsg[], max = MAX_HISTORY): LocalMsg[] {
  let start = Math.max(0, msgs.length - max);
  while (start < msgs.length && msgs[start]!.role !== 'user') start++;
  // no user message inside the window (one long tool loop): keep from the last user message instead
  if (start >= msgs.length) start = msgs.findLastIndex((m) => m.role === 'user');
  return start < 0 ? [] : msgs.slice(start);
}

export class LocalModelAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  /** chat histories of native sessions (the module's table; in memory for a bare adapter) */
  private readonly sessions: LocalHistoryStore;
  /** models found not to support tools on this endpoint */
  private noTools = new Set<string>();

  constructor(
    private ep: LocalEndpoint,
    private readonly opts: {
      timeoutMs?: number;
      connectTimeoutMs?: number;
      history?: LocalHistoryStore;
    } = {},
  ) {
    this.id = `local:${ep.id}`;
    this.sessions = opts.history ?? memoryHistoryStore();
  }
  get displayName() {
    return this.ep.name;
  }
  get endpoint(): LocalEndpoint {
    return this.ep;
  }
  update(ep: LocalEndpoint) {
    this.ep = ep;
  }

  private url(path: string) {
    // an OpenAI-compatible base usually ends in /v1; Ollama's API paths start at the root
    return `${this.ep.baseUrl}${path}`;
  }
  private fetch(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const timeoutMs = init.timeoutMs ?? this.opts.timeoutMs;
    return fetchLocalModel(this.url(path), {
      allowed: [this.ep.origin],
      method: init.method ?? 'GET',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(this.opts.connectTimeoutMs ? { connectTimeoutMs: this.opts.connectTimeoutMs } : {}),
    });
  }

  async detect(): Promise<ProviderStatus> {
    try {
      const models = await this.models();
      return {
        installed: true,
        signedIn: true,
        version: `${models.length} model${models.length === 1 ? '' : 's'}`,
      };
    } catch (e) {
      // the owner set this endpoint up: when it does not answer it is "not reachable", never "not installed"
      return {
        installed: false,
        signedIn: 'unknown',
        reachable: false,
        hint: isUnreachable(e)
          ? `${this.ep.name} (${this.ep.baseUrl}) is not answering`
          : `${this.ep.name}: ${String((e as Error).message)}`,
        ...(isUnreachable(e)
          ? {
              hintKey: {
                key: 'core:provider.hint.notAnswering',
                params: { name: this.ep.name, url: this.ep.baseUrl },
              },
            }
          : {}),
      };
    }
  }
  capabilities(): ProviderCaps {
    return {
      resume: true,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    };
  }
  async listModels(): Promise<ModelInfo[]> {
    return (await this.models()).map(({ id, label }) => ({ id, ...(label ? { label } : {}) }));
  }

  /**
   * The endpoint's models and whether each can call tools. Throws when the endpoint is unreachable. `timeoutMs`
   * overrides the idle timeout (a Settings probe passes a short one instead of the turn's 120 s).
   */
  async models(o: { timeoutMs?: number } = {}): Promise<LocalModel[]> {
    const t = o.timeoutMs ? { timeoutMs: o.timeoutMs } : {};
    if (this.ep.api === 'ollama') {
      const r = await this.fetch('/api/tags', t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { models?: { name?: string; model?: string }[] };
      const out: LocalModel[] = [];
      for (const m of (j.models ?? []).slice(0, 200)) {
        const id = String(m.name ?? m.model ?? '');
        if (!id) continue;
        out.push({ id, tools: this.toolsFor(id, await this.ollamaTools(id, o.timeoutMs)) });
      }
      return out;
    }
    const r = await this.fetch('/models', t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { id?: string }[] };
    return (j.data ?? [])
      .slice(0, 200)
      .map((m) => String(m.id ?? ''))
      .filter(Boolean)
      .map((id) => ({ id, tools: this.toolsFor(id, null) }));
  }
  private toolsFor(model: string, reported: boolean | null): boolean | null {
    if (this.ep.tools === 'off' || this.noTools.has(model)) return false;
    return reported;
  }
  private async ollamaTools(model: string, timeoutMs?: number): Promise<boolean | null> {
    try {
      const r = await this.fetch('/api/show', {
        method: 'POST',
        body: { model },
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { capabilities?: string[] };
      return Array.isArray(j.capabilities) ? j.capabilities.includes('tools') : null;
    } catch {
      return null;
    }
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    let model = input.model;
    try {
      if (!model) model = (await this.models())[0]?.id;
    } catch (e) {
      yield* this.fail(e, true);
      return;
    }
    if (!model) {
      yield { type: 'error', kind: 'crash', message: `${this.ep.name} has no models` };
      yield { type: 'done', stop: 'error' };
      return;
    }
    const known = input.nativeRef ? this.sessions.get(input.nativeRef) : undefined;
    const ref = known && input.nativeRef ? input.nativeRef : `${this.id}:${input.runId}`;
    const history = known ?? [];
    const msgs: Msg[] = [
      { role: 'system', content: input.systemPrompt },
      ...history,
      { role: 'user', content: this.userText(input, history.length > 0) },
    ];
    let tools: GatewayTool[] = [];
    let degraded = false;
    if (input.tools === 'gateway' && input.mcp.url) {
      if (this.toolsFor(model, null) === false) degraded = true;
      else {
        try {
          tools = await this.gatewayTools(input, signal);
        } catch {
          tools = [];
        }
      }
    }
    if (degraded) yield { type: 'thinking', text: TOOLS_OFF_NOTE };
    // the `session` event comes only after the history is saved (end of a finished turn): a ref the orchestrator keeps
    // is always one this store knows, so a failed or cancelled turn never leaves it resuming an empty conversation
    let usage = { inputTokens: 0, outputTokens: 0 };
    const finals: string[] = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) break;
      let res: Response;
      try {
        res = await this.chat(model, msgs, tools, signal);
        if (res.status === 400 && tools.length) {
          const body = await res.text();
          if (/tool/i.test(body)) {
            // degraded mode: this model cannot call tools; say so and retry chat only
            this.noTools.add(model);
            tools = [];
            yield { type: 'thinking', text: TOOLS_OFF_NOTE };
            res = await this.chat(model, msgs, tools, signal);
          } else res = new Response(body, { status: 400 });
        }
      } catch (e) {
        if (signal.aborted) break;
        // unreachable only on the first request of the turn: later, the endpoint answered before and tools may have
        // run, so a rerun elsewhere would repeat them
        yield* this.fail(e, round === 0);
        return;
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 500);
        const kind =
          res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : 'crash';
        yield { type: 'error', kind, message: `${this.ep.name}: HTTP ${res.status} ${text}`.trim() };
        yield { type: 'done', stop: 'error' };
        return;
      }
      let content = '';
      const calls: WireCall[] = [];
      try {
        for await (const ev of this.ep.api === 'ollama' ? readOllama(res) : readOpenAi(res)) {
          if (ev.delta) {
            content += ev.delta;
            yield { type: 'text.delta', text: ev.delta };
          }
          if (ev.calls) calls.push(...ev.calls);
          if (ev.usage) {
            usage = {
              inputTokens: usage.inputTokens + ev.usage.input,
              outputTokens: usage.outputTokens + ev.usage.output,
            };
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        // the endpoint answered and then dropped the stream (a model running out of memory, a server restart): crash
        yield* this.fail(e, false);
        return;
      }
      if (content) finals.push(content);
      msgs.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length || !tools.length) break;
      for (const [i, c] of calls.entries()) {
        const id = c.id ?? `${input.runId}-${round}-${i}`;
        const args = parseArgs(c.function.arguments);
        yield { type: 'tool.call', id, name: c.function.name, input: args };
        const r = await this.callGateway(input, c.function.name, args, signal);
        yield { type: 'tool.result', id, ok: r.ok, summary: r.text.slice(0, 500) };
        msgs.push({
          role: 'tool',
          content: r.text,
          ...(this.ep.api === 'openai' ? { tool_call_id: id } : { name: c.function.name }),
        });
      }
    }
    if (signal.aborted) {
      yield { type: 'done', stop: 'cancelled' };
      return;
    }
    // keep the conversation for the next turn of this native session (system prompt excluded, capped)
    let saved = true;
    try {
      this.sessions.set(ref, this.ep.id, trimHistory(msgs.slice(1)));
    } catch {
      saved = false; // not resumable: the orchestrator reseeds the next turn from its own transcript instead
    }
    if (saved) yield { type: 'session', nativeRef: ref };
    yield { type: 'text.final', text: finals.join('\n\n') };
    yield { type: 'usage', ...usage };
    yield { type: 'done', stop: 'end' };
  }

  /**
   * `offline` only when `beforeAnswer` (nothing of this turn reached the endpoint yet: the model lookup or the first
   * chat request), so the orchestrator's fallback or hold never reruns a turn whose tools already ran. A socket that
   * connected and then went quiet is a `timeout`; anything else a `crash`.
   */
  private *fail(e: unknown, beforeAnswer: boolean): Generator<ProviderEvent> {
    const msg = `${this.ep.name}: ${(e as Error).message}`;
    yield beforeAnswer && isUnreachable(e)
      ? { type: 'error', kind: 'offline', message: `${this.ep.name} (${this.ep.baseUrl}) is not answering` }
      : isIdleTimeout(e)
        ? { type: 'error', kind: 'timeout', message: msg }
        : { type: 'error', kind: 'crash', message: msg };
    yield { type: 'done', stop: 'error' };
  }

  /** The user's text as quoted data; a new session gets the orchestrator's reseed ahead of it. */
  private userText(input: TurnInput, continuing: boolean): string {
    const text = quoteUntrusted(withAttachments(input.user.text, input.user.attachments));
    if (continuing || !input.seed) return text;
    const recent = input.seed.recent.map((m) => `${m.authorKind}: ${quoteUntrusted(m.body)}`).join('\n');
    const seed = `${quoteUntrusted(input.seed.summary)}${recent ? `\n\n${recent}` : ''}`;
    return `<earlier-conversation>\n${seed}\n</earlier-conversation>\n\n${text}`;
  }

  private chat(model: string, messages: Msg[], tools: GatewayTool[], signal: AbortSignal) {
    const fns = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
    const wire = messages.map((m) =>
      m.role === 'assistant' && m.tool_calls && this.ep.api === 'openai'
        ? {
            ...m,
            tool_calls: m.tool_calls.map((c, i) => ({
              id: c.id ?? `call_${i}`,
              type: 'function',
              function: {
                name: c.function.name,
                arguments:
                  typeof c.function.arguments === 'string'
                    ? c.function.arguments
                    : JSON.stringify(c.function.arguments ?? {}),
              },
            })),
          }
        : m,
    );
    const body =
      this.ep.api === 'ollama'
        ? { model, messages: wire, stream: true, ...(fns.length ? { tools: fns } : {}) }
        : {
            model,
            messages: wire,
            stream: true,
            stream_options: { include_usage: true },
            ...(fns.length ? { tools: fns } : {}),
          };
    return this.fetch(this.ep.api === 'ollama' ? '/api/chat' : '/chat/completions', {
      method: 'POST',
      body,
      signal,
    });
  }

  // ---------- the run's PasaBot MCP gateway (loopback, the run bearer) ----------
  private async rpc(input: TurnInput, method: string, params: unknown, signal: AbortSignal) {
    const r = await fetchLocalModel(input.mcp.url, {
      allowed: [new URL(input.mcp.url).origin],
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await r.json()) as { result?: any; error?: { message?: string } };
  }
  private async gatewayTools(input: TurnInput, signal: AbortSignal): Promise<GatewayTool[]> {
    const j = await this.rpc(input, 'tools/list', {}, signal);
    const list = (j.result?.tools ?? []) as GatewayTool[];
    return list.filter((t) => typeof t?.name === 'string').slice(0, 128);
  }
  private async callGateway(
    input: TurnInput,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; text: string }> {
    try {
      const j = await this.rpc(input, 'tools/call', { name, arguments: args ?? {} }, signal);
      if (j.error) return { ok: false, text: j.error.message ?? 'tool error' };
      const text = (j.result?.content ?? [])
        .map((c: { text?: string }) => c?.text ?? '')
        .join('\n')
        .slice(0, 20_000);
      return { ok: !j.result?.isError, text };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }
}

function parseArgs(a: unknown): unknown {
  if (typeof a !== 'string') return a ?? {};
  try {
    return JSON.parse(a || '{}');
  } catch {
    return {};
  }
}

interface StreamPiece {
  delta?: string;
  calls?: WireCall[];
  usage?: { input: number; output: number };
}

async function* lines(res: Response): AsyncIterable<string> {
  if (!res.body) return;
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
      i = buf.indexOf('\n');
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** Ollama `/api/chat` with `stream: true`: one JSON object per line. */
export async function* readOllama(res: Response): AsyncIterable<StreamPiece> {
  for await (const line of lines(res)) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.error) throw new Error(String(j.error));
    const piece: StreamPiece = {};
    if (typeof j.message?.content === 'string' && j.message.content) piece.delta = j.message.content;
    if (Array.isArray(j.message?.tool_calls) && j.message.tool_calls.length)
      piece.calls = j.message.tool_calls.filter((c: any) => typeof c?.function?.name === 'string');
    if (j.done) piece.usage = { input: Number(j.prompt_eval_count) || 0, output: Number(j.eval_count) || 0 };
    yield piece;
  }
}

/** OpenAI-compatible `/chat/completions` with `stream: true`: SSE `data:` lines; tool call arguments arrive in parts. */
export async function* readOpenAi(res: Response): AsyncIterable<StreamPiece> {
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  for await (const line of lines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new Error(String(j.error.message ?? j.error));
    const d = j.choices?.[0]?.delta;
    const piece: StreamPiece = {};
    if (typeof d?.content === 'string' && d.content) piece.delta = d.content;
    for (const tc of Array.isArray(d?.tool_calls) ? d.tool_calls : []) {
      const k = Number(tc.index ?? 0);
      const cur = calls.get(k) ?? { name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(k, cur);
    }
    if (j.usage)
      piece.usage = {
        input: Number(j.usage.prompt_tokens) || 0,
        output: Number(j.usage.completion_tokens) || 0,
      };
    if (piece.delta || piece.usage) yield piece;
  }
  const done = [...calls.values()].filter((c) => c.name);
  if (done.length)
    yield {
      calls: done.map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      })),
    };
}
