/**
 * `/mcp` gateway (ARCHITECTURE 4.1, 5.4): one streamable-HTTP MCP endpoint per server, JSON-RPC over POST with JSON
 * responses. Only a live run bearer authenticates (never a session, never a raw run id), so a CLI reaches PasaBot
 * tools only for the run it belongs to. Widening tools are never listed or invoked here (7.4). Every call is gated
 * by the approval tiers.
 */
import {
  type ApprovalTier,
  askFromArgs,
  callFacts,
  type Logger,
  maskCardNumbersDeep,
  maskMoneyFact,
  type SafeNet,
  type SecretVault,
  type ToolCtx,
  type ToolDef,
  type ToolRegistry,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { ActionClass, RunDTO, TrustLevel } from '@pasabot/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bridgeDeleteAsk } from '../approvals/delete-scan.js';
import {
  type ApprovalServiceImpl,
  alwaysAskClasses,
  asksBeforeShellWeb,
  autoApproves,
  callFingerprint,
  cliToolAutoApproves,
  isShellOrRawWebTool,
  repeatRefusal,
  tierForCliTool,
} from '../approvals/index.js';
import { runDTO } from '../core/queue.js';
import { bearerOf, SqliteAgentReader, tokenPrincipal } from '../core/services.js';
import { workspaceFor } from '../runner/orchestrator.js';
import { agentScopedVault, type Redact, redactDeep } from '../vault/index.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** The permission-prompt tool provider CLIs call before using their own tools (`caps.permissionBridge`). */
export const PERMISSION_TOOL = 'core_permission_prompt';

export interface McpDeps {
  db: Sqlite;
  tools: ToolRegistry;
  approvals: ApprovalServiceImpl;
  net: SafeNet;
  log: Logger;
  home: string;
  redact: Redact;
  /** resolves `{{secret:name}}` references granted to the run's agent for tool handlers (W14) */
  vault?: SecretVault;
  /** W31: while stopped, every tool call is refused */
  isStopped?: () => boolean;
}

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** JSON Schema for a tool input (zod 4 can emit it). */
const inputSchemaOf = (def: ToolDef): unknown => {
  try {
    return z.toJSONSchema(def.input as z.ZodType, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
};

export function registerMcp(app: FastifyInstance, d: McpDeps) {
  const agents = new SqliteAgentReader(d.db);
  const visible = () => d.tools.list().filter((t) => !t.widens);

  app.get('/mcp', async (_req, reply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
  );
  app.delete('/mcp', async (_req, reply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
  );

  app.post('/mcp', async (req, reply) => {
    // run bearer only; the token is hashed and checked against run_tokens (revoked on done)
    const token = bearerOf(req.headers);
    const p = token ? tokenPrincipal(d.db, token) : null;
    if (p?.kind !== 'run') return reply.code(401).send({ error: 'unauthorized' });
    const run = runDTO(d.db, p.runId);
    if (run?.state !== 'running') return reply.code(401).send({ error: 'unauthorized' });
    const agent = await agents.get(p.agentId);
    if (!agent) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = rpcSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    const { id, method, params } = parsed.data;
    if (id === undefined) return reply.code(202).send(); // notification (e.g. notifications/initialized)
    const ok = (result: unknown) => reply.send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) =>
      reply.send({ jsonrpc: '2.0', id, error: { code, message } });

    const source = d.db
      .prepare('SELECT q.source FROM runs r JOIN queue_items q ON q.id = r.queue_item_id WHERE r.id = ?')
      .get(run.id) as { source: string } | undefined;
    const sender = (source ? JSON.parse(source.source).sender : undefined) ?? {
      kind: 'system',
      id: null,
      name: 'system',
      trust: 'guarded' as TrustLevel,
    };
    const workspace = agent.workspaceDir || workspaceFor(d.home, agent.slug);
    // W31: the stop (or the run ending) can land while a call waits on an approval: checked again before anything
    // is asked and right before a tool runs, so an approval given during a stop never turns into an action
    const halted = (): string | null =>
      d.isStopped?.()
        ? 'refused: the owner stopped all agents. Do not retry.'
        : runDTO(d.db, run.id)?.state !== 'running'
          ? 'refused: this run has ended.'
          : null;

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pasabot', version: '0.0.0' },
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: [
            {
              name: PERMISSION_TOOL,
              description: 'PasaBot decides whether the agent CLI may use one of its own tools.',
              inputSchema: {
                type: 'object',
                properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
                required: ['tool_name'],
              },
            },
            ...visible().map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: inputSchemaOf(t),
            })),
          ],
        });
      case 'tools/call': {
        const call = z
          .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
          .safeParse(params);
        if (!call.success) return fail(-32602, 'invalid params');
        const { name, arguments: args = {} } = call.data;
        const text = (v: unknown, isError = false) =>
          ok({
            content: [{ type: 'text', text: d.redact(typeof v === 'string' ? v : JSON.stringify(v)) }],
            isError,
          });

        if (name === PERMISSION_TOOL) {
          const tool = String(args.tool_name ?? '');
          const input = args.input ?? {};
          const tier = tierForCliTool(tool, input, workspace);
          // W38: a delete outside the workspace (a file tool, or a terminal delete while "Ask before terminal and raw
          // web commands" is on) is the fixed `delete` class: a delete card every time, answerable in the app only
          const del = halted()
            ? null
            : bridgeDeleteAsk(tool, input, workspace, {
                shellToggle: asksBeforeShellWeb(agent),
                isShell: isShellOrRawWebTool(tool),
              });
          if (del) {
            const fp = callFingerprint(tool, input);
            const repeat = repeatRefusal(d.db, { runId: run.id, agentId: agent.id, cls: 'delete', fp });
            let ok = false;
            if (!repeat) {
              const ask = {
                ...del,
                fields: [...del.fields, ...callFacts(tool, input)].map((f) => ({
                  key: f.key,
                  value: f.value === null ? null : d.redact(f.value),
                })),
              };
              const res = await d.approvals.request({
                runId: run.id,
                agentId: agent.id,
                tier: Math.max(tier, 2) as ApprovalTier,
                action: redactDeep({ tool, input, class: 'delete', fp }, d.redact),
                summary: d.redact(`${agent.name} wants to: ${tool}`),
                msg: {
                  key: 'core:server.wantsToUse',
                  params: { name: d.redact(agent.name), tool: d.redact(tool) },
                },
                ask,
              });
              ok = res === 'approved' && !halted();
            }
            return text(
              ok
                ? { behavior: 'allow', updatedInput: input }
                : {
                    behavior: 'deny',
                    message: repeat
                      ? `Refused: ${repeat}. Do not try this again; tell the owner in your reply what you wanted to do.`
                      : 'The owner did not approve this delete. Do not try it again in this turn.',
                  },
            );
          }
          // 7.1: the agent's "Ask before terminal and raw web commands" makes a shell or raw web call ask every time
          let allowed = !halted() && cliToolAutoApproves(tool, tier, agent, sender);
          if (!allowed && !halted()) {
            const res = await d.approvals.request({
              runId: run.id,
              agentId: agent.id,
              tier,
              action: redactDeep({ tool, input }, d.redact),
              summary: d.redact(`${agent.name} wants to: ${tool}`),
              msg: {
                key: 'core:server.wantsToUse',
                params: { name: d.redact(agent.name), tool: d.redact(tool) },
              },
            });
            allowed = res === 'approved' && !halted();
          }
          return text(
            allowed
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'The owner did not approve this action.' },
          );
        }

        const def = d.tools.get(name);
        if (!def || def.widens) return fail(-32602, `unknown tool: ${name}`);
        // W31: the global stop refuses every call; a guard (skill manifest) refuses below, before any approval is asked
        const stopped0 = halted();
        if (stopped0) return text(stopped0, true);
        const ctx: ToolCtx = {
          run: run as RunDTO,
          agent,
          sender,
          signal: AbortSignal.timeout(10 * 60_000),
          log: d.log.child({ tool: name, runId: run.id }),
          vault: d.vault
            ? agentScopedVault(d.vault, agent.id, run.id)
            : {
                resolve: async () => {
                  throw new Error('the vault is not available on this server');
                },
              },
          net: d.net,
          files: {
            put: async () => {
              throw new Error('files are not available to tools in this build');
            },
            open: () => {
              throw new Error('files are not available to tools in this build');
            },
            stat: async () => null,
          },
          emit: () => {},
        };
        let input: unknown;
        try {
          input = def.input.parse(args);
        } catch (e) {
          return text(`invalid input: ${(e as Error).message}`, true);
        }
        // guards (W31 skill manifests) run before anything else happens, and again below once a dynamic class is known
        const staticCls = typeof def.actionClass === 'function' ? undefined : def.actionClass;
        const refused0 = await d.tools.refusal({
          name,
          input,
          def,
          run: run as RunDTO,
          agent,
          actionClass: staticCls,
        });
        if (refused0) return text(`refused: ${refused0}`, true);
        const tier = (typeof def.tier === 'function' ? def.tier(input, ctx) : def.tier) as ApprovalTier;
        // 8 "Screen helpers": one computer-use card per agent at a time; a parallel second call is refused, no card
        const screen = def.screenControl === true;
        if (screen && d.approvals.hasPendingScreen(agent.id))
          return text(
            'refused: one screen step at a time. Another screen action of yours is still waiting for the owner; wait for that answer, then try this again.',
            true,
          );
        // 7.1 "Always asks": the class comes from the tool (and the server's stored state), never the agent's words
        let cls: ActionClass | undefined;
        try {
          cls = typeof def.actionClass === 'function' ? await def.actionClass(input, ctx) : def.actionClass;
        } catch (e) {
          // a class that cannot be worked out is never a reason to run without asking: refuse
          return text(`could not check this action: ${(e as Error).message}`, true);
        }
        if (typeof def.actionClass === 'function') {
          // the resolved class (e.g. an outside tool classed outbound-message) is checked too, never a guess
          const refused = await d.tools.refusal({
            name,
            input,
            def,
            run: run as RunDTO,
            agent,
            actionClass: cls,
          });
          if (refused) return text(`refused: ${refused}`, true);
        }
        if (cls && alwaysAskClasses(d.db).has(cls)) {
          const fp = callFingerprint(name, input);
          const repeat = repeatRefusal(d.db, { runId: run.id, agentId: agent.id, cls, fp });
          if (repeat)
            return text(
              `refused: ${repeat}. Do not try this again; tell the owner in your reply what you wanted to do.`,
              true,
            );
          let ask: Awaited<ReturnType<NonNullable<ToolDef['actionDetails']>>>;
          try {
            ask = def.actionDetails ? await def.actionDetails(input, ctx, cls) : askFromArgs(cls, input);
          } catch (e) {
            return text(`could not read what this action would do: ${(e as Error).message}`, true);
          }
          // a money call's payment card numbers are masked in everything this approval stores and serves (any
          // separator), never what the owner approves: the total stays as given when it reads as an amount (a
          // 12-digit or smallest-unit amount too), and who gets the money (merchant, payee, IBAN or account) is
          // never masked, by key. The payment method keeps its label mask (`maskMoneyFact`). A message card keeps
          // its digits: a phone number is the recipient the owner must see.
          const money = cls === 'money';
          const shown = money ? maskCardNumbersDeep(input) : input;
          const maskFact = (key: string, v: string) => (money ? maskMoneyFact(key, v) : v);
          const fact = (f: { key: string; value: string | null }, mask: boolean) => {
            if (f.value === null) return { key: f.key, value: null };
            const v = d.redact(f.value);
            return { key: f.key, value: mask ? maskFact(f.key, v) : v };
          };
          ask = {
            ...ask,
            ...(ask.unshown ? { unshown: ask.unshown.map((k) => d.redact(k)) } : {}),
            class: cls,
            // the summary facts, then always the tool and its full arguments (already masked by key above, so not
            // again as text, where an amount could pass for a card): decoy or unmapped arguments are seen
            fields: [
              ...ask.fields.map((f) => fact(f, true)),
              ...callFacts(name, shown).map((f) => fact(f, false)),
            ],
          };
          const before = halted();
          if (before) return text(before, true);
          const res = await d.approvals.request({
            runId: run.id,
            agentId: agent.id,
            // money needs the tier-3 re-auth; every always-ask card is answered in the app only (never a channel)
            tier: cls === 'money' ? 3 : (Math.max(tier, 2) as ApprovalTier),
            action: redactDeep(
              { tool: name, title: def.title, titleKey: def.titleKey, input: shown, class: cls, fp },
              d.redact,
            ),
            summary: d.redact(`${agent.name} wants to: ${def.title}`),
            msg: {
              key: 'core:server.wantsToUse',
              params: {
                name: d.redact(agent.name),
                tool: { key: def.titleKey ?? `tools.${name}`, fallback: def.title },
              },
            },
            ask,
            ...(screen ? { screen: true } : {}),
          });
          if (res !== 'approved')
            return text(
              `refused: the owner did not approve this ${cls} action (${res}). Do not try it again in this turn.`,
              true,
            );
        } else if (!autoApproves(tier, agent.trustLevel, sender, def)) {
          // `def`: a `noAlwaysAllow` tool asks every time, at every tier and trust level (7.1)
          const before = halted();
          if (before) return text(before, true);
          const res = await d.approvals.request({
            runId: run.id,
            agentId: agent.id,
            tier,
            action: redactDeep({ tool: name, title: def.title, titleKey: def.titleKey, input }, d.redact),
            summary: d.redact(`${agent.name} wants to: ${def.title}`),
            msg: {
              key: 'core:server.wantsToUse',
              params: {
                name: d.redact(agent.name),
                tool: { key: def.titleKey ?? `tools.${name}`, fallback: def.title },
              },
            },
            ...(screen ? { screen: true } : {}),
          });
          if (res !== 'approved') return text(`not approved (${res})`, true);
        }
        const after = halted();
        if (after) return text(after, true);
        // 8 "Screen helpers": while a screen action runs (and 2 s after), no approval goes through
        if (screen) d.approvals.screenActionStarted();
        try {
          return text(await d.tools.invoke(name, input, ctx));
        } catch (e) {
          return text(`tool failed: ${(e as Error).message}`, true);
        } finally {
          if (screen) d.approvals.screenActionEnded();
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  });
}
