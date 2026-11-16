/**
 * @pasabot/testkit — FakeProvider (re-export), temp server boot, token helpers and contract suites.
 * Tests use port 0 on 127.0.0.1 and a temp $PASABOT_HOME; nothing here touches the network or real CLIs.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProviderAdapter,
  type ProviderEvent,
  providerCapsSchema,
  providerEventSchema,
  providerStatusSchema,
  type TurnInput,
  ulid,
} from '@pasabot/core';
import type { AgentDTO } from '@pasabot/protocol';
import { hashToken, type PasaBotServer, type ServerOptions, startServer } from '@pasabot/server';
import { describe, expect, it } from 'vitest';

export { echoScript, FakeProvider, type Script, type ScriptStep } from '@pasabot/provider-fake';
export * from './channel-contract.js';
export { FakeMemoryBackend, type MemoryContractSubject, runMemoryContract } from './memory-contract.js';

export function tempHome(prefix = 'pasabot-test-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // retries: on Windows a file that was just closed (the database) can stay locked for a moment (Defender, the
  // indexer) and unlink answers EBUSY/EPERM; POSIX unlinks at once
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export interface TestServer extends PasaBotServer {
  cleanup(): Promise<void>;
}
/** Real Fastify on port 0, temp $PASABOT_HOME, quiet logs. */
export async function bootTestServer(o: Partial<ServerOptions> = {}): Promise<TestServer> {
  const home = o.home ? { dir: o.home, cleanup() {} } : tempHome();
  const s = await startServer({
    root: null,
    logLevel: 'silent',
    port: 0,
    sitesPort: 0,
    host: '127.0.0.1',
    // never the OS keychain or a key file in tests; no OS sandbox unless a test asks for one
    vault: { source: 'passphrase', passphrase: 'pasabot-test-passphrase' },
    runnerMode: 'host-unsandboxed',
    ...o,
    home: home.dir,
  });
  return Object.assign(s, {
    async cleanup() {
      await s.close();
      home.cleanup();
    },
  });
}

// ---------- seed helpers (direct rows; W0b adds the real flows) ----------
type Db = PasaBotServer['db'];
const newToken = () => randomBytes(32).toString('base64url');

/**
 * A user with a fresh session. A server has exactly one owner (`users_single_owner`), so seeding `owner` again
 * returns a new session for the existing owner instead of a second owner row.
 */
