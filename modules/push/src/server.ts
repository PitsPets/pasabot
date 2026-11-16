/**
 * Web push (W23): the `push` Notifier transport. Each signed-in person can turn notifications on per device (a
 * browser push subscription) and choose what reaches it: approvals, failed runs, finished replies, long-run
 * progress, other alerts. Sources:
 * - core notifications (approval needed, a run failed, server alerts) arrive through `Notifier` with a `category`;
 *   one without a `userId` is the owner's, so only the owner's devices get it;
 * - a reply that finished, and "still working" progress for a long run, come from the bus (`run.started` /
 *   `run.finished`) and go to the people who can read that chat; only runs a person asked for (never routine,
 *   webhook or agent-to-agent work) and replaced on the device by tag `run:<id>`.
 * Delivery: RFC 8291 encryption + RFC 8292 VAPID on node:crypto, POSTed through safe-net, only to known push
 * services (the endpoint host is checked when the subscription is saved and again before every send). The VAPID
 * private key is in the vault; a dead subscription (404/410) is dropped. Endpoints never reach a log.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  type ModuleHost,
  type Notification,
  type PasaBotModule,
  ulid,
} from '@pasabot/core';
import type { RunDTO } from '@pasabot/protocol';
import { z } from 'zod';
import { encryptPayload, generateVapidKeys, type VapidKeys, vapidAuthorization } from './webpush.js';

export { encryptPayload, generateVapidKeys, vapidAuthorization } from './webpush.js';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT_SCOPE = 'module:push';
const VAULT_NAME = 'vapid-private-key';

/** Push services browsers use today. Anything else is refused (no "POST anywhere" for a signed-in person). */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  '*.notify.windows.com',
  '*.push.apple.com',
];
const hostAllowed = (host: string, list: string[]) =>
  list.some((h) =>
    h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h,
  );

export const PREF_KEYS = ['approval', 'error', 'finished', 'progress', 'alert'] as const;
export type PrefKey = (typeof PREF_KEYS)[number];
export type Prefs = Record<PrefKey, boolean>;
export const DEFAULT_PREFS: Prefs = {
  approval: true,
  error: true,
  finished: true,
  progress: false,
  alert: true,
};
const prefFor = (c: Notification['category']): PrefKey =>
  c === 'approval'
    ? 'approval'
    : c === 'run.failed'
      ? 'error'
      : c === 'run.finished'
        ? 'finished'
        : c === 'progress'
          ? 'progress'
          : 'alert';

const TEXT = {
  en: {
    approval: 'Approval needed',
    finished: (a: string) => `${a} replied`,
    working: (a: string, min: number) => `${a} is still working (${min} min)`,
    workingBody: 'You will get the reply here when it is done.',
    test: 'PasaBot notifications are on',
    testBody: 'This device will get the notifications you chose.',
  },
  fil: {
    approval: 'Kailangan ng pahintulot mo',
    finished: (a: string) => `Sumagot na si ${a}`,
    working: (a: string, min: number) => `Gumagawa pa si ${a} (${min} min)`,
    workingBody: 'Dito mo makukuha ang sagot pag tapos na.',
    test: 'Naka-on na ang notifications ng PasaBot',
    testBody: 'Matatanggap ng device na ito ang mga notification na pinili mo.',
  },
} as const;

export interface PushPayload {
  title: string;
  body: string;
  href?: string;
  tag?: string;
  category: Notification['category'] | 'test';
}
type SubRow = {
  id: string;
  user_id: string;
  user_kind: 'owner' | 'member' | 'guest';
  /** the session that turned this device on: the device gets pushes only while it is live */
  session_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  lang: 'en' | 'fil';
  prefs: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
};

