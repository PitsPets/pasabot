/**
 * A small MCP client for external servers: stdio (newline-delimited JSON-RPC over a child process started without
 * a shell and with a minimal environment) and streamable HTTP (through safe-net only). One session per operation:
 * open, initialize, do the work, close.
 */
import { spawn } from 'node:child_process';
import { detachedGroup, killTree, resolveForSpawn, type SafeNet, windowsEnv } from '@pasabot/core';

export const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE = 4 * 1024 * 1024;

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ResolvedServer {
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  /** final environment additions (secrets already resolved) */
  env?: Record<string, string>;
  /** final request headers (secrets already resolved) */
  headers?: Record<string, string>;
  allowHosts?: string[];
}

export interface McpSession {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

type Rpc = (method: string, params?: unknown) => Promise<unknown>;

async function initialize(rpc: Rpc, notify: (method: string) => Promise<void>) {
  await rpc('initialize', {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pasabot', version: '0.0.0' },
  });
  await notify('notifications/initialized');
}

function sessionOf(rpc: Rpc, close: () => Promise<void>): McpSession {
  return {
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = (await rpc('tools/list', cursor ? { cursor } : {})) as {
          tools?: McpToolInfo[];
          nextCursor?: string;
        };
        for (const t of r?.tools ?? []) if (t && typeof t.name === 'string') out.push(t);
        if (!r?.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    },
    callTool: (name, args) => rpc('tools/call', { name, arguments: args }),
    close,
  };
}

/**
 * Set on every stdio server, after its own env, so no server or connector manifest can turn them off. The package
 * launchers a connector runs through (`npx`, `uvx`, `pnpm dlx`) pin only the top-level package and resolve its
 * dependencies on a cache miss; these keep that resolution from running any package's install scripts (npm, pnpm)
 * or building a source distribution (uv), which is arbitrary code run on the PasaBot host before the server starts.
 */
export const LAUNCHER_GUARD_ENV: Readonly<Record<string, string>> = Object.freeze({
  npm_config_ignore_scripts: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  UV_NO_BUILD: '1',
});

/** npm reads its env settings case-insensitively and with `-` or `_`, so an override is matched the same way. */
const guardKey = (k: string) => k.toLowerCase().replace(/-/g, '_');
const GUARDED = new Set(Object.keys(LAUNCHER_GUARD_ENV).map(guardKey));

/** The environment a stdio server starts with: never the server's own (vault passphrase, tokens). */
export function stdioEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
  // Windows: SystemRoot, TEMP, APPDATA (npx's cache and prefix), PATHEXT and the rest a program needs to start
  const env: Record<string, string> = { ...windowsEnv() };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(extra)) if (!GUARDED.has(guardKey(k))) env[k] = v;
  return { ...env, ...LAUNCHER_GUARD_ENV };
}

function openStdio(s: ResolvedServer, timeoutMs: number, signal?: AbortSignal): Promise<McpSession> {
  if (!s.command) throw new McpClientError('no command');
  const env = stdioEnv(s.env);
  // Windows: `npx` is `npx.cmd`, which cannot start without a shell: its real script runs on node instead
  let target: { cmd: string; args: string[] };
  try {
    target = resolveForSpawn(s.command, s.args ?? [], env.PATH ?? process.env.Path);
  } catch (e) {
    throw new McpClientError(`could not start: ${(e as Error).message}`);
  }
  const child = spawn(target.cmd, target.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: detachedGroup(),
    windowsHide: true,
  });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let buf = '';
  let dead: Error | null = null;
  const failAll = (e: Error) => {
    dead = dead ?? e;
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  };
  child.stderr.on('data', () => {}); // drained, never logged (it may echo secrets)
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) {
      failAll(new McpClientError('server sent an oversized message'));
      kill();
      return;
    }
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue; // server notifications/requests are ignored
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new McpClientError(String(msg.error.message ?? 'error')));
      else p.resolve(msg.result);
    }
  });
  // the whole tree: npx/uvx start the real server as a grandchild (Windows: taskkill /T, see killTree)
  const kill = () => {
    if (child.pid) killTree(child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  };
  child.on('error', (e) => failAll(new McpClientError(`could not start: ${e.message}`)));
  child.on('exit', (code) => failAll(new McpClientError(`server exited (${code})`)));
  const onAbort = () => {
    failAll(new McpClientError('aborted'));
    kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const write = (o: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (dead) return reject(dead);
      child.stdin.write(`${JSON.stringify(o)}\n`, (e) => (e ? reject(e) : resolve()));
    });
  const rpc: Rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpClientError(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch((e) => {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  const close = async () => {
    signal?.removeEventListener('abort', onAbort);
    try {
      child.stdin.end();
    } catch {}
    kill();
  };
  return initialize(rpc, (method) => write({ jsonrpc: '2.0', method })).then(
    () => sessionOf(rpc, close),
    async (e) => {
      await close();
      throw e;
    },
  );
}

/** The JSON-RPC answer with this id from a JSON body or a `text/event-stream` body. */
function answerFrom(text: string, contentType: string, id: number): { result?: unknown; error?: any } {
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {}
    }
  } else {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      throw new McpClientError('server answered with invalid JSON');
    }
  }
  for (const c of candidates.flat()) {
    const m = c as { id?: unknown; result?: unknown; error?: unknown };
    if (m && m.id === id) return m as { result?: unknown; error?: any };
  }
  throw new McpClientError('server sent no answer');
}

async function openHttp(
  s: ResolvedServer,
  net: SafeNet,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<McpSession> {
  if (!s.url) throw new McpClientError('no url');
  const url = s.url;
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (body: unknown) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': CLIENT_PROTOCOL_VERSION,
      ...(s.headers ?? {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
    const sig = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const r = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: sig,
      allowHosts: s.allowHosts ?? [],
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return r;
  };
  const rpc: Rpc = async (method, params) => {
    const id = nextId++;
    const r = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    if (r.status === 401 || r.status === 403) throw new McpClientError(`server refused (${r.status})`);
    if (!r.ok) throw new McpClientError(`server answered ${r.status}`);
    const m = answerFrom(await r.text(), r.headers.get('content-type') ?? '', id);
    if (m.error) throw new McpClientError(String(m.error?.message ?? 'error'));
    return m.result;
  };
  await initialize(rpc, async (method) => {
    await post({ jsonrpc: '2.0', method }).catch(() => {});
  });
  return sessionOf(rpc, async () => {});
}

export function openSession(
  s: ResolvedServer,
  o: { net: SafeNet; timeoutMs?: number; signal?: AbortSignal },
): Promise<McpSession> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  return s.transport === 'stdio'
    ? openStdio(s, timeoutMs, o.signal)
    : openHttp(s, o.net, timeoutMs, o.signal);
}

export async function withSession<T>(
  s: ResolvedServer,
  o: { net: SafeNet; timeoutMs?: number; signal?: AbortSignal },
  fn: (session: McpSession) => Promise<T>,
): Promise<T> {
  const session = await openSession(s, o);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