export function seedUser(db: Db, kind: 'owner' | 'member' | 'guest' = 'owner', name = 'Owner') {
  const existing =
    kind === 'owner'
      ? (db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string } | undefined)
      : undefined;
  const id = existing?.id ?? ulid();
  if (!existing)
    db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      kind,
      name,
      Date.now(),
    );
  const token = newToken();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    id,
    Date.now(),
    Date.now() + 3600_000,
  );
  return { id, token };
}
export function seedAgent(
  db: Db,
  o: { slug?: string; providerId?: string; trust?: AgentDTO['trustLevel'] } = {},
) {
  const id = ulid();
  const slug = o.slug ?? `agent-${id.slice(-6).toLowerCase()}`;
  db.prepare(
    'INSERT INTO agents (id, slug, name, provider_id, workspace_dir, trust_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, slug, slug, o.providerId ?? 'fake', `/tmp/${slug}`, o.trust ?? 'standard', Date.now());
  return id;
}
export function seedChat(db: Db, members: { userIds?: string[]; agentIds?: string[] } = {}) {
  const id = ulid();
  db.prepare("INSERT INTO chats (id, kind, title, created_at) VALUES (?, 'direct', 'chat', ?)").run(
    id,
    Date.now(),
  );
  for (const u of members.userIds ?? []) {
    db.prepare("INSERT INTO chat_members (chat_id, member_kind, member_id) VALUES (?, 'user', ?)").run(id, u);
  }
  for (const a of members.agentIds ?? []) {
    db.prepare("INSERT INTO chat_members (chat_id, member_kind, member_id) VALUES (?, 'agent', ?)").run(
      id,
      a,
    );
  }
  return id;
}
export function seedAutomationToken(db: Db, agentId: string) {
  const token = newToken();
  db.prepare('INSERT INTO automation_tokens (id, agent_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    ulid(),
    agentId,
    hashToken(token),
    Date.now(),
  );
  return token;
}
export function seedRunToken(db: Db, agentId: string) {
  const qi = ulid();
  db.prepare(
    "INSERT INTO queue_items (id, agent_id, seq, priority, kind, state, created_at) VALUES (?, ?, (SELECT coalesce(max(seq),0)+1 FROM queue_items WHERE agent_id = ?), 0, 'message', 'done', ?)",
  ).run(qi, agentId, agentId, Date.now());
  const runId = ulid();
  db.prepare(
    "INSERT INTO runs (id, queue_item_id, agent_id, provider_id, state, started_at) VALUES (?, ?, ?, 'fake', 'running', ?)",
  ).run(runId, qi, agentId, Date.now());
  const token = newToken();
  db.prepare('INSERT INTO run_tokens (token_hash, run_id, agent_id, created_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    runId,
    agentId,
    Date.now(),
  );
  return { token, runId };
}

// ---------- WebSocket client ----------
export interface WsClient {
  frames: any[];
  send(f: unknown): void;
  next(pred?: (f: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): void;
}
export async function connectWs(baseUrl: string): Promise<WsClient> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const frames: any[] = [];
  let cursor = 0;
  const waiters = new Set<() => void>();
  ws.addEventListener('message', (e) => {
    frames.push(JSON.parse(String(e.data)));
    for (const w of waiters) w();
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
  });
  return {
    frames,
    send: (f) => ws.send(JSON.stringify(f)),
    next: (pred = () => true, timeoutMs = 3000) =>
      new Promise((res, rej) => {
        const check = () => {
          while (cursor < frames.length) {
            const f = frames[cursor++];
            if (pred(f)) {
              waiters.delete(check);
              clearTimeout(t);
              res(f);
              return;
            }
          }
        };
        const t = setTimeout(() => {
          waiters.delete(check);
          rej(
            new Error(`no matching ws frame within ${timeoutMs} ms; got ${JSON.stringify(frames.slice(-5))}`),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
    close: () => ws.close(),
  };
}

// ---------- provider contract ----------
export interface ProviderContractOptions {
  /** live CLI on a developer machine (never in CI) */
  live?: boolean;
  timeoutMs?: number;
  prompt?: string;
  workspaceDir?: string;
  /** an adapter with no CLI process (the Fake): the reseed case, which watches the CLI's argv and stdin, is skipped */
  inProcess?: boolean;
}

/**
 * A command wrapper standing in for the runner sandbox: it runs the real command and copies its argv and everything
 * written to its stdin into `out`, so the suite sees what the adapter handed the CLI.
 */
const CAPTURE = `import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [out, cmd, ...args] = process.argv.slice(2);
appendFileSync(out, JSON.stringify(args) + '\\n');
const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
process.stdin.on('data', (d) => { appendFileSync(out, d); child.stdin.write(d); });
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
`;
function captureWrapper() {
  const dir = mkdtempSync(join(tmpdir(), 'bk-contract-capture-'));
  const script = join(dir, 'capture.mjs');
  const out = join(dir, 'seen.txt');
  writeFileSync(script, CAPTURE);
  writeFileSync(out, '');
  let calls = 0;
  return {
    wrap: (cmd: string, args: string[]) => {
      calls++;
      return { cmd: process.execPath, args: [script, out, cmd, ...args] };
    },
    seen: () => readFileSync(out, 'utf8'),
    calls: () => calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const contractAgent = (providerId: string): AgentDTO => ({
  id: 'contract-agent',
  slug: 'contract',
  name: 'Contract',
  avatar: { hue: 0, glyph: 'C' },
  instructions: 'Be brief.',
  providerId,
  model: null,
  providerAccountId: null,
  fallback: [],
  workspaceDir: tmpdir(),
  trustLevel: 'guarded',
  limits: {},
  status: 'idle',
  createdAt: 0,
  archivedAt: null,
});
function turnInput(adapter: ProviderAdapter, o: ProviderContractOptions, nativeRef?: string): TurnInput {
  return {
    runId: ulid(),
    agent: contractAgent(adapter.id),
    workspaceDir: o.workspaceDir ?? tmpdir(),
    nativeRef,
    systemPrompt: 'Be brief.',
    user: {
      text: o.prompt ?? 'Reply with the single word: pong',
      attachments: [],
      from: { kind: 'owner', id: 'o', name: 'Owner', trust: 'standard' },
    },
    mcp: { url: 'http://127.0.0.1:9/mcp', bearer: 'contract' },
    tools: 'none',
    env: {},
  };
}
async function collect(it: AsyncIterable<ProviderEvent>, onEvent?: (e: ProviderEvent) => void) {
  const out: ProviderEvent[] = [];
  for await (const e of it) {
    out.push(e);
    if (e.type === 'permission') e.respond('deny');
    onEvent?.(e);
  }
  return out;
}

/** The suite every ProviderAdapter must pass; FakeProvider is the reference implementation. */
export function runProviderContract(adapter: ProviderAdapter, o: ProviderContractOptions = {}) {
  const timeout = o.timeoutMs ?? (o.live ? 120_000 : 10_000);
  describe(`provider contract: ${adapter.id}`, () => {
    it('has an id, a display name, a valid status and capabilities', async () => {
      expect(adapter.id).toMatch(/^(fake|claude|codex|gemini|grok|opencode|acp:.+)$/);
      expect(adapter.displayName.length).toBeGreaterThan(0);
      providerStatusSchema.parse(await adapter.detect());
      providerCapsSchema.parse(adapter.capabilities());
    });
    it('a turn emits only valid events and exactly one done, last', { timeout }, async () => {
      const ev = await collect(adapter.runTurn(turnInput(adapter, o), new AbortController().signal));
      for (const e of ev) providerEventSchema.parse(e);
      expect(ev.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(ev.at(-1)?.type).toBe('done');
      expect(ev.some((e) => e.type === 'text.final' || e.type === 'text.delta')).toBe(true);
    });
    it('abort ends the turn promptly with a single done', { timeout }, async () => {
      const ac = new AbortController();
      const started = Date.now();
      const ev = await collect(adapter.runTurn(turnInput(adapter, o), ac.signal), () => ac.abort());
      expect(ev.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(ev.at(-1)?.type).toBe('done');
      expect(Date.now() - started).toBeLessThan(timeout);
    });
    if (adapter.capabilities().resume) {
      it('reports a session ref and accepts it to resume', { timeout }, async () => {
        const first = await collect(adapter.runTurn(turnInput(adapter, o), new AbortController().signal));
        const s = first.find((e) => e.type === 'session');
        expect(s).toBeDefined();
        const ref = (s as { nativeRef: string }).nativeRef;
        const second = await collect(
          adapter.runTurn(turnInput(adapter, o, ref), new AbortController().signal),
        );
        expect(second.at(-1)).toMatchObject({ type: 'done' });
      });
    }
    if (!o.inProcess) {
      // a provider switch or compaction-by-reseed starts a new session: an adapter that drops the seed forgets the chat
      it('a new session carries the reseed to the CLI', { timeout }, async () => {
        const marker = `seed-${randomBytes(6).toString('hex')}`;
        const seed = {
          summary: `${marker}-summary`,
          recent: [
            {
              id: 'm1',
              chatId: 'c1',
              authorKind: 'user' as const,
              authorId: 'o',
              replyTo: null,
              body: `${marker}-recent`,
              blocks: [],
              status: 'final' as const,
              runId: null,
              createdAt: 0,
              editedAt: null,
            },
          ],
        };
        const cap = captureWrapper();
        try {
          const ev = await collect(
            adapter.runTurn(
              { ...turnInput(adapter, o), seed, sandbox: cap.wrap },
              new AbortController().signal,
            ),
          );
          expect(ev.at(-1)?.type).toBe('done');
          // every CLI adapter spawns through the runner sandbox; one that does not is itself a defect
          expect(cap.calls()).toBeGreaterThan(0);
          expect(cap.seen()).toContain(`${marker}-summary`);
          expect(cap.seen()).toContain(`${marker}-recent`);
        } finally {
          cap.cleanup();
        }
      });
    }
    if (adapter.steer) {
      it('steer on an unknown run returns false', async () => {
        expect(await adapter.steer!('no-such-run', 'hi')).toBe(false);
      });
    }
    if (adapter.skillsDir) {
      it('skillsDir lives inside the workspace', () => {
        expect(adapter.skillsDir!('/ws/agent').startsWith('/ws/agent')).toBe(true);
      });
    }
  });
}
