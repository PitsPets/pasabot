/**
 * W13 connectors: the catalogue (`catalog/connectors/<slug>/<version>.json` plus the owner's own folder), installs
 * with secrets kept in the vault, and a generic OAuth2 PKCE helper whose callback is a public hook. The owner
 * brings the OAuth client (client id, optional secret); there is no shared vendor client. An MCP-kind install is
 * handed to the mcp module as a `connectors.mcp` event on `module:connectors` (refs only, never secret values).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type SecretRef,
} from '@pasabot/core';
import { type ActionClass, httpUrlSchema } from '@pasabot/protocol';
import { z } from 'zod';
import { createDetector, type Need } from './detect.js';
import { discoverSignIn, registerClient, SignInError } from './discover.js';
import {
  FOUND_APPS,
  type FoundApp,
  type FoundItem,
  fingerprint,
  listFound,
  readFound,
  scanHome,
} from './found.js';
import {
  fillFields,
  latest,
  loadCatalog,
  type Manifest,
  OAUTH_TOKEN,
  registersClient,
  toolClassesOf,
} from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));

/** What the mcp module receives for an MCP-kind install (secret values never travel, only vault refs). */
export interface ConnectorMcpEvent {
  installId: string;
  serverId: string;
  name: string;
  removed?: boolean;
  transport?: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  secrets?: Record<string, SecretRef>;
  allowHosts?: string[];
  tier?: number;
  /** false: a new server starts switched off (a found server: the owner turns it on after seeing it) */
  enabled?: boolean;
  /** the manifest's action class per tool name (ARCHITECTURE 7.1 "Always asks") */
  toolClasses?: Record<string, ActionClass>;
  /**
   * W36: helpers that may use a NEW server (level `use`), chosen when the owner adds it from the catalogue: the main
   * helper only. Ignored for a server that already exists; the owner changes it on the page afterwards.
   */
  useBy?: string[];
  /**
   * a boot-time re-announce (answering `mcp.ready`): only `toolClasses` is meant, so a server installed before the
   * manifest declared classes gets them; the receiver changes nothing else and creates nothing
   */
  classesOnly?: boolean;
}
declare module '@pasabot/protocol' {
  interface EventMap {
    'connectors.mcp': ConnectorMcpEvent;
    /** an install changed (owner topic: the Connectors page refreshes) */
    'connectors.changed': { installId: string; status?: string; removed?: boolean };
  }
}

/** W36: the "<App> is connected" card in the main helper's chat (the web adds two things to try asking) */
export const CONNECTED_KIND = 'connectors.connected';
const connectedBlock = z.object({
  slug: z.string().min(1).max(48),
  name: z.string().min(1).max(80),
  installId: z.string().min(1).max(64),
});
const ORCHESTRATOR_AGENT = 'module:orchestrator:agentId';

const CLIENT_SECRET = '_client_secret';
const REFRESH = '_refresh_token';
const OAUTH_TTL = 10 * 60_000;
export const CALLBACK_PATH = '/hooks/connectors/oauth/callback';

interface InstallRow {
  id: string;
  manifest_id: string;
  version: string;
  config: string;
  secret_refs: string;
  status: 'ready' | 'needs_auth' | 'error';
  created_at: number;
}

const installIn = z.object({
  slug: z.string().min(1).max(48),
  values: z.record(z.string().max(40), z.string().max(8000)).default({}),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().min(1).max(2000).optional(),
  /**
   * W37: a hosted app with a code: list its tools before it counts as added. When that fails nothing is kept and the
   * answer names the plain reason (`test_code` / `test_unreachable` / `test_refused`).
   */
  test: z.boolean().optional(),
  /**
   * W37: an app with its own sign-in: start the sign-in in the same request. When it cannot start nothing is kept
   * and the answer is the `signin_*` reason, so the card keeps its place and says why.
   */
  signIn: z.boolean().optional(),
});
/** W37: why an app's test failed, in plain reasons (from the mcp module's `mcp.tested`) */
const TEST_REASONS = ['code', 'unreachable', 'refused'] as const;
type TestReason = (typeof TEST_REASONS)[number];
/** W37: how long an add waits for the app to list its tools */
const TEST_WAIT_MS = 30_000;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 365 * 86400)
    .optional(),
});

const foundIn = z.object({
  app: z.enum(FOUND_APPS as [FoundApp, ...FoundApp[]]),
  name: z.string().min(1).max(80),
  /** the fingerprint the listing gave: what is imported must be what the owner was shown */
  fp: z.string().min(1).max(64),
});
/** an imported server's install row: `found:<app>:<name>` (a catalogue slug never has a colon) */
const foundId = (app: string, name: string) => `found:${app}:${name}`;
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';

/** a catalogue card's one state: added, ready to add, needs a sign-in or key, or something is not on this computer */
export type CardState = 'added' | 'ready' | 'needs_key' | 'missing';

