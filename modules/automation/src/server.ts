/**
 * Automation API (W21, ARCHITECTURE 2.3, 4.1, 7.4): local scripts and the `pasabot run` CLI start work on an agent
 * with a per-agent automation token.
 *
 * - Owner session only (widening, 7.4): the per-agent switch, issuing, listing and revoking tokens. The raw token
 *   is shown once; the core stores only its hash (`ModuleHost.automation`).
 * - Automation token only: `GET whoami`, `POST runs`, `GET runs/:id` (long-poll with `?wait=ms`) and
 *   `GET runs/:id/stream` (server-sent events). The auth resolver already refuses a token sent with an `Origin`
 *   header, from a non-loopback address without `remote_ok`, expired, revoked or of an archived agent.
 * - A run is a queue item of kind `automation.run` in the agent's own automation chat, started as the token's
 *   sender (`kind: 'automation'`, trust ≤ `standard`, never the owner), so tier 2 and 3 never auto-approve. The
 *   token's budget (default 30 runs/hour) answers 429 + `Retry-After`; the agent's switch off answers 403.
 * - A token reads only the runs it started.
 * - Access cut means work stops: revoking a token cancels its unfinished runs, turning the switch off cancels the
 *   agent's unfinished runs, and every `automation.run` is re-checked at dispatch time (`admit`): a revoked or
 *   expired token, or the switch off, and it never runs.
 */
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  AutomationAccessError,
  type AutomationTokenInfo,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type Principal,
  QUEUE_PRIORITY,
} from '@pasabot/core';
import type { AgentDTO, QueueItemDTO, QueueState } from '@pasabot/protocol';
import { z } from 'zod';

export const RUN_KIND = 'automation.run';
export const RUN_SCOPE = 'runs';
/** the longest a single long-poll waits */
export const MAX_WAIT_MS = 60_000;
/** an event stream closes after this, finished or not (the client reconnects or polls) */
export const MAX_STREAM_MS = 10 * 60_000;
const MAX_TEXT = 32_000;
const TERMINAL: QueueState[] = ['done', 'failed', 'cancelled', 'interrupted'];

export interface AutomationRunDTO {
  id: string;
  agentId: string;
  chatId: string;
  state: QueueState;
  error: string | null;
  /** the agent's final reply (redacted), once the run wrote one */
  reply: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export interface AutomationTokenDTO extends AutomationTokenInfo {
  label: string;
  agentName: string | null;
  active: boolean;
}
export interface AutomationAgentDTO {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  activeTokens: number;
}

const here = dirname(fileURLToPath(import.meta.url));

function owner(ctx: AuthedCtx): { userId: string } {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'owner_only');
  return { userId: p.userId };
}
function token(ctx: AuthedCtx): { tokenId: string; agentId: string } {
  const p = ctx.principal;
  if (p.kind !== 'automation') throw new HttpError(401, 'automation token required', 'unauthorized');
  return { tokenId: p.tokenId, agentId: p.agentId };
}
const active = (t: AutomationTokenInfo, now = Date.now()) =>
  t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);

const issueBody = z.object({
  agentId: z.string().min(1),
  label: z.string().trim().min(1).max(60),
  trust: z.enum(['guarded', 'standard']).default('standard'),
  remoteOk: z.boolean().default(false),
  ratePerHour: z.number().int().min(1).max(1000).default(30),
  /** null = never expires */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});
const runBody = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT),
  /** optional check: the agent's slug or id the caller means; another agent's -> 403 */
  agent: z.string().max(80).optional(),
});

export class AutomationService {
  constructor(private readonly app: ModuleHost) {}

