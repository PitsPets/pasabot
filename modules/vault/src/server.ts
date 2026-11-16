/**
 * W14 vault module: Settings → Vault (the owner adds, grants and removes secrets, links Bitwarden / 1Password,
 * and is the only one who can rotate the vault key), the Bitwarden and 1Password reference backends, and the agent
 * key-request flow: an agent asks for a key by name (`vault_request_secret`), the owner fills it (a value, or a
 * password-manager reference), and the agent is granted the reference `{{secret:NAME}}`, an entry in its own
 * scope `agent:<id>` that tool handlers resolve server-side. Agents never get a raw value from this module.
 * The one exception is a brain key (`brain:<providerId>`, "Key for <brain>"): only the owner saves it, only the
 * runner reads it, and it reaches that brain's process env, so the page says agents on that brain can see it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type SecretMeta,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import type { AgentDTO } from '@pasabot/protocol';
import { z } from 'zod';
import { BitwardenBackend, CliError, OnePasswordBackend } from './backends.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Secret names: what goes between `{{secret:` and `}}`. */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const name = z.string().max(64).regex(NAME_RE, 'letters, digits, _ . - (start with a letter)');
const value = z.string().min(1).max(16_384);
const ref = z.string().min(1).max(300);
const backendId = z.enum(['bitwarden', '1password']);
/** Pending requests one agent may have open at once (an injected turn cannot flood the owner). */
export const MAX_PENDING = 10;
const SESSION_NAME = { bitwarden: 'bitwarden.session', '1password': '1password.token' } as const;
const MODULE_SCOPE = 'module:vault';

const reference = (n: string) => `{{secret:${n}}}`;
/** Control characters out of agent-written text (no regex over agent input: a plain loop). */
const stripControl = (t: string) =>
  [...t]
    .filter((c) => {
      const n = c.codePointAt(0)!;
      return n === 9 || n === 10 || (n >= 32 && n !== 127);
    })
    .join('');

export interface VaultModuleOptions {
  /**
   * Bitwarden CLI binary (default `PASABOT_BW_BIN`, else `bw` in a fixed list of system folders, never the server's
   * PATH); set by the operator, never from the web. Pinned at boot and refused when the server's user can change it.
   */
  bwBin?: string;
  /** 1Password CLI binary (default `PASABOT_OP_BIN`, else `op` in the same fixed folders) */
  opBin?: string;
  timeoutMs?: number;
  /** tests only (stub CLIs they wrote): skip the "binary not writable by the server's user" check */
  allowWritableBin?: boolean;
}

function ownerOnly(ctx: AuthedCtx<unknown>) {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner manages the vault', 'forbidden');
}

interface RequestRow {
  id: string;
  agent_id: string;
  name: string;
  reason: string;
  state: 'pending' | 'filled' | 'declined';
  origin_sender: string;
  run_id: string | null;
  chat_id: string | null;
  secret_id: string | null;
  created_at: number;
  decided_at: number | null;
}