function ownerOnly(ctx: AuthedCtx<unknown>) {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner manages connectors', 'forbidden');
}
const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

export function catalogDirs(app: Pick<ModuleHost, 'dataDir'>): string[] {
  const extra = (process.env.PASABOT_CONNECTORS_CATALOG ?? '').split(delimiter).filter(Boolean);
  return [join(here, '..', '..', '..', 'catalog', 'connectors'), ...extra, join(app.dataDir, 'catalog')];
}

export default defineModule({
  id: 'connectors',
  migrations: join(here, '..', 'migrations'),
  register(app) {
    app.blocks.register(CONNECTED_KIND, connectedBlock);
    const warned = new Set<string>();
    const catalog = () => {
      const { entries, problems } = loadCatalog(catalogDirs(app));
      for (const p of problems)
        if (!warned.has(p.file)) {
          warned.add(p.file);
          app.log.warn('connector manifest skipped', { file: p.file, error: p.error });
        }
      return { all: entries.map((e) => e.manifest), latest: latest(entries), problems };
    };
    const manifestOf = (slug: string, version?: string): Manifest | undefined => {
      const c = catalog();
      return version ? c.all.find((m) => m.slug === slug && m.version === version) : c.latest.get(slug);
    };
    // is what a connector needs already here? (looked up on PATH and in the apps folder, never run; cached briefly)
    const detector = createDetector();
    const row = (id: string) =>
      app.raw.prepare('SELECT * FROM connectors_install WHERE id = ?').get(id) as InstallRow | undefined;
    const changed = (installId: string, extra: { status?: string; removed?: boolean } = {}) =>
      app.bus.publish('owner', 'connectors.changed', { installId, ...extra });

    /**
     * hand an MCP-kind install to the mcp module; `verify`: the mcp module lists its tools now and answers with
     * `mcp.tested` (the "<App> is connected" card waits for that answer)
     */
    const publishMcp = (r: InstallRow, m: Manifest, fresh = false, verify = false) => {
      if (m.kind === 'oauth-api' || !m.mcp) return;
      const main = fresh ? mainHelper() : null;
      const config = JSON.parse(r.config) as Record<string, string>;
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      const f = (t: string) => fillFields(t, config);
      const map = (o?: Record<string, string>) =>
        Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, f(v)]));
      const secrets = Object.fromEntries(Object.entries(refs).filter(([k]) => !k.startsWith('_')));
      const ev: ConnectorMcpEvent = {
        installId: r.id,
        serverId: m.slug,
        name: m.name,
        transport: m.kind === 'mcp-http' ? 'http' : 'stdio',
        command: m.mcp.command ?? null,
        args: (m.mcp.args ?? []).map(f),
        url: m.mcp.url ? f(m.mcp.url) : null,
        env: map(m.mcp.env),
        headers: map(m.mcp.headers),
        secrets,
        allowHosts: m.network?.allowHosts ?? [],
        tier: m.defaultTier ?? 2,
        ...(m.toolClasses || m.destructive ? { toolClasses: toolClassesOf(m) } : {}),
        ...(main ? { useBy: [main] } : {}),
        ...(verify ? { verify: true } : {}),
      };
      app.bus.publish('module:connectors', 'connectors.mcp', ev);
    };
    /** the main helper (the built-in team builder's agent), or null before there is one */
    const mainHelper = (): string | null => {
      const r = app.raw.prepare('SELECT value FROM settings WHERE key = ?').get(ORCHESTRATOR_AGENT) as
        | { value: string }
        | undefined;
      try {
        const v = r ? (JSON.parse(r.value) as unknown) : null;
        return typeof v === 'string' && v ? v : null;
      } catch {
        return null;
      }
    };
    /**
     * W36: a card in the main helper's own chat: "<App> is connected", with two things to try asking. W37: only after
     * the app listed its tools (`mcp.tested` ok), and once per add (`_card` goes from `pending` to `posted`).
     */
    const connectedCard = (r: InstallRow, m: Manifest) => {
      if (m.kind === 'oauth-api' || !m.mcp) return;
      const config = JSON.parse(r.config) as Record<string, string>;
      if (config._card !== 'pending') return;
      config._card = 'posted';
      app.raw
        .prepare('UPDATE connectors_install SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), r.id);
      const main = mainHelper();
      // the main helper's own chat (opened when it has none yet: the card always has a place)
      const chatId = main ? app.chats.ownChat(main, { create: true }) : null;
      if (!chatId) return;
      try {
        app.chats.post(asSystem('connectors: an app was connected'), {
          chatId,
          authorKind: 'system',
          authorId: null,
          body: app.i18n.t('connectors:server.connected', { name: m.name }),
          blocks: [{ kind: CONNECTED_KIND, v: 1, data: { slug: m.slug, name: m.name, installId: r.id } }],
        });
      } catch (e) {
        app.log.warn('connected card not posted', { error: app.redact((e as Error).message) });
      }
    };
    /** W37: an add waiting for the app's answer (the install id -> what to do with it) */
    const waiting = new Map<string, (t: { ok: boolean; reason?: TestReason }) => void>();
    /** W37: ask for the connected card once this install's app has listed its tools */
    const cardPending = (id: string) => {
      const r = row(id);
      if (!r) return;
      const config = JSON.parse(r.config) as Record<string, string>;
      config._card = 'pending';
      app.raw
        .prepare('UPDATE connectors_install SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), id);
    };
    app.bus.subscribe((ev) => {
      if ((ev.type as string) !== 'mcp.tested' || ev.topic !== 'module:mcp') return;
      const d = ev.data as { source?: unknown; ok?: unknown; reason?: unknown };
      if (typeof d.source !== 'string' || !d.source.startsWith('connector:')) return;
      const id = d.source.slice('connector:'.length);
      const answer = {
        ok: d.ok === true,
        ...(d.ok === true
          ? {}
          : { reason: (TEST_REASONS.includes(d.reason as TestReason) ? d.reason : 'refused') as TestReason }),
      };
      const w = waiting.get(id);
      if (w) {
        waiting.delete(id);
        w(answer);
        return;
      }
      if (!answer.ok) return;
      const r = row(id);
      const m = r ? manifestOf(r.manifest_id, r.version) : undefined;
      if (r && m && r.status === 'ready') connectedCard(r, m);
    });
    /** W37: remove an install that never counted as added: its row, its server, its secrets; no page refresh */
    const discard = async (id: string) => {
      const r = row(id);
      if (!r) return;
      app.raw.prepare('DELETE FROM connectors_install WHERE id = ?').run(id);
      app.bus.publish('module:connectors', 'connectors.mcp', {
        installId: id,
        serverId: r.manifest_id,
        name: r.manifest_id,
        removed: true,
      });
      for (const ref of Object.values(JSON.parse(r.secret_refs) as Record<string, SecretRef>))
        await app.vault.remove(ref.id).catch(() => false);
    };

    // the mcp module is listening (7.1): announce each ready MCP install's declared tool classes again, so a server
    // installed before its manifest declared them (or an older manifest) carries the current ones
    app.bus.subscribe((ev) => {
      // `mcp.ready` is the mcp module's own event (declared there), so it is matched as a plain string here
      if ((ev.type as string) !== 'mcp.ready' || ev.topic !== 'module:mcp') return;
      const rows = app.raw
        .prepare("SELECT * FROM connectors_install WHERE status = 'ready'")
        .all() as InstallRow[];
      for (const r of rows) {
        const m = manifestOf(r.manifest_id, r.version);
        if (!m || m.kind === 'oauth-api' || !m.mcp) continue;
        app.bus.publish('module:connectors', 'connectors.mcp', {
          installId: r.id,
          serverId: m.slug,
          name: m.name,
          toolClasses: toolClassesOf(m),
          classesOnly: true,
        });
      }
    });

    const view = (r: InstallRow) => {
      const m = manifestOf(r.manifest_id, r.version);
      const config = JSON.parse(r.config) as Record<string, string>;
      const found = config._found ?? null;
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      const oauth = app.raw
        .prepare('SELECT expires_at, connected_at FROM connectors_oauth WHERE install_id = ?')
        .get(r.id) as { expires_at: number | null; connected_at: number } | undefined;
      return {
        id: r.id,
        slug: r.manifest_id,
        version: r.version,
        name: m?.name ?? config._name ?? r.manifest_id,
        kind: m?.kind ?? (found ? (config._transport === 'http' ? 'mcp-http' : 'mcp-stdio') : null),
        found,
        status: r.status,
        values: Object.fromEntries(Object.entries(config).filter(([k]) => !k.startsWith('_'))),
        clientId: config._client_id ?? null,
        // W36: this install signs in (its own pages or the owner's client); the page shows Sign in until it has
        signIn: m?.auth?.type === 'oauth2_pkce',
        secretKeys: Object.keys(refs)
          .filter((k) => !k.startsWith('_'))
          .map((k) => (found ? k.replace(/^(env|h)\./, '') : k)),
        oauth: oauth ? { connectedAt: oauth.connected_at, expiresAt: oauth.expires_at } : null,
        // added, but what it runs with is not on this computer (yet): the row says so instead of "Added"
        missing: m && !found ? missingOf(m) : null,
        createdAt: r.created_at,
      };
    };
    const missingOf = (m: Manifest): Need | null => {
      const d = detector(m);
      return d.here ? null : d.missing;
    };
    const stateOf = (m: Manifest, installed: number): { state: CardState; missing: Need | null } => {
      if (installed > 0) return { state: 'added', missing: null };
      const d = detector(m);
      if (!d.here) return { state: 'missing', missing: d.missing };
      const key = m.auth?.type === 'oauth2_pkce' || (m.auth?.fields ?? []).some((f) => f.secret);
      return { state: key ? 'needs_key' : 'ready', missing: null };
    };

    // ---------- catalogue + installs (owner REST) ----------
    app.http.route({
      method: 'GET',
      url: '/catalog',
      auth: 'session',
      handler: (ctx) => {
        ownerOnly(ctx);
        const c = catalog();
        const installed = app.raw
          .prepare(
            "SELECT manifest_id, count(*) AS n FROM connectors_install WHERE json_extract(config, '$._testing') IS NULL GROUP BY manifest_id",
          )
          .all() as { manifest_id: string; n: number }[];
        const count = new Map(installed.map((i) => [i.manifest_id, i.n]));
        return {
          connectors: [...c.latest.values()]
            .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
            .map((m) => ({
              slug: m.slug,
              name: m.name,
              version: m.version,
              category: m.category,
              summary: m.summary,
              homepage: m.homepage ?? null,
              source: m.source ?? null,
              group: m.group ?? 'other',
              popular: m.popular === true,
              kind: m.kind,
              auth: {
                type: m.auth?.type ?? 'none',
                fields: m.auth?.fields ?? [],
                // W36: 'own' = the app's own sign-in page, nothing to type; 'owner' = the owner's OAuth client
                signIn: m.auth?.type === 'oauth2_pkce' ? (registersClient(m) ? 'own' : 'owner') : null,
                keyPage: m.auth?.keyPage ?? null,
              },
              defaultTier: m.defaultTier ?? 2,
              installed: count.get(m.slug) ?? 0,
              ...stateOf(m, count.get(m.slug) ?? 0),
            })),
          problems: c.problems.length,
        };
      },
    });

    // ---------- found on this computer: other apps' tool servers, by name only ----------
    let foundCache: { at: number; home: string; items: FoundItem[] } | null = null;
    const foundNow = () => {
      const home = scanHome();
      if (!foundCache || foundCache.home !== home || Date.now() - foundCache.at > 10_000)
        foundCache = { at: Date.now(), home, items: listFound(home) };
      return foundCache.items;
    };
    app.http.route({
      method: 'GET',
      url: '/found',
      auth: 'session',
      handler: (ctx) => {
        ownerOnly(ctx);
        const added = new Set(
          (
            app.raw
              .prepare("SELECT manifest_id FROM connectors_install WHERE manifest_id LIKE 'found:%'")
              .all() as { manifest_id: string }[]
          ).map((r) => r.manifest_id),
        );
        return {
          found: foundNow().map((f) => ({
            app: f.app,
            name: f.name,
            transport: f.transport,
            keys: f.keys,
            blocked: f.blocked,
            fp: f.fp,
            added: added.has(foundId(f.app, f.name)),
          })),
        };
      },
    });
    app.http.route({
      method: 'POST',
      url: '/found',
      auth: 'session',
      body: foundIn,
      handler: async (ctx) => {
        ownerOnly(ctx);
        const { app: from, name } = ctx.body;
        const spec = readFound(from, name, scanHome());
        if (!spec) throw new HttpError(404, 'that tool server is not set up on this computer', 'not_found');
        // the file is read again here: it must still say exactly what was listed (nothing swapped in between)
        if (fingerprint(from, name, spec) !== ctx.body.fp) {
          foundCache = null;
          throw new HttpError(409, 'that tool server changed since the page loaded; look again', 'changed');
        }
        if (spec.blocked)
          throw new HttpError(400, 'this one keeps a key in its command; add it by hand', 'add_by_hand');
        const mid = foundId(from, name);
        if (app.raw.prepare('SELECT 1 FROM connectors_install WHERE manifest_id = ?').get(mid))
          throw new HttpError(409, 'already added', 'exists');
        const id = randomUUID();
        // every env and header value goes straight to the vault; the row and the event hold refs only
        const refs: Record<string, SecretRef> = {};
        const env: Record<string, string> = {};
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(spec.env)) {
          if (!v) {
            env[k] = '';
            continue;
          }
          refs[`env.${k}`] = await app.vault.put('connectors', `${id}/env.${k}`, v);
          env[k] = `{{secret:env.${k}}}`;
        }
        for (const [k, v] of Object.entries(spec.headers)) {
          if (!v) continue;
          refs[`h.${k}`] = await app.vault.put('connectors', `${id}/h.${k}`, v);
          headers[k] = `{{secret:h.${k}}}`;
        }
        const config = { _name: name, _found: from, _transport: spec.transport };
        app.raw
          .prepare(
            "INSERT INTO connectors_install (id, manifest_id, version, config, secret_refs, status, created_at) VALUES (?, ?, '0.0.0', ?, ?, 'ready', ?)",
          )
          .run(id, mid, JSON.stringify(config), JSON.stringify(refs), Date.now());
        const ev: ConnectorMcpEvent = {
          installId: id,
          serverId: slugify(name),
          name,
          transport: spec.transport,
          command: spec.command,
          args: spec.args,
          url: spec.url,
          env,
          headers,
          secrets: refs,
          allowHosts: [],
          tier: 2,
          // another app's word is not enough to let agents start it: it is added switched off
          enabled: false,
        };
        app.bus.publish('module:connectors', 'connectors.mcp', ev);
        foundCache = null;
        changed(id, { status: 'ready' });
        return httpResponse(201, view(row(id)!));
      },
    });
    app.http.route({
      method: 'GET',
      url: '/installs',
      auth: 'session',
      handler: (ctx) => {
        ownerOnly(ctx);
        const rows = app.raw
          .prepare(
            "SELECT * FROM connectors_install WHERE json_extract(config, '$._testing') IS NULL ORDER BY created_at, id",
          )
          .all() as InstallRow[];
        return { installs: rows.map(view) };
      },
    });
    app.http.route({
      method: 'POST',
      url: '/installs',
      auth: 'session',
      body: installIn,
      handler: async (ctx) => {
        ownerOnly(ctx);
        const b = ctx.body;
        const m = manifestOf(b.slug);
        if (!m) throw new HttpError(404, 'no such connector in the catalogue', 'not_found');
        const fields = m.auth?.fields ?? [];
        for (const k of Object.keys(b.values))
          if (!fields.some((f) => f.key === k))
            throw new HttpError(400, `unknown field ${k}`, 'invalid_input');
        for (const f of fields)
          if (!b.values[f.key]?.trim()) throw new HttpError(400, `${f.label} is required`, 'invalid_input');
        const oauth = m.auth?.type === 'oauth2_pkce';
        const test = !!b.test && !oauth && !!m.mcp;
        if (oauth && !registersClient(m) && !b.clientId)
          throw new HttpError(400, 'an OAuth client id is required', 'invalid_input');
        const id = randomUUID();
        const config: Record<string, string> = {};
        for (const f of fields) if (!f.secret) config[f.key] = b.values[f.key]!.trim();
        if (m.mcp?.url && !httpUrlSchema.safeParse(fillFields(m.mcp.url, config)).success)
          throw new HttpError(400, 'the address this connector builds is not a valid URL', 'invalid_input');
        if (oauth && !registersClient(m)) config._client_id = b.clientId!;
        // W37: hidden from the page until the app has answered
        if (test) config._testing = '1';
        const refs: Record<string, SecretRef> = {};
        for (const f of fields)
          if (f.secret) refs[f.key] = await app.vault.put('connectors', `${id}/${f.key}`, b.values[f.key]!);
        if (oauth && b.clientSecret)
          refs[CLIENT_SECRET] = await app.vault.put('connectors', `${id}/client_secret`, b.clientSecret);
        app.raw
          .prepare(
            'INSERT INTO connectors_install (id, manifest_id, version, config, secret_refs, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            m.slug,
            m.version,
            JSON.stringify(config),
            JSON.stringify(refs),
            oauth ? 'needs_auth' : 'ready',
            Date.now(),
          );
        if (!oauth && m.mcp) cardPending(id);
        const r = row(id)!;
        if (test) {
          const answer = await new Promise<{ ok: boolean; reason?: TestReason }>((resolve) => {
            const timer = setTimeout(() => {
              waiting.delete(id);
              resolve({ ok: false, reason: 'unreachable' });
            }, TEST_WAIT_MS);
            timer.unref?.();
            waiting.set(id, (a) => {
              clearTimeout(timer);
              resolve(a);
            });
            publishMcp(r, m, true, true);
          });
          if (!answer.ok) {
            // it did not work: nothing is kept, nothing is listed, no card
            await discard(id);
            const reason = answer.reason ?? 'refused';
            throw new HttpError(
              reason === 'code' ? 400 : 502,
              reason === 'code'
                ? 'the app did not accept that code'
                : reason === 'unreachable'
                  ? 'the app could not be reached'
                  : 'the app refused',
              `test_${reason}`,
            );
          }
          const ok = row(id)!;
          const config2 = JSON.parse(ok.config) as Record<string, string>;
          delete config2._testing;
          app.raw
            .prepare('UPDATE connectors_install SET config = ? WHERE id = ?')
            .run(JSON.stringify(config2), id);
          connectedCard(row(id)!, m);
        } else if (!oauth) publishMcp(r, m, true, true);
        if (oauth && b.signIn) {
          // W37: the sign-in starts now; when it cannot, the half-added app is not kept
          try {
            const started = await startSignIn(row(id)!, ctx.headers);
            changed(id, { status: 'needs_auth' });
            return httpResponse(201, { ...view(row(id)!), ...started });
          } catch (e) {
            await discard(id);
            throw e;
          }
        }
        changed(id, { status: r.status });
        return httpResponse(201, view(row(id)!));
      },
    });
    app.http.route({
      method: 'DELETE',
      url: '/installs/:id',
      auth: 'session',
      handler: (ctx) => {
        ownerOnly(ctx);
        const r = row(ctx.params.id!);
        if (!r) throw new HttpError(404, 'no such install', 'not_found');
        app.raw.prepare('DELETE FROM connectors_install WHERE id = ?').run(r.id);
        app.bus.publish('module:connectors', 'connectors.mcp', {
          installId: r.id,
          serverId: r.manifest_id,
          name: r.manifest_id,
          removed: true,
        });
        changed(r.id, { removed: true });
        return httpResponse(204);
      },
    });

    // ---------- OAuth2 PKCE ----------
    /**
     * A sign-in client: its id and the `secret_refs` key of its secret, if it has one. An app's own sign-in keeps one
     * registered client per return address (`_clients`), so a sign-in started from another address (a phone on the
     * LAN) never changes the client the current tokens belong to. The client that got the tokens becomes the active
     * one (`_client_id` + `_client_secret_key`) only after a successful exchange; refresh always uses that one.
     */
    interface Client {
      clientId: string;
      secretKey?: string;
    }
    const MAX_CLIENTS = 8;
    const clientsOf = (config: Record<string, string>): Record<string, Client> => {
      try {
        const v = JSON.parse(config._clients ?? '{}') as unknown;
        return v && typeof v === 'object' ? (v as Record<string, Client>) : {};
      } catch {
        return {};
      }
    };
    /** the client the stored tokens were issued to (an install from before `_client_secret_key`: `_client_secret`) */
    const activeClient = (r: InstallRow): Client => {
      const config = JSON.parse(r.config) as Record<string, string>;
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      const secretKey =
        '_client_secret_key' in config
          ? config._client_secret_key || undefined
          : refs[CLIENT_SECRET]
            ? CLIENT_SECRET
            : undefined;
      return { clientId: config._client_id ?? '', ...(secretKey ? { secretKey } : {}) };
    };
    /** a page address the app may refuse to send a sign-in back to: plain http and not this computer */
    const insecureOrigin = (origin: string) => {
      try {
        const u = new URL(origin);
        const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const loopback =
          h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
        return u.protocol !== 'https:' && !loopback;
      } catch {
        return true;
      }
    };
    const pending = new Map<
      string,
      { installId: string; verifier: string; redirectUri: string; expires: number; client: Client }
    >();
    const sweep = () => {
      const now = Date.now();
      for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    };
    const oauthOf = (r: InstallRow) => {
      const m = manifestOf(r.manifest_id, r.version);
      if (!m?.auth?.oauth)
        throw new HttpError(400, 'this connector does not sign in with OAuth', 'invalid_input');
      return { m, oauth: m.auth.oauth };
    };
    /** POST the token endpoint (form body) through safe-net; never logs the body */
    const tokenRequest = async (
      r: InstallRow,
      m: Manifest,
      params: Record<string, string>,
      client: Client = activeClient(r),
    ) => {
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      const config = JSON.parse(r.config) as Record<string, string>;
      const form = new URLSearchParams({ ...params, client_id: client.clientId });
      // RFC 8707: a discovered sign-in names the MCP server the token is for
      if (config._resource) form.set('resource', config._resource);
      const secret = client.secretKey ? refs[client.secretKey] : undefined;
      if (secret)
        form.set(
          'client_secret',
          await app.vault.get(secret, { actor: 'connectors', purpose: `oauth ${r.id}` }),
        );
      const tokenUrl = config._token_url ?? ('tokenUrl' in m.auth!.oauth! ? m.auth!.oauth!.tokenUrl : '');
      if (!tokenUrl) throw new Error('sign in first');
      const res = await app.net.fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        allowHosts: m.network?.allowHosts ?? [],
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
      return tokenSchema.parse(await res.json());
    };
    const saveTokens = async (r: InstallRow, m: Manifest, t: z.infer<typeof tokenSchema>) => {
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      refs[OAUTH_TOKEN] = await app.vault.put('connectors', `${r.id}/${OAUTH_TOKEN}`, t.access_token);
      if (t.refresh_token)
        refs[REFRESH] = await app.vault.put('connectors', `${r.id}/refresh_token`, t.refresh_token);
      const now = Date.now();
      app.raw
        .prepare("UPDATE connectors_install SET secret_refs = ?, status = 'ready' WHERE id = ?")
        .run(JSON.stringify(refs), r.id);
      app.raw
        .prepare(
          'INSERT INTO connectors_oauth (install_id, token_secret_id, refresh_secret_id, expires_at, connected_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (install_id) DO UPDATE SET token_secret_id = excluded.token_secret_id, refresh_secret_id = coalesce(excluded.refresh_secret_id, refresh_secret_id), expires_at = excluded.expires_at',
        )
        .run(
          r.id,
          refs[OAUTH_TOKEN].id,
          refs[REFRESH]?.id ?? null,
          t.expires_in ? now + t.expires_in * 1000 : null,
          now,
        );
      const first = r.status !== 'ready';
      if (first) cardPending(r.id);
      // W37: the card waits until the app lists its tools with the new sign-in
      publishMcp(row(r.id)!, m, first, first);
      changed(r.id, { status: 'ready' });
    };

    /**
     * After a successful exchange: the client that got the tokens is the one refresh uses. A replaced client's secret
     * leaves the vault only now, and only when no return address still names it.
     */
    const adoptClient = async (id: string, client: Client, redirectUri: string) => {
      const r = row(id)!;
      const before = activeClient(r);
      const config = JSON.parse(r.config) as Record<string, string>;
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      if (before.clientId === client.clientId && before.secretKey === client.secretKey) return;
      const named = new Set(Object.values(clientsOf(config)).map((c) => c.secretKey));
      if (before.secretKey && before.secretKey !== client.secretKey && !named.has(before.secretKey)) {
        const old = refs[before.secretKey];
        if (old) await app.vault.remove(old.id).catch(() => false);
        delete refs[before.secretKey];
      }
      config._client_id = client.clientId;
      config._client_redirect = redirectUri;
      config._client_secret_key = client.secretKey ?? '';
      app.raw
        .prepare('UPDATE connectors_install SET config = ?, secret_refs = ? WHERE id = ?')
        .run(JSON.stringify(config), JSON.stringify(refs), id);
    };

    /** start a sign-in for an install: the app's own page to open (the return address included) */
    const startSignIn = async (
      r: InstallRow,
      headers: Record<string, string | string[] | undefined>,
    ): Promise<{ authorizeUrl: string; redirectUri: string }> => {
      const { m, oauth } = oauthOf(r);
      sweep();
      if (pending.size > 200) throw new HttpError(429, 'too many sign-ins in progress', 'busy');
      // the page's own origin (core already checked it is an allowed origin), else the allowlisted Host
      const origin = header(headers, 'origin') ?? `http://${header(headers, 'host') ?? 'localhost'}`;
      const redirectUri = `${origin}${CALLBACK_PATH}`;
      let config = JSON.parse(r.config) as Record<string, string>;
      let authorizeUrl = 'authorizeUrl' in oauth ? oauth.authorizeUrl : '';
      let scopes = oauth.scopes ?? [];
      // the owner's own client never changes here; an app's own sign-in picks the one for this return address
      let client: Client = activeClient(r);
      if (registersClient(m)) {
        // W36: the app's own sign-in, found from its address; PasaBot registers once per return address
        const allowHosts = m.network?.allowHosts ?? [];
        try {
          const pages = await discoverSignIn(
            app.net,
            fillFields(m.mcp!.url!, config),
            allowHosts,
            oauth.scopes,
          );
          const clients = clientsOf(config);
          const legacy = config._client_id && config._client_redirect === redirectUri ? client : undefined;
          const known = clients[redirectUri] ?? legacy;
          if (known) client = known;
          else {
            let c: Awaited<ReturnType<typeof registerClient>>;
            try {
              c = await registerClient(app.net, pages, redirectUri, allowHosts);
            } catch (e) {
              // an app that will not send a sign-in back to plain http on another device: say so, never "try later"
              if (e instanceof SignInError && e.reason === 'refused' && insecureOrigin(origin))
                throw new SignInError('insecure', `${e.message}; the return address is not https`);
              throw e;
            }
            const refs = JSON.parse(row(r.id)!.secret_refs) as Record<string, SecretRef>;
            const key = `${CLIENT_SECRET}@${createHash('sha256').update(redirectUri).digest('hex').slice(0, 12)}`;
            if (c.clientSecret)
              refs[key] = await app.vault.put('connectors', `${r.id}/${key}`, c.clientSecret);
            client = { clientId: c.clientId, ...(c.clientSecret ? { secretKey: key } : {}) };
            clients[redirectUri] = client;
            // a few return addresses at most; a dropped one that is not the active client loses its secret too
            const active = activeClient(r);
            for (const u of Object.keys(clients)) {
              if (Object.keys(clients).length <= MAX_CLIENTS) break;
              const old = clients[u]!;
              if (u === redirectUri || old.clientId === active.clientId) continue;
              delete clients[u];
              if (old.secretKey && refs[old.secretKey]) {
                await app.vault.remove(refs[old.secretKey]!.id).catch(() => false);
                delete refs[old.secretKey];
              }
            }
            config = { ...config, _clients: JSON.stringify(clients) };
            app.raw
              .prepare('UPDATE connectors_install SET secret_refs = ? WHERE id = ?')
              .run(JSON.stringify(refs), r.id);
          }
          config = { ...config, _token_url: pages.tokenUrl, _resource: pages.resource };
          app.raw
            .prepare('UPDATE connectors_install SET config = ? WHERE id = ?')
            .run(JSON.stringify(config), r.id);
          authorizeUrl = pages.authorizeUrl;
          scopes = pages.scopes;
        } catch (e) {
          if (!(e instanceof SignInError)) throw e;
          app.log.warn('sign-in could not start', { install: r.id, error: app.redact(e.message) });
          throw new HttpError(502, `sign-in could not start (${e.reason})`, `signin_${e.reason}`);
        }
      }
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      pending.set(state, {
        installId: r.id,
        verifier,
        redirectUri,
        expires: Date.now() + OAUTH_TTL,
        client,
      });
      const url = new URL(authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
      if (config._resource) url.searchParams.set('resource', config._resource);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      return { authorizeUrl: url.toString(), redirectUri };
    };
    app.http.route({
      method: 'POST',
      url: '/installs/:id/oauth/start',
      auth: 'session',
      handler: async (ctx) => {
        ownerOnly(ctx);
        const r = row(ctx.params.id!);
        if (!r) throw new HttpError(404, 'no such install', 'not_found');
        return startSignIn(r, ctx.headers);
      },
    });
    app.publicHttp.route({
      method: 'GET',
      url: '/oauth/callback',
      rateLimit: { max: 30, windowMs: 60_000 },
      bodyLimit: 1024,
      handler: async (ctx) => {
        const q = (k: string) => {
          const v = ctx.query[k];
          return typeof v === 'string' ? v : undefined;
        };
        // the install id lets the page name the app and pick the line for how it signs in
        const back = (outcome: string, id?: string) =>
          httpResponse(302, null, {
            location: `/#/connectors?oauth=${outcome}${id ? `&id=${encodeURIComponent(id)}` : ''}`,
          });
        sweep();
        const state = q('state') ?? '';
        const p = pending.get(state);
        if (p) pending.delete(state); // single use, whatever happens next
        if (!p || p.expires < Date.now()) return back('expired', p?.installId);
        const code = q('code');
        if (q('error') || !code || code.length > 4096) return back('denied', p.installId);
        const r = row(p.installId);
        if (!r) return back('expired');
        try {
          const { m } = oauthOf(r);
          // the client this sign-in was started with, whatever another sign-in did meanwhile
          const t = await tokenRequest(
            r,
            m,
            {
              grant_type: 'authorization_code',
              code,
              redirect_uri: p.redirectUri,
              code_verifier: p.verifier,
            },
            p.client,
          );
          await adoptClient(r.id, p.client, p.redirectUri);
          await saveTokens(row(r.id)!, m, t);
          return back('connected', r.id);
        } catch (e) {
          app.log.warn('oauth sign-in failed', { install: r.id, error: app.redact((e as Error).message) });
          return back('failed', r.id);
        }
      },
    });

    /** refresh one install's access token with its refresh token */
    const refresh = async (r: InstallRow) => {
      const { m } = oauthOf(r);
      const refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
      if (!refs[REFRESH]) throw new HttpError(409, 'no refresh token; sign in again', 'no_refresh_token');
      const rt = await app.vault.get(refs[REFRESH], {
        actor: 'connectors',
        purpose: `oauth refresh ${r.id}`,
      });
      const t = await tokenRequest(r, m, { grant_type: 'refresh_token', refresh_token: rt });
      await saveTokens(r, m, t);
    };
    app.http.route({
      method: 'POST',
      url: '/installs/:id/oauth/refresh',
      auth: 'session',
      handler: async (ctx) => {
        ownerOnly(ctx);
        const r = row(ctx.params.id!);
        if (!r) throw new HttpError(404, 'no such install', 'not_found');
        try {
          await refresh(r);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(502, app.redact((e as Error).message), 'refresh_failed');
        }
        return view(row(r.id)!);
      },
    });
    // tokens that expire within 10 minutes are refreshed in the background
    const timer = setInterval(() => {
      const due = app.raw
        .prepare(
          'SELECT i.* FROM connectors_install i JOIN connectors_oauth o ON o.install_id = i.id WHERE o.refresh_secret_id IS NOT NULL AND o.expires_at IS NOT NULL AND o.expires_at < ?',
        )
        .all(Date.now() + 10 * 60_000) as InstallRow[];
      for (const r of due)
        refresh(r).catch((e) =>
          app.log.warn('oauth refresh failed', { install: r.id, error: app.redact((e as Error).message) }),
        );
    }, 5 * 60_000);
    timer.unref?.();
  },
});
