/**
 * W18 static sites: an agent publishes a small static site (HTML, CSS, JS, images) on the separate sites origin
 * (ARCHITECTURE 8, "Exposure"), never on the app origin. Every response there carries `CSP: sandbox allow-scripts`
 * (the core sites listener sets it), so a site's scripts run on an opaque origin with no cookies and cannot use the
 * credentialed `/api` or `/ws`. Sites have quotas and expire; the publishing agent or the owner renews them. The
 * owner may give a tunnel address (e.g. a `sites.` hostname behind their own tunnel); a site marked public then shows
 * that address as well. The owner manages every site from the Sites screen (`#/sites`) through owner-session REST.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ApprovalTier,
  type AuthedCtx,
  defineModule,
  HttpError,
  type ModuleHost,
  type PasaBotModule,
  ulid,
} from '@pasabot/core';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** files in one site: the 21st is refused */
  files: 20,
  /** one file */
  fileBytes: 512 * 1024,
  /** one site, all files (one tool call carries a whole site, and the server takes at most 1 MB per request) */
  siteBytes: 1024 * 1024,
  /** live sites per agent */
  sitesPerAgent: 10,
  /** all of one agent's live sites */
  agentBytes: 10 * 1024 * 1024,
  /** publishes (new or replacing) per agent in any 60 minutes, so publish/unpublish churn stays bounded */
  publishesPerHour: 30,
  /** a path inside a site */
  pathChars: 200,
  pathDepth: 6,
  defaultDays: 7,
  maxDays: 30,
};

/** What a site may contain. Text types pass the redaction filter before they are published. */
const TYPES: Record<string, { mime: string; text: boolean }> = {
  html: { mime: 'text/html; charset=utf-8', text: true },
  htm: { mime: 'text/html; charset=utf-8', text: true },
  css: { mime: 'text/css; charset=utf-8', text: true },
  js: { mime: 'text/javascript; charset=utf-8', text: true },
  mjs: { mime: 'text/javascript; charset=utf-8', text: true },
  json: { mime: 'application/json', text: true },
  txt: { mime: 'text/plain; charset=utf-8', text: true },
  md: { mime: 'text/plain; charset=utf-8', text: true },
  csv: { mime: 'text/csv; charset=utf-8', text: true },
  svg: { mime: 'image/svg+xml', text: true },
  xml: { mime: 'application/xml', text: true },
  png: { mime: 'image/png', text: false },
  jpg: { mime: 'image/jpeg', text: false },
  jpeg: { mime: 'image/jpeg', text: false },
  gif: { mime: 'image/gif', text: false },
  webp: { mime: 'image/webp', text: false },
  ico: { mime: 'image/x-icon', text: false },
  woff2: { mime: 'font/woff2', text: false },
};

export class SiteError extends Error {}

/** One path segment: letters, digits, `.`, `_`, `-`; never `.`/`..`, never hidden (no leading dot). Linear scan. */
function okSegment(s: string) {
  if (s.length === 0 || s.length > 80 || s[0] === '.' || s[0] === '-') return false;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      ch === '.' ||
      ch === '_' ||
      ch === '-';
    if (!ok) return false;
  }
  return true;
}

/** A site file path such as `index.html` or `img/logo.png`: relative, plain segments, a known extension. */
export function checkPath(path: string): { mime: string; text: boolean } {
  if (path.length === 0 || path.length > LIMITS.pathChars)
    throw new SiteError(`file path too long: "${path}"`);
  const segs = path.split('/');
  if (segs.length > LIMITS.pathDepth) throw new SiteError(`file path too deep: "${path}"`);
  if (!segs.every(okSegment))
    throw new SiteError(
      `bad file path "${path}": use letters, digits, ".", "_" and "-" in each part, separated by "/"`,
    );
  const name = segs[segs.length - 1]!;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const t = TYPES[ext];
  if (!t) throw new SiteError(`file type not allowed: "${path}" (allowed: ${Object.keys(TYPES).join(', ')})`);
  return t;
}