export function createVaultModule(o: VaultModuleOptions = {}) {
  return defineModule({
    id: 'vault',
    migrations: join(here, '..', 'migrations'),
    register(app) {
      const session = (b: keyof typeof SESSION_NAME) => async () => {
        const hit = (await app.vault.list(MODULE_SCOPE)).find((s) => s.name === SESSION_NAME[b]);
        return hit ? app.vault.get(hit, { actor: 'module:vault', purpose: `${b} session` }) : '';
      };
      const backends = {
        bitwarden: new BitwardenBackend({
          bin: o.bwBin ?? process.env.PASABOT_BW_BIN ?? 'bw',
          session: session('bitwarden'),
          timeoutMs: o.timeoutMs,
          allowWritableBin: o.allowWritableBin,
        }),
        '1password': new OnePasswordBackend({
          bin: o.opBin ?? process.env.PASABOT_OP_BIN ?? 'op',
          session: session('1password'),
          timeoutMs: o.timeoutMs,
          allowWritableBin: o.allowWritableBin,
        }),
      };
      for (const [id, b] of Object.entries(backends))
        if (b.pinned.problem === 'unsafe_bin')
          app.log.warn('password manager backend turned off: its CLI can be changed by the server user', {
            backend: id,
          });
      // the vault may be unavailable (host mode without a passphrase): the module still loads and says so
      try {
        for (const b of Object.values(backends)) app.vault.addBackend(b);
      } catch (e) {
        app.log.warn('vault backends not registered', { reason: (e as Error).message });
      }

      const db = app.raw;
      const getReq = (id: string) =>
        db.prepare('SELECT * FROM vault_request WHERE id = ?').get(id) as RequestRow | undefined;
      const agentSecrets = async (agentId: string) => app.vault.list(`agent:${agentId}`);
      const agentName = async (id: string) => (await app.agents.get(id))?.name ?? id;

      // ---------- agent tools ----------
      app.tools.add({
        name: 'vault_request_secret',
        title: 'Ask the owner for a key',
        description:
          'Ask the owner for an API key or other secret you need, by NAME (e.g. WEATHER_API_KEY) and why. The owner fills it in the vault; you then use the reference {{secret:NAME}}, never the value itself. Returns the reference and whether it is ready yet.',
        input: z.object({ name, reason: z.string().max(500).default('') }),
        output: z.object({
          requestId: z.string().nullable(),
          state: z.enum(['pending', 'granted']),
          reference: z.string(),
        }),
        // asking is harmless: nothing changes until the owner acts, and the card shows who caused the ask
        tier: 1,
        handler: async (i, ctx: ToolCtx) => {
          const agentId = ctx.agent.id;
          if ((await agentSecrets(agentId)).some((s) => s.name === i.name))
            return { requestId: null, state: 'granted' as const, reference: reference(i.name) };
          const open = db
            .prepare(
              "SELECT * FROM vault_request WHERE agent_id = ? AND state = 'pending' ORDER BY created_at",
            )
            .all(agentId) as RequestRow[];
          const same = open.find((r) => r.name === i.name);
          if (same) return { requestId: same.id, state: 'pending' as const, reference: reference(i.name) };
          if (open.length >= MAX_PENDING)
            throw new Error(`you already have ${MAX_PENDING} key requests waiting for the owner`);
          const id = ulid();
          const reason = app.redact(stripControl(i.reason)).slice(0, 500);
          db.prepare(
            `INSERT INTO vault_request (id, agent_id, name, reason, state, origin_sender, run_id, chat_id, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          ).run(
            id,
            agentId,
            i.name,
            reason,
            ctx.sender?.kind ?? 'system',
            ctx.run.id,
            app.chats.runChat(ctx.run.id),
            Date.now(),
          );
          await app.notifier
            .notify({
              level: 'info',
              title: `${ctx.agent.name} asks for a key: ${i.name}`,
              msg: {
                title: { key: 'vault:server.asksForKey', params: { agent: ctx.agent.name, name: i.name } },
              },
              ...(reason ? { body: reason } : {}),
              href: '#/settings/safety/vault',
              // W40: a card in the helper's chat (and the pinned decision bar) that opens the safe box's form
              card: {
                variant: 'ok',
                title: { key: 'vault:card.request.title', params: { agent: ctx.agent.name, name: i.name } },
                text: { key: 'vault:card.request.text', params: { agent: ctx.agent.name } },
                actions: [
                  {
                    id: 'give',
                    label: { key: 'vault:card.request.give' },
                    style: 'primary',
                    href: '#/settings/safety/vault',
                  },
                  { id: 'later', label: { key: 'core:card.action.notNow' }, style: 'ghost', settle: 'later' },
                ],
                needsAnswer: true,
                ref: `vault:${id}`,
                source: 'vault',
                agentId,
                ...(app.chats.runChat(ctx.run.id) ? { chatId: app.chats.runChat(ctx.run.id)! } : {}),
              },
            })
            .catch(() => {});
          return { requestId: id, state: 'pending' as const, reference: reference(i.name) };
        },
      });
      app.tools.add({
        name: 'vault_list_secrets',
        title: 'List my keys',
        description:
          'The secrets the owner granted to you, as references ({{secret:NAME}}) you can pass to tools, plus your key requests still waiting. Values are never shown.',
        input: z.object({}),
        tier: 0,
        handler: async (_i, ctx: ToolCtx) => {
          const granted = (await agentSecrets(ctx.agent.id)).map((s) => ({
            name: s.name,
            reference: reference(s.name),
            backend: s.backend,
          }));
          const waiting = (
            db
              .prepare(
                "SELECT name FROM vault_request WHERE agent_id = ? AND state = 'pending' ORDER BY created_at",
              )
              .all(ctx.agent.id) as { name: string }[]
          ).map((r) => r.name);
          return { granted, waiting };
        },
      });

      // ---------- owner REST (Settings → Vault) ----------
      const view = (s: SecretMeta, agents: Map<string, AgentDTO>) => {
        const agentId = s.scope.startsWith('agent:') ? s.scope.slice(6) : null;
        const brainId = s.scope.startsWith('brain:') ? s.scope.slice(6) : null;
        return {
          id: s.id,
          name: s.name,
          scope: s.scope,
          kind: s.scope === 'global' ? 'global' : agentId ? 'agent' : brainId ? 'brain' : 'module',
          agentId,
          agentName: agentId ? (agents.get(agentId)?.name ?? null) : null,
          brainId,
          brainName: brainId ? (brains().find((b) => b.id === brainId)?.name ?? brainId) : null,
          backend: s.backend,
          reference: agentId ? reference(s.name) : null,
          createdAt: s.createdAt,
          rotatedAt: s.rotatedAt,
        };
      };
      const requestView = (r: RequestRow, agents: Map<string, AgentDTO>) => ({
        id: r.id,
        agentId: r.agent_id,
        agentName: agents.get(r.agent_id)?.name ?? null,
        name: r.name,
        reason: app.redact(r.reason),
        state: r.state,
        // a request caused by anyone but the owner (a channel stranger, a webhook, another agent) may be a lure
        untrusted: r.origin_sender !== 'owner',
        createdAt: r.created_at,
      });
      // brains that take an API key from the vault (`keyEnv`): the owner can save "Key for <brain>"
      const brains = () =>
        app.providers
          .list()
          .filter((p) => p.keyEnv?.length)
          .map((p) => ({ id: p.id as string, name: p.displayName, keys: [...(p.keyEnv ?? [])] }));
      const agentMap = async () => new Map((await app.agents.list()).map((a) => [a.id, a] as const));

      app.http.route({
        method: 'GET',
        url: '/overview',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const agents = await agentMap();
          let secrets: ReturnType<typeof view>[] = [];
          let available = true;
          try {
            secrets = (await app.vault.list()).map((s) => view(s, agents));
          } catch {
            available = false;
          }
          const requests = (
            db
              .prepare("SELECT * FROM vault_request WHERE state = 'pending' ORDER BY created_at")
              .all() as RequestRow[]
          ).map((r) => requestView(r, agents));
          return {
            available,
            // module-owned entries (channel tokens, password-manager sessions) are listed by count only
            secrets: secrets.filter((s) => s.kind !== 'module'),
            moduleEntries: secrets.filter((s) => s.kind === 'module').length,
            requests,
            agents: [...agents.values()].map((a) => ({ id: a.id, name: a.name })),
            brains: brains(),
            backends: (['bitwarden', '1password'] as const).map((id) => ({
              id,
              sessionSet: secrets.some((s) => s.scope === MODULE_SCOPE && s.name === SESSION_NAME[id]),
              // turned off at boot because the server's user could swap its CLI (shown in Settings → Vault)
              disabled: backends[id].pinned.problem === 'unsafe_bin' ? ('unsafe_bin' as const) : null,
            })),
            lastRotatedAt: app.config.get<number | null>('lastRotatedAt', null),
          };
        },
      });

      const target = z.string().min(1).max(80); // 'global', an agent id, or 'brain:<providerId>'
      const scopeFor = async (t: string, n: string) => {
        if (t === 'global') return 'global';
        if (t.startsWith('brain:')) {
          const b = brains().find((x) => `brain:${x.id}` === t);
          if (!b) throw new HttpError(400, 'no such brain', 'unknown_brain');
          // a brain scope holds only the key names that brain declares (they go into its env)
          if (!b.keys.includes(n))
            throw new HttpError(400, `that brain's key is ${b.keys.join(', ')}`, 'bad_name');
          return t;
        }
        if (!(await app.agents.get(t))) throw new HttpError(400, 'no such agent', 'unknown_agent');
        return `agent:${t}`;
      };
      const store = async (
        scope: string,
        n: string,
        b: { value?: string; backend?: string; ref?: string },
      ) => {
        if (b.value !== undefined) return app.vault.put(scope, n, b.value);
        if (!b.backend || !b.ref)
          throw new HttpError(400, 'a value, or a backend and a reference', 'invalid_input');
        const be = backends[b.backend as keyof typeof backends];
        if (!be?.validate(b.ref))
          throw new HttpError(400, 'that reference is not valid for the backend', 'bad_ref');
        return app.vault.putRef(scope, n, b.backend, b.ref);
      };
      const secretIn = z
        .object({ target, name, value: value.optional(), backend: backendId.optional(), ref: ref.optional() })
        .refine(
          (b) => (b.value !== undefined) !== (b.backend !== undefined),
          'give a value or a backend reference',
        );

      app.http.route({
        method: 'POST',
        url: '/secrets',
        auth: 'session',
        body: secretIn,
        handler: async (ctx) => {
          ownerOnly(ctx);
          const scope = await scopeFor(ctx.body.target, ctx.body.name);
          const r = await store(scope, ctx.body.name, ctx.body);
          app.log.info('vault entry saved by owner', { scope, name: r.name });
          return httpResponse(201, { id: r.id, scope, name: r.name });
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/secrets/:id',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const s = (await app.vault.list()).find((x) => x.id === ctx.params.id);
          // module-owned entries (a channel's token) are removed with the thing that owns them, not here
          if (!s || !(s.scope === 'global' || s.scope.startsWith('agent:') || s.scope.startsWith('brain:')))
            throw new HttpError(404, 'no such secret', 'not_found');
          await app.vault.remove(s.id);
          app.log.info('vault entry removed by owner', { scope: s.scope, name: s.name });
          return httpResponse(204);
        },
      });

      app.http.route({
        method: 'PUT',
        url: '/backends/:id/session',
        auth: 'session',
        body: z.object({ token: z.string().max(16_384) }),
        handler: async (ctx) => {
          ownerOnly(ctx);
          const id = backendId.safeParse(ctx.params.id);
          if (!id.success) throw new HttpError(404, 'no such backend', 'not_found');
          const n = SESSION_NAME[id.data];
          if (ctx.body.token) await app.vault.put(MODULE_SCOPE, n, ctx.body.token);
          else {
            const hit = (await app.vault.list(MODULE_SCOPE)).find((s) => s.name === n);
            if (hit) await app.vault.remove(hit.id);
          }
          return httpResponse(204);
        },
      });
      app.http.route({
        method: 'POST',
        url: '/backends/:id/test',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const id = backendId.safeParse(ctx.params.id);
          if (!id.success) throw new HttpError(404, 'no such backend', 'not_found');
          return backends[id.data].check();
        },
      });

      const fillIn = z
        .object({ value: value.optional(), backend: backendId.optional(), ref: ref.optional() })
        .refine(
          (b) => (b.value !== undefined) !== (b.backend !== undefined),
          'give a value or a backend reference',
        );
      app.http.route({
        method: 'POST',
        url: '/requests/:id/fill',
        auth: 'session',
        body: fillIn,
        handler: async (ctx) => {
          ownerOnly(ctx);
          const r = getReq(ctx.params.id!);
          if (r?.state !== 'pending') throw new HttpError(404, 'no such open request', 'not_found');
          const saved = await store(`agent:${r.agent_id}`, r.name, ctx.body);
          db.prepare(
            "UPDATE vault_request SET state = 'filled', secret_id = ?, decided_at = ? WHERE id = ?",
          ).run(saved.id, Date.now(), r.id);
          await notice(app, r, `The owner added ${r.name}. Use ${reference(r.name)} where a tool needs it.`);
          app.cards.settleRef(`vault:${r.id}`, {
            state: 'done',
            settled: { key: 'vault:card.request.given' },
          });
          app.log.info('vault request filled', { agentId: r.agent_id, name: r.name });
          return {
            id: r.id,
            state: 'filled',
            reference: reference(r.name),
            agentName: await agentName(r.agent_id),
          };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/requests/:id/decline',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const r = getReq(ctx.params.id!);
          if (r?.state !== 'pending') throw new HttpError(404, 'no such open request', 'not_found');
          db.prepare("UPDATE vault_request SET state = 'declined', decided_at = ? WHERE id = ?").run(
            Date.now(),
            r.id,
          );
          await notice(app, r, `The owner declined the request for ${r.name}.`);
          app.cards.settleRef(`vault:${r.id}`, {
            state: 'dismissed',
            settled: { key: 'vault:card.request.declined' },
          });
          return { id: r.id, state: 'declined' };
        },
      });

      // the only key rotation in the product: a new data key, every local secret re-encrypted, the key re-wrapped
      app.http.route({
        method: 'POST',
        url: '/rotate',
        auth: 'session',
        body: z.object({ confirm: z.literal(true) }),
        handler: async (ctx) => {
          ownerOnly(ctx);
          const local = (await app.vault.list()).filter((s) => s.backend === 'local').length;
          await app.vault.rotateKey();
          const at = Date.now();
          app.config.set('lastRotatedAt', at);
          app.log.info('vault key rotated by owner', { secrets: local });
          return { rotated: local, at };
        },
      });
    },
  });
}

/** A system line in the chat the request came from, so the owner and the agent's next turn see the outcome. */
async function notice(app: ModuleHost, r: RequestRow, body: string) {
  if (!r.chat_id) return;
  try {
    app.chats.post(asSystem('vault: outcome of an agent key request'), {
      chatId: r.chat_id,
      authorKind: 'system',
      authorId: null,
      body,
    });
  } catch (e) {
    app.log.warn('vault request notice not posted', { reason: (e as Error).message });
  }
}

export { CliError };
export default createVaultModule();