  enabled(agentId: string): boolean {
    const r = this.app.raw.prepare('SELECT enabled FROM automation_agent WHERE agent_id = ?').get(agentId) as
      | { enabled: number }
      | undefined;
    return r?.enabled === 1;
  }
  setEnabled(agentId: string, on: boolean) {
    this.app.raw
      .prepare(
        `INSERT INTO automation_agent (agent_id, enabled, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(agentId, on ? 1 : 0, Date.now());
  }
  async liveAgent(id: string): Promise<AgentDTO> {
    const a = await this.app.agents.get(id);
    if (!a || a.archivedAt !== null) throw new HttpError(404, 'agent not found', 'not_found');
    return a;
  }
  async agents(actor: Principal): Promise<AutomationAgentDTO[]> {
    const tokens = this.app.automation.list(actor);
    return (await this.app.agents.list())
      .filter((a) => a.archivedAt === null)
      .map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        enabled: this.enabled(a.id),
        activeTokens: tokens.filter((t) => t.agentId === a.id && active(t)).length,
      }));
  }
  label(tokenId: string): string {
    const r = this.app.raw.prepare('SELECT label FROM automation_label WHERE token_id = ?').get(tokenId) as
      | { label: string }
      | undefined;
    return r?.label ?? '';
  }
  async tokens(actor: Principal): Promise<AutomationTokenDTO[]> {
    const names = new Map((await this.app.agents.list()).map((a) => [a.id, a.name]));
    return this.app.automation.list(actor).map((t) => ({
      ...t,
      label: this.label(t.id),
      agentName: names.get(t.agentId) ?? null,
      active: active(t),
    }));
  }
  async issue(ctx: AuthedCtx, b: z.infer<typeof issueBody>) {
    await this.liveAgent(b.agentId);
    if (!this.enabled(b.agentId))
      throw new HttpError(409, 'turn automation on for this agent first', 'automation_off');
    let issued: { id: string; token: string };
    try {
      // the port checks the owner session itself and records it as `createdBy` (7.4)
      issued = this.app.automation.issue(ctx.principal, {
        agentId: b.agentId,
        trust: b.trust,
        scopes: [RUN_SCOPE],
        remoteOk: b.remoteOk,
        ratePerHour: b.ratePerHour,
        expiresAt: b.expiresInDays === null ? null : Date.now() + b.expiresInDays * 86_400_000,
      });
    } catch (e) {
      if (e instanceof AutomationAccessError) throw new HttpError(403, 'owner only', 'owner_only');
      throw new HttpError(400, (e as Error).message, 'invalid_token');
    }
    this.app.raw
      .prepare('INSERT INTO automation_label (token_id, label) VALUES (?, ?)')
      .run(issued.id, b.label);
    const info = (await this.tokens(ctx.principal)).find((t) => t.id === issued.id)!;
    return { token: issued.token, info };
  }

  /** The agent's automation chat (opened once; reopened when it is gone). */
  chatFor(agent: AgentDTO): string {
    const r = this.app.raw.prepare('SELECT chat_id FROM automation_agent WHERE agent_id = ?').get(agent.id) as
      | { chat_id: string | null }
      | undefined;
    if (r?.chat_id && this.app.chats.isMember(r.chat_id, { kind: 'agent', id: agent.id })) return r.chat_id;
    const chatId = this.app.chats.openDirect({ agentId: agent.id, title: `${agent.name} · automation` });
    this.app.raw.prepare('UPDATE automation_agent SET chat_id = ? WHERE agent_id = ?').run(chatId, agent.id);
    return chatId;
  }

  /**
   * Cancel the unfinished runs (queued, leased, running, held, interrupted) of one token or of one agent; returns
   * how many were stopped.
   */
  cancelRuns(by: { tokenId: string } | { agentId: string }): number {
    const rows = (
      'tokenId' in by
        ? this.app.raw
            .prepare('SELECT queue_item_id AS id FROM automation_run WHERE token_id = ?')
            .all(by.tokenId)
        : this.app.raw
            .prepare('SELECT queue_item_id AS id FROM automation_run WHERE agent_id = ?')
            .all(by.agentId)
    ) as { id: string }[];
    let n = 0;
    for (const { id } of rows) {
      const st = this.app.queue.get(id)?.state;
      if (!st || TERMINAL.includes(st)) continue;
      if (st === 'interrupted' ? this.app.queue.skip(id) : this.app.queue.cancel(id)) n++;
    }
    return n;
  }
  /** Dispatch-time check for an `automation.run` item: why it must not run now, or null. */
  refusal(item: { agentId: string; source: unknown }): string | null {
    const tokenId = (item.source as { automation?: { tokenId?: unknown } } | null)?.automation?.tokenId;
    if (typeof tokenId !== 'string') return 'automation run without a token';
    // the queue's own dispatch-time check, done for no principal
    const sys = asSystem('automation: dispatch-time check of a queued automation.run');
    if (!this.app.automation.isActive(sys, tokenId)) return 'automation token revoked or expired';
    if (this.app.automation.get(sys, tokenId)?.agentId !== item.agentId)
      return 'automation token of another agent';
    if (!this.enabled(item.agentId)) return 'automation is off for this agent';
    return null;
  }

  async start(ctx: AuthedCtx, b: z.infer<typeof runBody>): Promise<AutomationRunDTO> {
    const p = token(ctx);
    const t = this.app.automation.get(ctx.principal, p.tokenId);
    if (!t?.scopes.includes(RUN_SCOPE))
      throw new HttpError(403, 'this token may not start runs', 'missing_scope');
    const agent = await this.liveAgent(p.agentId);
    if (b.agent !== undefined && b.agent !== agent.slug && b.agent !== agent.id)
      throw new HttpError(403, `this token belongs to ${agent.slug}`, 'wrong_agent');
    if (!this.enabled(agent.id))
      throw new HttpError(403, 'automation is off for this agent', 'automation_off');
    const budget = this.app.automation.budget(ctx.principal, p.tokenId);
    if (!budget.ok)
      throw Object.assign(new HttpError(429, 'run budget for this hour is used up', 'rate_limited'), {
        retryAfterSec: budget.retryAfterSec,
      });
    const chatId = this.chatFor(agent);
    const { item } = this.app.queue.enqueue({
      agentId: agent.id,
      chatId,
      kind: RUN_KIND,
      payload: { text: b.text },
      // the token's own principal: the port refuses a revoked or expired token here too
      source: this.app.automation.source(ctx.principal),
    });
    this.app.raw
      .prepare(
        'INSERT INTO automation_run (queue_item_id, token_id, agent_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(item.id, p.tokenId, agent.id, chatId, item.createdAt);
    return this.dto(item, chatId);
  }

  /** A run this token started, else 404 (another token's run is never visible). */
  own(tokenId: string, id: string): { item: QueueItemDTO; chatId: string } {
    const r = this.app.raw
      .prepare('SELECT chat_id FROM automation_run WHERE queue_item_id = ? AND token_id = ?')
      .get(id, tokenId) as { chat_id: string } | undefined;
    const item = r ? this.app.queue.get(id) : null;
    if (!r || !item) throw new HttpError(404, 'run not found', 'not_found');
    return { item, chatId: r.chat_id };
  }
  runIds(queueItemId: string): string[] {
    return (
      this.app.raw
        .prepare('SELECT id FROM runs WHERE queue_item_id = ? ORDER BY started_at DESC')
        .all(queueItemId) as { id: string }[]
    ).map((r) => r.id);
  }
  dto(item: QueueItemDTO, chatId: string): AutomationRunDTO {
    let reply: string | null = null;
    if (item.state === 'done' || item.state === 'failed')
      for (const runId of this.runIds(item.id)) {
        // the agent reads its own automation chat; never a system read on a caller's behalf
        reply = this.app.chats.runReply({ kind: 'agent', id: item.agentId }, runId);
        if (reply !== null) break;
      }
    return {
      id: item.id,
      agentId: item.agentId,
      chatId,
      state: item.state,
      error: item.error,
      reply,
      createdAt: item.createdAt,
      finishedAt: item.finishedAt,
    };
  }
  /** Resolves when the item reaches a final state or `ms` passes. */
  waitFinal(id: string, agentId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        off();
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        const s = this.app.queue.get(id)?.state;
        if (!s || TERMINAL.includes(s)) done();
      };
      const off = this.app.bus.subscribe((ev) => {
        if (ev.type === 'queue.changed' && (ev.data as { agentId?: string }).agentId === agentId) check();
      });
      const timer = setTimeout(done, ms);
      timer.unref?.();
      check();
    });
  }

  /** Server-sent events for one run: `delta` (the reply so far), `state`, then `done` with the final run. */
  stream(id: string, tokenId: string): PassThrough {
    const { item, chatId } = this.own(tokenId, id);
    const out = new PassThrough();
    let closed = false;
    let lastState: QueueState | null = null;
    const send = (event: string, data: unknown) => {
      if (!closed) out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(beat);
      clearTimeout(max);
      out.end();
    };
    const check = () => {
      const cur = this.app.queue.get(id);
      if (!cur) return finish();
      if (cur.state !== lastState) {
        lastState = cur.state;
        send('state', { state: cur.state });
      }
      if (TERMINAL.includes(cur.state)) {
        send('done', this.dto(cur, chatId));
        finish();
      }
    };
    const off = this.app.bus.subscribe((ev) => {
      if (ev.live && ev.type === 'message.delta' && ev.topic === `chat:${chatId}`) {
        const d = ev.data as { runId?: string; text?: string };
        if (d.runId && typeof d.text === 'string' && this.runIds(id).includes(d.runId))
          send('delta', { text: d.text });
      } else if (ev.type === 'queue.changed' && (ev.data as { agentId?: string }).agentId === item.agentId)
        check();
    });
    const beat = setInterval(() => !closed && out.write(': keep-alive\n\n'), 15_000);
    beat.unref?.();
    const max = setTimeout(finish, MAX_STREAM_MS);
    max.unref?.();
    out.on('close', finish);
    // first frame goes out on the next tick, after Fastify has the stream
    setImmediate(check);
    return out;
  }
}

export function createAutomationModule(): PasaBotModule & { service(): AutomationService } {
  let svc: AutomationService | null = null;
  return {
    id: 'automation',
    migrations: join(here, '..', 'migrations'),
    service() {
      if (!svc) throw new Error('automation module not registered yet');
      return svc;
    },
    register(app) {
      const s = new AutomationService(app);
      svc = s;
      // its own kind: an interrupted automation run never blocks the agent's queue
      // `admit`: re-checked right before each run, so work queued before a revoke or switch-off never runs
      app.queue.registerKind(RUN_KIND, {
        priority: QUEUE_PRIORITY.task,
        blocksOnInterrupt: false,
        admit: (item) => s.refusal(item),
      });

      // ---------- owner session (widening, 7.4) ----------
      app.http.route({
        method: 'GET',
        url: '/agents',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          return { agents: await s.agents(ctx.principal) };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/agents/:id',
        auth: 'session',
        body: z.object({ enabled: z.boolean() }),
        handler: async (ctx) => {
          owner(ctx);
          const a = await s.liveAgent(ctx.params.id!);
          const on = (ctx.body as { enabled: boolean }).enabled;
          s.setEnabled(a.id, on);
          const cancelled = on ? 0 : s.cancelRuns({ agentId: a.id });
          return {
            agent: (await s.agents(ctx.principal)).find((x) => x.id === a.id),
            cancelledRuns: cancelled,
          };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/tokens',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          return { tokens: await s.tokens(ctx.principal) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/tokens',
        auth: 'session',
        body: issueBody,
        handler: async (ctx) => {
          owner(ctx);
          return httpResponse(201, await s.issue(ctx, ctx.body as z.infer<typeof issueBody>));
        },
      });
      app.http.route({
        method: 'POST',
        url: '/tokens/:id/revoke',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          if (!app.automation.get(ctx.principal, ctx.params.id!))
            throw new HttpError(404, 'token not found', 'not_found');
          app.automation.revoke(ctx.principal, ctx.params.id!);
          const cancelled = s.cancelRuns({ tokenId: ctx.params.id! });
          return {
            token: (await s.tokens(ctx.principal)).find((t) => t.id === ctx.params.id),
            cancelledRuns: cancelled,
          };
        },
      });

      // ---------- automation token ----------
      app.http.route({
        method: 'GET',
        url: '/whoami',
        auth: 'automation',
        handler: async (ctx) => {
          const p = token(ctx);
          const a = await s.liveAgent(p.agentId);
          const t = app.automation.get(ctx.principal, p.tokenId)!;
          return {
            agent: { id: a.id, slug: a.slug, name: a.name },
            token: {
              id: t.id,
              label: s.label(t.id),
              scopes: t.scopes,
              trust: t.trust,
              expiresAt: t.expiresAt,
            },
            enabled: s.enabled(a.id),
          };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/runs',
        auth: 'automation',
        body: runBody,
        handler: async (ctx) => {
          token(ctx);
          try {
            return httpResponse(202, { run: await s.start(ctx, ctx.body as z.infer<typeof runBody>) });
          } catch (e) {
            const retry = (e as { retryAfterSec?: number }).retryAfterSec;
            if (retry !== undefined)
              return httpResponse(
                429,
                { error: 'rate_limited', retryAfterSec: retry },
                { 'retry-after': String(retry) },
              );
            throw e;
          }
        },
      });
      app.http.route({
        method: 'GET',
        url: '/runs/:id',
        auth: 'automation',
        handler: async (ctx) => {
          const p = token(ctx);
          const first = s.own(p.tokenId, ctx.params.id!);
          const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(ctx.query.wait) || 0));
          if (wait > 0 && !TERMINAL.includes(first.item.state))
            await s.waitFinal(first.item.id, first.item.agentId, wait);
          const { item, chatId } = s.own(p.tokenId, ctx.params.id!);
          return { run: s.dto(item, chatId) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/runs/:id/stream',
        auth: 'automation',
        handler: (ctx) => {
          const p = token(ctx);
          return httpResponse(200, s.stream(ctx.params.id!, p.tokenId), {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
        },
      });
    },
  };
}

export default defineModule(createAutomationModule());