/** The readable part of a slug: lower-case letters, digits and single dashes, at most 40 characters. */
export function slugBase(name: string) {
  let out = '';
  for (const ch of name.toLowerCase()) {
    const c = ch.charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) out += ch;
    else if (out && !out.endsWith('-')) out += '-';
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/, '');
  return out || 'site';
}
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomPart = () => Array.from(randomBytes(10), (b) => B32[b % B32.length]).join('');

const fileIn = z
  .object({
    path: z.string().min(1).max(LIMITS.pathChars),
    content: z.string().max(LIMITS.fileBytes).optional(),
    base64: z
      .string()
      .max(Math.ceil((LIMITS.fileBytes * 4) / 3) + 4)
      .optional(),
  })
  .refine((f) => (f.content === undefined) !== (f.base64 === undefined), {
    message: 'give each file either `content` (text) or `base64` (bytes)',
  });
const publishIn = z.object({
  /** update one of your own sites (its id or slug); omit to make a new site */
  site: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(120),
  /** no upper bound here, so a too-long list is refused with a plain answer instead of a schema error */
  files: z.array(fileIn).min(1),
  public: z.boolean().optional(),
  days: z.number().int().min(1).max(LIMITS.maxDays).optional(),
});
type PublishIn = z.infer<typeof publishIn>;
const siteRef = z.object({ site: z.string().min(1).max(80) });
const renewIn = z.object({
  site: z.string().min(1).max(80),
  days: z.number().int().min(1).max(LIMITS.maxDays).optional(),
});

interface SiteRow {
  id: string;
  slug: string;
  agent_id: string;
  title: string;
  public: number;
  bytes: number;
  files: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}
interface FileRow {
  site_id: string;
  path: string;
  sha256: string;
  mime: string;
  size: number;
}
export interface SiteView {
  id: string;
  slug: string;
  title: string;
  agent: { id: string; name: string | null };
  public: boolean;
  bytes: number;
  files: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  url: string;
  publicUrl: string | null;
}

export interface SitesOptions {
  /** clock (tests) */
  now?: () => number;
  /** how often the expiry job runs; 0 = never on a timer (tests call `sweep`) */
  sweepMs?: number;
  /** test hook: the running module's expiry job */
  onReady?: (api: { sweep(): Promise<number> }) => void;
}

