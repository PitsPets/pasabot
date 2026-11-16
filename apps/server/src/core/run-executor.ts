/**
 * Minimal run executor: queue item -> one provider turn -> `runs` + `run_events` rows and run events on the bus.
 * W0b's orchestrator wraps this with approvals, the MCP gateway, chat replies and ProviderPolicy fallbacks.
 */
import { join } from 'node:path';
import {
  type AgentReader,
  type EventBus,
  type ProviderRegistry,
  type SenderInfo,
  type TurnInput,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { RunDTO } from '@pasabot/protocol';
import { type Executor, isShutdownAbort } from './dispatcher.js';
import { runDTO } from './queue.js';

export interface ProviderExecutorDeps {
  db: Sqlite;
  bus: EventBus;
  providers: ProviderRegistry;
  agents: AgentReader;
  home: string;
  /** answer `permission` events; default deny (approvals land in W0b) */
  onPermission?: (ev: { runId: string; tool: string; input: unknown }) => Promise<'allow' | 'deny'>;
}

const mustRunDTO = (db: Sqlite, id: string): RunDTO => runDTO(db, id)!;

export function createProviderExecutor(d: ProviderExecutorDeps): Executor {
  return async (item, { signal }) => {
    const agent = await d.agents.get(item.agent_id);
    if (!agent) return { state: 'failed', error: 'agent not found' };
    const adapter = d.providers.get(agent.providerId);
    if (!adapter) return { state: 'failed', error: `provider "${agent.providerId}" is not installed` };
    const payload = JSON.parse(item.payload) as { text?: string };
    const source = JSON.parse(item.source) as { sender?: SenderInfo };
    const runId = ulid();
    d.db
      .prepare(
        "INSERT INTO runs (id, queue_item_id, agent_id, provider_id, model, state, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      )
      .run(runId, item.id, agent.id, adapter.id, agent.model, Date.now());
    d.bus.publish(`agent:${agent.id}`, 'run.started', mustRunDTO(d.db, runId));
    const input: TurnInput = {
      runId,
      agent,
      workspaceDir: agent.workspaceDir || join(d.home, 'workspaces', agent.slug),
      systemPrompt: agent.instructions,
      user: {
        text: payload.text ?? '',
        attachments: [],
        from: source.sender ?? { kind: 'system', id: null, name: 'system', trust: 'guarded' },
      },
      mcp: { url: '', bearer: '' },
      tools: 'gateway',
      model: agent.model ?? undefined,
      env: {},
    };
    let n = 0;
    let stop: 'end' | 'cancelled' | 'error' = 'error';
    let lastError: string | undefined;
    let usage: unknown = null;
    const addEvent = d.db.prepare('INSERT INTO run_events (run_id, n, type, data) VALUES (?, ?, ?, ?)');
    try {
      for await (const ev of adapter.runTurn(input, signal)) {
        if (ev.type === 'permission') {
          const decision = d.onPermission
            ? await d.onPermission({ runId, tool: ev.tool, input: ev.input })
            : 'deny';
          ev.respond(decision);
          addEvent.run(runId, n++, 'permission', JSON.stringify({ id: ev.id, tool: ev.tool, decision }));
          continue;
        }
        if (ev.type === 'text.delta') {
          d.bus.live(`run:${runId}`, 'message.delta', { runId, text: ev.text });
          continue; // deltas are not persisted
        }
        if (ev.type === 'usage') usage = ev;
        if (ev.type === 'error') lastError = `${ev.kind}: ${ev.message}`;
        if (ev.type === 'done') stop = ev.stop;
        addEvent.run(runId, n++, ev.type, JSON.stringify(ev));
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      stop = signal.aborted ? 'cancelled' : 'error';
    }
    // a server shutdown is not an owner cancel: the turn is `interrupted` (the queue item is recovered as such)
    const state =
      stop === 'end'
        ? 'done'
        : isShutdownAbort(signal)
          ? 'interrupted'
          : stop === 'cancelled'
            ? 'cancelled'
            : 'failed';
    const finishedAt = Date.now();
    d.db
      .prepare('UPDATE runs SET state = ?, usage = ?, finished_at = ?, stop_reason = ? WHERE id = ?')
      .run(state, usage ? JSON.stringify(usage) : null, finishedAt, stop, runId);
    d.db
      .prepare('UPDATE run_tokens SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL')
      .run(finishedAt, runId);
    d.bus.publish(`agent:${agent.id}`, 'run.finished', mustRunDTO(d.db, runId));
    if (state === 'interrupted') return { state: 'cancelled', error: 'shutdown' }; // the dispatcher leaves it running
    return state === 'failed' ? { state, error: lastError ?? 'run failed' } : { state };
  };
}