export interface PushOptions {
  /** extra push-service hosts (exact or `*.suffix`), e.g. a self-hosted service or a test's mock on 127.0.0.1 */
  extraHosts?: string[];
  /** allow `http:` endpoints (tests' mock push service only) */
  allowInsecure?: boolean;
  /** VAPID `sub` claim: how a push service can reach the operator */
  subject?: string;
  /** first "still working" push after this long (default 2 min; 0 = off), then every `progressEveryMs` */
  progressAfterMs?: number;
  progressEveryMs?: number;
  now?: () => number;
}

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(64) }),
  label: z.string().max(80).optional(),
  lang: z.enum(['en', 'fil']).optional(),
  prefs: z.object(Object.fromEntries(PREF_KEYS.map((k) => [k, z.boolean().optional()]))).optional(),
});

export function createPushModule(o: PushOptions = {}): PasaBotModule & {
  /** for tests: send one payload to every subscription of a person */
  sendTo?: (userId: string, p: PushPayload) => Promise<{ sent: number; failed: number }>;
} {
  const now = o.now ?? Date.now;
  const hosts = [...PUSH_SERVICE_HOSTS, ...(o.extraHosts ?? [])];
  const progressAfter = o.progressAfterMs ?? 120_000;
  const progressEvery = o.progressEveryMs ?? 300_000;
  const mod: PasaBotModule & {
    sendTo?: (userId: string, p: PushPayload) => Promise<{ sent: number; failed: number }>;
  } = defineModule({
    id: 'push',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const db = app.raw;
      const endpointOk = (endpoint: string) => {
        let u: URL;
        try {
          u = new URL(endpoint);
        } catch {
          return false;
        }
        if (u.username || u.password) return false;
        if (u.protocol !== 'https:' && !(o.allowInsecure && u.protocol === 'http:')) return false;
        return hostAllowed(u.hostname.toLowerCase(), hosts);
      };

      // ---------- VAPID keys: public in our table, private in the vault ----------
      let keys: VapidKeys | null = null;
      let keysPending: Promise<VapidKeys> | null = null;
      const loadKeys = async (): Promise<VapidKeys> => {
        if (keys) return keys;
        keysPending ??= (async () => {
          const row = db.prepare('SELECT * FROM push_key WHERE id = 1').get() as
            | { public_key: string; secret_id: string; secret_scope: string; secret_name: string }
            | undefined;
          const why = { actor: 'module:push', purpose: 'sign web push (VAPID)' };
          if (row) {
            const privateKey = await app.vault.get(
              { id: row.secret_id, scope: row.secret_scope, name: row.secret_name },
              why,
            );
            keys = { publicKey: row.public_key, privateKey };
            return keys;
          }
          const k = generateVapidKeys();
          const ref = await app.vault.put(VAULT_SCOPE, VAULT_NAME, k.privateKey);
          db.prepare(
            'INSERT INTO push_key (id, public_key, secret_id, secret_scope, secret_name, created_at) VALUES (1, ?, ?, ?, ?, ?)',
          ).run(k.publicKey, ref.id, ref.scope, ref.name, now());
          keys = k;
          return k;
        })().finally(() => {
          keysPending = null;
        });
        return keysPending;
      };

      const prefsOf = (r: SubRow): Prefs => ({
        ...DEFAULT_PREFS,
        ...(JSON.parse(r.prefs) as Partial<Prefs>),
      });
      const deliver = async (r: SubRow, p: PushPayload): Promise<boolean> => {
        if (!endpointOk(r.endpoint)) {
          db.prepare('DELETE FROM push_sub WHERE id = ?').run(r.id);
          return false;
        }
        try {
          const k = await loadKeys();
          const body = encryptPayload(
            Buffer.from(
              JSON.stringify({
                title: app.redact(p.title).slice(0, 120),
                body: app.redact(p.body).slice(0, 300),
                ...(p.href ? { href: p.href } : {}),
                ...(p.tag ? { tag: p.tag } : {}),
                category: p.category ?? 'alert',
              }),
            ),
            { p256dh: r.p256dh, auth: r.auth },
          );
          const host = new URL(r.endpoint).hostname;
          const res = await app.net.fetch(r.endpoint, {
            method: 'POST',
            headers: {
              authorization: vapidAuthorization(
                k,
                r.endpoint,
                o.subject ?? 'mailto:pasabot@localhost',
                now(),
              ),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: String(p.category === 'progress' ? 600 : 86_400),
              urgency: p.category === 'approval' || p.category === 'run.failed' ? 'high' : 'normal',
              ...(p.tag ? { topic: p.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
            },
            body,
            redirect: 'manual',
            allowHosts: o.extraHosts?.includes(host) ? [host] : [],
          } as RequestInit & { allowHosts: string[] });
          await res.arrayBuffer().catch(() => undefined);
          if (res.status === 404 || res.status === 410) {
            db.prepare('DELETE FROM push_sub WHERE id = ?').run(r.id); // the browser dropped it
            return false;
          }
          if (res.status >= 200 && res.status < 300) {
            db.prepare('UPDATE push_sub SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(now(), r.id);
            return true;
          }
          db.prepare('UPDATE push_sub SET last_error = ? WHERE id = ?').run(`HTTP ${res.status}`, r.id);
          return false;
        } catch (e) {
          // the message never names the endpoint (a capability URL)
          const msg = e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, '[endpoint]') : 'send failed';
          db.prepare('UPDATE push_sub SET last_error = ? WHERE id = ?').run(msg.slice(0, 200), r.id);
          app.log.warn('push.send_failed', { sub: r.id, error: msg.slice(0, 200) });
          return false;
        }
      };
      const sendRows = async (rows: SubRow[], p: (r: SubRow) => PushPayload | null) => {
        let sent = 0;
        let failed = 0;
        await Promise.all(
          rows.map(async (r) => {
            const payload = p(r);
            if (!payload) return;
            if (await deliver(r, payload)) sent++;
            else failed++;
          }),
        );
        return { sent, failed };
      };
      /**
       * Only devices whose session is still signed in: one that was logged out, revoked under Devices, expired or
       * whose person was turned off is dropped here, before anything is sent. The person's kind is the live one.
       */
      const SESSION_CHECK = asSystem('push: is this device still signed in');
      const live = (rows: SubRow[]): SubRow[] =>
        rows.flatMap((r) => {
          const s = r.session_id ? app.sessions.live(SESSION_CHECK, r.session_id) : null;
          if (!s || s.userId !== r.user_id) {
            db.prepare('DELETE FROM push_sub WHERE id = ?').run(r.id);
            return [];
          }
          return [{ ...r, user_kind: s.userKind }];
        });
      const rowsOfUser = (userId: string) =>
        live(db.prepare('SELECT * FROM push_sub WHERE user_id = ?').all(userId) as SubRow[]);
      const allRows = () => live(db.prepare('SELECT * FROM push_sub').all() as SubRow[]);
      mod.sendTo = (userId, p) => sendRows(rowsOfUser(userId), () => p);

      // ---------- the Notifier transport ----------
      app.notifier.addTransport({
        id: 'push',
        async send(n) {
          const key = prefFor(n.category);
          // no userId = the owner's notice (approvals, failed runs, alerts): only the owner's devices
          const rows = (
            n.userId ? rowsOfUser(n.userId) : allRows().filter((r) => r.user_kind === 'owner')
          ).filter((r) => prefsOf(r)[key]);
          const r = await sendRows(rows, (row) => ({
            title: n.category === 'approval' ? TEXT[row.lang].approval : n.title,
            body: n.body ?? '',
            ...(n.href ? { href: n.href } : {}),
            ...(n.tag ? { tag: n.tag } : {}),
            category: n.category ?? 'alert',
          }));
          if (n.via?.includes('push') && r.sent === 0) throw new Error('no device took the push');
        },
      });

      // ---------- finished replies + progress, from the bus ----------
      const progress = new Map<string, { timer: ReturnType<typeof setTimeout>; n: number }>();
      const askedByPerson = (run: RunDTO) => {
        const src = app.queue.input(run.queueItemId)?.source as { sender?: { kind?: string } } | undefined;
        return ['owner', 'member', 'guest'].includes(src?.sender?.kind ?? '');
      };
      const readers = (chatId: string) =>
        allRows().filter(
          (r) => r.user_kind === 'owner' || app.chats.canRead(chatId, { id: r.user_id, kind: r.user_kind }),
        );
      const agentName = async (id: string) => (await app.agents.get(id))?.name ?? 'PasaBot';
      const stopProgress = (runId: string) => {
        const p = progress.get(runId);
        if (p) clearTimeout(p.timer);
        progress.delete(runId);
      };
      const scheduleProgress = (run: RunDTO, chatId: string, after: number, n: number) => {
        if (!(after > 0) || n >= 3) return;
        const timer = setTimeout(async () => {
          const name = await agentName(run.agentId);
          const min = Math.max(1, Math.round((now() - run.startedAt) / 60_000));
          await sendRows(
            readers(chatId).filter((r) => prefsOf(r).progress),
            (r) => ({
              title: TEXT[r.lang].working(name, min),
              body: TEXT[r.lang].workingBody,
              href: `/chats/${chatId}`,
              tag: `run:${run.id}`,
              category: 'progress',
            }),
          ).catch(() => undefined);
          if (progress.has(run.id)) scheduleProgress(run, chatId, progressEvery, n + 1);
        }, after);
        timer.unref?.();
        progress.set(run.id, { timer, n });
      };
      const off = app.bus.subscribe((ev) => {
        if (ev.type !== 'run.started' && ev.type !== 'run.finished') return;
        const run = ev.data as RunDTO;
        if (ev.type === 'run.started') {
          if (progress.has(run.id) || !askedByPerson(run)) return;
          const chatId = app.chats.runChat(run.id);
          if (chatId) scheduleProgress(run, chatId, progressAfter, 0);
          return;
        }
        stopProgress(run.id);
        if (run.state !== 'done' || !askedByPerson(run)) return;
        const chatId = app.chats.runChat(run.id);
        if (!chatId) return;
        void (async () => {
          const name = await agentName(run.agentId);
          const reply = app.chats.runReply(asSystem('push: finished reply preview'), run.id) ?? '';
          const body = reply.replace(/\s+/g, ' ').trim().slice(0, 160);
          await sendRows(
            readers(chatId).filter((r) => prefsOf(r).finished),
            (r) => ({
              title: TEXT[r.lang].finished(name),
              body,
              href: `/chats/${chatId}`,
              tag: `run:${run.id}`,
              category: 'run.finished',
            }),
          );
        })().catch((e) => app.log.warn('push.finished_failed', { error: (e as Error).message }));
      });
      void off;

      // a person the owner disabled (people module) gets nothing more
      app.bus.subscribe((ev) => {
        if ((ev.type as string) === 'people.disabled')
          db.prepare('DELETE FROM push_sub WHERE user_id = ?').run((ev.data as { userId: string }).userId);
      });

      // ---------- REST (any signed-in person, for their own devices) ----------
      const person = (ctx: AuthedCtx<unknown>) => {
        const p = ctx.principal;
        if (p.kind !== 'session') throw new HttpError(401, 'sign in', 'unauthorized');
        return p;
      };
      const subDTO = (r: SubRow) => ({
        id: r.id,
        label: r.label,
        lang: r.lang,
        prefs: prefsOf(r),
        createdAt: r.created_at,
        lastOkAt: r.last_ok_at,
        lastError: r.last_error,
      });
      app.http.route({
        method: 'GET',
        url: '/config',
        auth: 'session',
        handler: async (ctx) => {
          person(ctx);
          try {
            return { available: true, publicKey: (await loadKeys()).publicKey };
          } catch (e) {
            app.log.warn('push.unavailable', { error: (e as Error).message });
            return { available: false, publicKey: null };
          }
        },
      });
      app.http.route({
        method: 'GET',
        url: '/subscriptions',
        auth: 'session',
        handler: (ctx) => ({ subscriptions: rowsOfUser(person(ctx).userId).map(subDTO) }),
      });
      app.http.route({
        method: 'POST',
        url: '/subscriptions',
        auth: 'session',
        body: subscribeSchema,
        bodyLimit: 8192,
        handler: (ctx) => {
          const p = person(ctx);
          const b = ctx.body;
          if (!endpointOk(b.endpoint)) throw new HttpError(400, 'not a known push service', 'bad_endpoint');
          const prefs = { ...DEFAULT_PREFS, ...(b.prefs ?? {}) };
          // one endpoint = one browser: re-subscribing (or another person signing in there) takes it over
          const existing = db.prepare('SELECT id FROM push_sub WHERE endpoint = ?').get(b.endpoint) as
            | { id: string }
            | undefined;
          const id = existing?.id ?? ulid();
          db.prepare(
            `INSERT INTO push_sub (id, user_id, user_kind, session_id, endpoint, p256dh, auth, label, lang, prefs,
                 created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, user_kind = excluded.user_kind,
                 session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, lang = excluded.lang,
                 prefs = excluded.prefs, last_error = NULL`,
          ).run(
            id,
            p.userId,
            p.userKind,
            p.sessionId,
            b.endpoint,
            b.keys.p256dh,
            b.keys.auth,
            (b.label ?? '').trim(),
            b.lang ?? 'en',
            JSON.stringify(prefs),
            now(),
          );
          return subDTO(db.prepare('SELECT * FROM push_sub WHERE id = ?').get(id) as SubRow);
        },
      });
      const mine = (ctx: AuthedCtx<unknown>) => {
        const p = person(ctx);
        const row = db
          .prepare('SELECT * FROM push_sub WHERE id = ? AND user_id = ?')
          .get(ctx.params.id, p.userId) as SubRow | undefined;
        const [r] = row ? live([row]) : [];
        if (!r) throw new HttpError(404, 'no such device', 'not_found');
        return r;
      };
      app.http.route({
        method: 'PATCH',
        url: '/subscriptions/:id',
        auth: 'session',
        body: z.object({
          prefs: z.object(Object.fromEntries(PREF_KEYS.map((k) => [k, z.boolean().optional()]))).optional(),
          lang: z.enum(['en', 'fil']).optional(),
        }),
        handler: (ctx) => {
          const r = mine(ctx);
          const prefs = { ...prefsOf(r), ...(ctx.body.prefs ?? {}) };
          db.prepare('UPDATE push_sub SET prefs = ?, lang = ? WHERE id = ?').run(
            JSON.stringify(prefs),
            ctx.body.lang ?? r.lang,
            r.id,
          );
          return subDTO(db.prepare('SELECT * FROM push_sub WHERE id = ?').get(r.id) as SubRow);
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/subscriptions/:id',
        auth: 'session',
        handler: (ctx) => {
          db.prepare('DELETE FROM push_sub WHERE id = ?').run(mine(ctx).id);
          return { ok: true };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/subscriptions/:id/test',
        auth: 'session',
        handler: async (ctx) => {
          const r = mine(ctx);
          const ok = await deliver(r, {
            title: TEXT[r.lang].test,
            body: TEXT[r.lang].testBody,
            tag: 'pasabot-test',
            category: 'test',
          });
          const after = db.prepare('SELECT last_error FROM push_sub WHERE id = ?').get(r.id) as
            | { last_error: string | null }
            | undefined;
          return { ok, error: ok ? null : (after?.last_error ?? 'gone') };
        },
      });
    },
  });
  return mod;
}

export default createPushModule();