/** Normalised tunnel address: an http(s) origin plus an optional path, no query, no trailing slash. */
export function normalizeBase(raw: string): string | null {
  const v = raw.trim();
  if (v === '') return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password)
    return null;
  if (u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** A stored file's name is its sha256 in lower-case hex; anything else in the store dir is not ours to read. */
const isSha = (s: string) => {
  if (s.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
};

export function createSitesModule(opts: SitesOptions = {}): PasaBotModule {
  const now = opts.now ?? Date.now;
  return defineModule({
    id: 'sites',
    migrations: join(here, '..', 'migrations'),
    async register(app: ModuleHost) {
      const db = app.raw;
      const mount = app.sitesOrigin;
      const getBase = () => app.config.get<string>('publicBaseUrl', '');
      const indexOf = (slug: string) => `${slug}/index.html`;
      const view = (r: SiteRow, names: Map<string, string>): SiteView => {
        const base = getBase();
        return {
          id: r.id,
          slug: r.slug,
          title: r.title,
          agent: { id: r.agent_id, name: names.get(r.agent_id) ?? null },
          public: r.public === 1,
          bytes: r.bytes,
          files: r.files,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          expiresAt: r.expires_at,
          url: mount.url(indexOf(r.slug)),
          publicUrl: r.public === 1 && base ? `${base}/sites/${indexOf(r.slug)}` : null,
        };
      };
      const agentNames = async () => new Map((await app.agents.list()).map((a) => [a.id, a.name]));
      const find = (ref: string) =>
        db.prepare('SELECT * FROM sites_site WHERE id = ? OR slug = ?').get(ref, ref) as SiteRow | undefined;
      const filesOf = (id: string) =>
        db.prepare('SELECT * FROM sites_file WHERE site_id = ? ORDER BY path').all(id) as FileRow[];
      const live = () =>
        db
          .prepare('SELECT * FROM sites_site WHERE expires_at > ? ORDER BY created_at DESC')
          .all(now()) as SiteRow[];

      /**
       * Site bytes live in the module's own store (`<dataDir>/store/<sha256>`), not in the shared BlobStore, which has
       * no delete: a stored file is deleted as soon as no site row points at it, so removing, replacing or expiring a
       * site frees its disk space.
       */
      const storeDir = join(app.dataDir, 'store');
      await mkdir(storeDir, { recursive: true, mode: 0o700 });
      const blobPath = (sha: string) => {
        if (!isSha(sha)) throw new Error('bad stored file id');
        return join(storeDir, sha);
      };
      const storeBytes = async (data: Buffer) => {
        const sha = createHash('sha256').update(data).digest('hex');
        const p = blobPath(sha);
        const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, p);
        return sha;
      };
      /** Deletes each stored file that no site row points at any more. */
      const collect = async (shas: Iterable<string>) => {
        const used = db.prepare('SELECT 1 FROM sites_file WHERE sha256 = ? LIMIT 1');
        for (const sha of new Set(shas)) if (!used.get(sha)) await rm(blobPath(sha), { force: true });
      };
      /**
       * Every change to sites, their files or the store runs one at a time: the quota check and the insert of one
       * publish cannot interleave with another's, and the store never deletes a file a running publish just wrote.
       */
      let tail: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const p = tail.then(() => fn());
        tail = p.catch(() => undefined);
        return p;
      };

      /** Copies a site's files from the module's store onto the sites origin (publish, and every boot). */
      const materialize = async (slug: string, files: FileRow[]) => {
        await mount.remove(slug);
        for (const f of files)
          await mount.put(`${slug}/${f.path}`, await readFile(blobPath(f.sha256)), f.mime);
      };
      /** Takes a site down and frees its stored files; callers hold `serial`. */
      const removeSite = async (r: SiteRow) => {
        await mount.remove(r.slug);
        const old = filesOf(r.id).map((f) => f.sha256);
        db.transaction(() => {
          db.prepare('DELETE FROM sites_file WHERE site_id = ?').run(r.id);
          db.prepare('DELETE FROM sites_site WHERE id = ?').run(r.id);
        })();
        await collect(old);
      };

      /** The expiry job: every site past its time is taken off the sites origin and forgotten. */
      const sweep = () =>
        serial(async () => {
          const due = db.prepare('SELECT * FROM sites_site WHERE expires_at <= ?').all(now()) as SiteRow[];
          for (const r of due) {
            await removeSite(r);
            app.log.info('site expired', { slug: r.slug, agentId: r.agent_id });
          }
          return due.length;
        });

      /** Publish times per agent in the last hour (in memory; a restart forgets them). */
      const recent = new Map<string, number[]>();
      const publishesLastHour = (agentId: string) => {
        const since = now() - HOUR;
        const list = (recent.get(agentId) ?? []).filter((t) => t > since);
        if (list.length) recent.set(agentId, list);
        else recent.delete(agentId);
        return list;
      };

      /** The agent's live-site count and bytes quotas, other than the site being replaced. */
      const checkAgentQuota = (agentId: string, replacing: SiteRow | undefined, total: number) => {
        const mine = db
          .prepare(
            'SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM sites_site WHERE agent_id = ? AND id != ?',
          )
          .get(agentId, replacing?.id ?? '') as { n: number; b: number };
        if (!replacing && mine.n >= LIMITS.sitesPerAgent)
          throw new SiteError(
            `you already have ${LIMITS.sitesPerAgent} live sites; remove or let one expire before publishing another`,
          );
        if (mine.b + total > LIMITS.agentBytes)
          throw new SiteError(
            `your sites would hold more than ${LIMITS.agentBytes / (1024 * 1024)} MB together`,
          );
      };

      /** Checks a publish against every quota and returns the decoded files; throws a plain SiteError. */
      const prepare = (input: PublishIn, agentId: string, replacing: SiteRow | undefined) => {
        if (publishesLastHour(agentId).length >= LIMITS.publishesPerHour)
          throw new SiteError(
            `you may publish at most ${LIMITS.publishesPerHour} times an hour; try again later`,
          );
        if (input.files.length > LIMITS.files)
          throw new SiteError(
            `a site holds at most ${LIMITS.files} files; this one has ${input.files.length}`,
          );
        const seen = new Set<string>();
        const out: { path: string; data: Buffer; mime: string }[] = [];
        let total = 0;
        for (const f of input.files) {
          const t = checkPath(f.path);
          const key = f.path.toLowerCase();
          if (seen.has(key)) throw new SiteError(`file listed twice: "${f.path}"`);
          seen.add(key);
          let data =
            f.content !== undefined ? Buffer.from(f.content, 'utf8') : Buffer.from(f.base64 ?? '', 'base64');
          if (t.text) data = Buffer.from(app.redact(data.toString('utf8')), 'utf8');
          if (data.length > LIMITS.fileBytes)
            throw new SiteError(`"${f.path}" is larger than ${LIMITS.fileBytes / 1024} KB`);
          total += data.length;
          out.push({ path: f.path, data, mime: t.mime });
        }
        if (!seen.has('index.html')) throw new SiteError('a site needs an index.html at its top level');
        if (total > LIMITS.siteBytes)
          throw new SiteError(`a site holds at most ${LIMITS.siteBytes / (1024 * 1024)} MB of files`);
        checkAgentQuota(agentId, replacing, total);
        return { files: out, bytes: total };
      };

      /** The publishing agent's own site, or a plain refusal. */
      const ownSite = (ref: string, agentId: string) => {
        const r = find(ref);
        if (!r || r.expires_at <= now()) throw new SiteError(`no live site "${ref}"`);
        if (r.agent_id !== agentId) throw new SiteError(`"${ref}" was published by another agent`);
        return r;
      };
      /** Tier 0 for a call that will be refused anyway, so the owner is never asked about it. */
      const refusedAnyway = (fn: () => unknown) => {
        try {
          fn();
          return false;
        } catch (e) {
          if (e instanceof SiteError) return true;
          throw e;
        }
      };

      app.tools.add({
        name: 'sites_publish',
        title: 'Publish a static site',
        description: `Publish a small static site (HTML, CSS, JavaScript, images) on this server's separate sites address and get its URL. Give every file with a relative \`path\` (an \`index.html\` at the top is required) and either \`content\` (text) or \`base64\` (bytes). Limits: ${LIMITS.files} files, ${LIMITS.fileBytes / 1024} KB per file, ${LIMITS.siteBytes / (1024 * 1024)} MB per site, ${LIMITS.sitesPerAgent} live sites per agent. A site expires after \`days\` (default ${LIMITS.defaultDays}, at most ${LIMITS.maxDays}); renew it with sites_renew. Pass \`site\` (its id or slug) to replace the files of one of your own sites. The page runs in a sandbox with no access to PasaBot; never put secrets or private data in it. \`public: true\` also returns the owner's tunnel address when the owner has set one.`,
        input: publishIn,
        tier: (input, ctx): ApprovalTier =>
          refusedAnyway(() => {
            const replacing = input.site ? ownSite(input.site, ctx.agent.id) : undefined;
            prepare(input, ctx.agent.id, replacing);
          })
            ? 0
            : 2,
        handler: (input, ctx) =>
          serial(async () => {
            // checked again inside the lock: a concurrent call may have changed the counts since the tier check
            const replacing = input.site ? ownSite(input.site, ctx.agent.id) : undefined;
            const { files, bytes } = prepare(input, ctx.agent.id, replacing);
            const stored: FileRow[] = [];
            const id = replacing?.id ?? ulid();
            const old = replacing ? filesOf(id).map((f) => f.sha256) : [];
            const t = now();
            const expires = t + (input.days ?? LIMITS.defaultDays) * DAY;
            const slug = replacing?.slug ?? `${slugBase(input.title)}-${randomPart()}`;
            const pub = input.public ?? replacing?.public === 1;
            try {
              for (const f of files) {
                const sha = await storeBytes(f.data);
                stored.push({ site_id: id, path: f.path, sha256: sha, mime: f.mime, size: f.data.length });
              }
              db.transaction(() => {
                checkAgentQuota(ctx.agent.id, replacing, bytes);
                if (replacing) {
                  db.prepare(
                    'UPDATE sites_site SET title = ?, public = ?, bytes = ?, files = ?, updated_at = ?, expires_at = ? WHERE id = ?',
                  ).run(
                    input.title,
                    pub ? 1 : 0,
                    bytes,
                    files.length,
                    t,
                    Math.max(expires, replacing.expires_at),
                    id,
                  );
                  db.prepare('DELETE FROM sites_file WHERE site_id = ?').run(id);
                } else {
                  db.prepare(
                    'INSERT INTO sites_site (id, slug, agent_id, title, public, bytes, files, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  ).run(id, slug, ctx.agent.id, input.title, pub ? 1 : 0, bytes, files.length, t, t, expires);
                }
                const ins = db.prepare(
                  'INSERT INTO sites_file (site_id, path, sha256, mime, size) VALUES (?, ?, ?, ?, ?)',
                );
                for (const f of stored) ins.run(f.site_id, f.path, f.sha256, f.mime, f.size);
              })();
            } finally {
              // the replaced files, and on a failure the files just written, unless a site still points at them
              await collect([...old, ...stored.map((f) => f.sha256)]);
            }
            recent.set(ctx.agent.id, [...publishesLastHour(ctx.agent.id), t]);
            await materialize(slug, stored);
            const v = view(find(id)!, new Map([[ctx.agent.id, ctx.agent.name]]));
            app.log.info('site published', { slug, agentId: ctx.agent.id, files: files.length, bytes });
            return {
              id: v.id,
              slug: v.slug,
              url: v.url,
              publicUrl: v.publicUrl,
              ...(pub && !v.publicUrl
                ? { note: 'the owner has not set a tunnel address, so the site is not public' }
                : {}),
              files: v.files,
              bytes: v.bytes,
              expiresAt: new Date(v.expiresAt).toISOString(),
            };
          }),
      });

      app.tools.add({
        name: 'sites_list',
        title: 'List your sites',
        description:
          'List the static sites you published that are still live: URL, size and when each expires.',
        input: z.object({}),
        tier: 0,
        handler: async (_input, ctx) => {
          const names = new Map([[ctx.agent.id, ctx.agent.name]]);
          return live()
            .filter((r) => r.agent_id === ctx.agent.id)
            .map((r) => {
              const v = view(r, names);
              return {
                id: v.id,
                slug: v.slug,
                title: v.title,
                url: v.url,
                publicUrl: v.publicUrl,
                files: v.files,
                bytes: v.bytes,
                expiresAt: new Date(v.expiresAt).toISOString(),
              };
            });
        },
      });

      app.tools.add({
        name: 'sites_renew',
        title: 'Renew a site',
        description: `Keep one of your sites live for \`days\` more days from now (default ${LIMITS.defaultDays}, at most ${LIMITS.maxDays}).`,
        input: renewIn,
        tier: 1,
        handler: async (input, ctx) => {
          const r = ownSite(input.site, ctx.agent.id);
          const until = Math.max(r.expires_at, now() + (input.days ?? LIMITS.defaultDays) * DAY);
          db.prepare('UPDATE sites_site SET expires_at = ? WHERE id = ?').run(until, r.id);
          return { id: r.id, slug: r.slug, expiresAt: new Date(until).toISOString() };
        },
      });

      app.tools.add({
        name: 'sites_unpublish',
        title: 'Remove a site',
        description: 'Take one of your own sites down now. Its address stops working at once.',
        input: siteRef,
        tier: 1,
        handler: (input, ctx) =>
          serial(async () => {
            const r = ownSite(input.site, ctx.agent.id);
            await removeSite(r);
            return { removed: r.slug };
          }),
      });

      // ---------- owner REST (the Sites screen) ----------
      const ownerOnly = (ctx: AuthedCtx<unknown>) => {
        if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
          throw new HttpError(403, 'only the owner manages sites', 'forbidden');
      };
      const liveOr404 = (id: string) => {
        const r = find(id);
        if (!r || r.expires_at <= now()) throw new HttpError(404, 'no such site', 'not_found');
        return r;
      };
      app.http.route({
        method: 'GET',
        url: '/sites',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const names = await agentNames();
          return {
            sites: live().map((r) => ({
              ...view(r, names),
              paths: filesOf(r.id).map((f) => ({ path: f.path, size: f.size })),
            })),
            publicBaseUrl: getBase(),
            limits: LIMITS,
          };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/sites/:id/renew',
        auth: 'session',
        body: z.object({ days: z.number().int().min(1).max(LIMITS.maxDays).optional() }),
        handler: async (ctx: AuthedCtx<{ days?: number }>) => {
          ownerOnly(ctx);
          const r = liveOr404(ctx.params.id!);
          const until = Math.max(r.expires_at, now() + (ctx.body.days ?? LIMITS.defaultDays) * DAY);
          db.prepare('UPDATE sites_site SET expires_at = ? WHERE id = ?').run(until, r.id);
          return { expiresAt: until };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/sites/:id/public',
        auth: 'session',
        body: z.object({ public: z.boolean() }),
        handler: async (ctx: AuthedCtx<{ public: boolean }>) => {
          ownerOnly(ctx);
          const r = liveOr404(ctx.params.id!);
          if (ctx.body.public && !getBase())
            throw new HttpError(400, 'set the tunnel address first', 'no_public_base');
          db.prepare('UPDATE sites_site SET public = ? WHERE id = ?').run(ctx.body.public ? 1 : 0, r.id);
          return view(find(r.id)!, await agentNames());
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/sites/:id',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          return serial(async () => {
            const r = liveOr404(ctx.params.id!);
            await removeSite(r);
            app.log.info('site removed by the owner', { slug: r.slug });
            return { removed: r.slug };
          });
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/settings',
        auth: 'session',
        body: z.object({ publicBaseUrl: z.string().max(500) }),
        handler: async (ctx: AuthedCtx<{ publicBaseUrl: string }>) => {
          ownerOnly(ctx);
          const base = normalizeBase(ctx.body.publicBaseUrl);
          if (base === null)
            throw new HttpError(
              400,
              'the tunnel address must be an http(s) address with no query',
              'bad_url',
            );
          app.config.set('publicBaseUrl', base);
          return { publicBaseUrl: base };
        },
      });

      // boot: drop what expired while the server was down, put every live site back with its content types
      await sweep();
      // files left behind by a crash between writing and recording a publish
      await serial(async () => {
        const used = db.prepare('SELECT 1 FROM sites_file WHERE sha256 = ? LIMIT 1');
        for (const name of await readdir(storeDir))
          if (!isSha(name) || !used.get(name))
            await rm(join(storeDir, name), { force: true, recursive: true });
      });
      for (const r of live()) {
        try {
          await materialize(r.slug, filesOf(r.id));
        } catch (e) {
          app.log.warn('site could not be restored', { slug: r.slug, error: (e as Error).message });
        }
      }
      const ms = opts.sweepMs ?? 60_000;
      if (ms > 0) {
        const t = setInterval(() => {
          if (!db.open) return clearInterval(t);
          sweep().catch((e) => app.log.warn('site expiry failed', { error: (e as Error).message }));
        }, ms);
        t.unref();
      }
      opts.onReady?.({ sweep });
    },
  });
}

export default createSitesModule();
