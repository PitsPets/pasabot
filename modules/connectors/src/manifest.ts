/**
 * The connector manifest schema (`catalog/connectors/<slug>/<version>.json`, ARCHITECTURE 5.4) and the catalogue
 * loader. A manifest is data: it is validated here, never executed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorManifest } from '@pasabot/core';
import { type ActionClass, actionClassSchema, httpUrlSchema } from '@pasabot/protocol';
import { z } from 'zod';

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{(secret|field):([^}]*)\}\}/g;
export const OAUTH_TOKEN = 'oauth_token';

/** W36: what people do with an app, the catalogue's sections (plain words on the page) */
export const GROUPS = [
  'files-notes',
  'calendar-email',
  'work-tasks',
  'shop-money',
  'social-chat',
  'other',
] as const;
export type Group = (typeof GROUPS)[number];

/** the owner brings the OAuth client (client id from the service's developer page) */
const ownerOauth = z
  .object({
    authorizeUrl: httpUrlSchema,
    tokenUrl: httpUrlSchema,
    scopes: z.array(z.string().min(1).max(300)).max(30),
    clientIdFrom: z.literal('owner'),
  })
  .strict();
/**
 * W36: the MCP server's own sign-in (MCP authorization): its sign-in pages are found from the server's published
 * metadata (RFC 9728 protected resource, RFC 8414 authorization server) when the owner taps Sign in, and PasaBot
 * registers itself as a client there (RFC 7591), so the owner types nothing. Every request goes through safe-net.
 */
const registerOauth = z
  .object({
    discover: z.literal('mcp'),
    clientIdFrom: z.literal('register'),
    /** asked for at sign-in; absent: the scopes the server publishes */
    scopes: z.array(z.string().min(1).max(300)).max(30).optional(),
  })
  .strict();

const fieldSchema = z
  .object({ key: z.string().regex(KEY), label: z.string().min(1).max(80), secret: z.boolean() })
  .strict();

const PIP_PINNED = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?==\d[A-Za-z0-9.+!_-]*$/;
const NPM_PINNED = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const IMAGE_PINNED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

/**
 * A launcher that downloads code when it starts must name one exact release, or every call could run whatever
 * was published last (threat model, supply chain): `uvx <pkg>==<version>`, `npx <pkg>@<x.y.z>`,
 * `docker run … <image>@sha256:<digest>`. Returns why a command is refused, or null.
 */
export function unpinnedLauncher(command: string, args: string[]): string | null {
  const bin = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  const first = args.find((a) => !a.startsWith('-')) ?? '';
  if (bin === 'uvx') {
    if (args.some((a) => /^--(from|with)/.test(a)))
      return 'uvx --from/--with is not allowed; pin <package>==<version>';
    return PIP_PINNED.test(first) ? null : 'uvx must run an exact release: <package>==<version>';
  }
  if (bin === 'npx' || bin === 'bunx') {
    if (args.some((a) => a === '-p' || a.startsWith('--package'))) return `${bin} --package is not allowed`;
    return NPM_PINNED.test(first) ? null : `${bin} must run an exact release: <package>@<x.y.z>`;
  }
  if (bin === 'docker' || bin === 'podman')
    return args.some((a) => IMAGE_PINNED.test(a))
      ? null
      : 'container images must be pinned: <image>@sha256:<digest>';
  if (bin === 'pipx' || ((bin === 'pnpm' || bin === 'yarn') && first === 'dlx'))
    return `${bin} is not allowed; use uvx or npx with an exact release`;
  return null;
}

export const manifestSchema = z
  .object({
    schema: z.literal('pasabot.connector/v1'),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    category: z.string().min(1).max(40),
    summary: z.string().min(1).max(300),
    icon: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    homepage: httpUrlSchema.optional(),
    /** W36: the official page this entry was checked against (endpoint, package, sign-in) */
    source: httpUrlSchema.optional(),
    /** W36: the catalogue section (what people do with it); absent: "Other" */
    group: z.enum(GROUPS).optional(),
    /** W36: shown in the Popular row on top */
    popular: z.boolean().optional(),
    kind: z.enum(['mcp-stdio', 'mcp-http', 'oauth-api']),
    mcp: z
      .object({
        command: z.string().min(1).max(200).optional(),
        args: z.array(z.string().max(500)).max(32).optional(),
        url: z.string().max(500).optional(),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(500)).optional(),
        headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(500)).optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        type: z.enum(['none', 'api_key', 'oauth2_pkce']),
        fields: z.array(fieldSchema).max(12).optional(),
        oauth: z.union([ownerOauth, registerOauth]).optional(),
        /** W36: the service's own page where the owner gets the code (opened in a new tab) */
        keyPage: httpUrlSchema.optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({ allowHosts: z.array(z.string().min(1).max(253)).max(16) })
      .strict()
      .optional(),
    defaultTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    toolClasses: z.record(z.string().min(1).max(128), actionClassSchema).optional(),
    /** W38: tools that delete or destroy a remote resource; each is class `delete` (always asks) */
    destructive: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (m.kind === 'mcp-stdio' && !m.mcp?.command) issue('mcp-stdio needs mcp.command');
    if (m.kind === 'mcp-http' && !m.mcp?.url) issue('mcp-http needs mcp.url');
    if (m.kind === 'mcp-stdio' && (m.mcp?.url || m.mcp?.headers)) issue('mcp-stdio takes no url or headers');
    if (m.kind === 'mcp-http' && (m.mcp?.command || m.mcp?.args || m.mcp?.env))
      issue('mcp-http takes no command, args or env');
    if (m.kind === 'oauth-api' && m.auth?.type !== 'oauth2_pkce')
      issue('oauth-api needs auth.type oauth2_pkce');
    if (m.kind === 'oauth-api' && m.mcp) issue('oauth-api takes no mcp section');
    if (m.auth?.type === 'oauth2_pkce' && !m.auth.oauth) issue('oauth2_pkce needs auth.oauth');
    if (m.auth?.type !== 'oauth2_pkce' && m.auth?.oauth) issue('auth.oauth needs type oauth2_pkce');
    // the server's own sign-in is found from the MCP server's address, so only an HTTP server has one
    if (m.auth?.oauth && 'discover' in m.auth.oauth && m.kind !== 'mcp-http')
      issue('a discovered sign-in needs kind mcp-http');
    if (m.auth?.keyPage && m.auth.type !== 'api_key') issue('auth.keyPage needs type api_key');
    const fields = m.auth?.fields ?? [];
    if (new Set(fields.map((f) => f.key)).size !== fields.length) issue('duplicate field keys');
    const secrets = new Set(fields.filter((f) => f.secret).map((f) => f.key));
    if (m.auth?.type === 'oauth2_pkce') secrets.add(OAUTH_TOKEN);
    const plain = new Set(fields.filter((f) => !f.secret).map((f) => f.key));
    const texts = [
      ...(m.mcp?.args ?? []),
      m.mcp?.url ?? '',
      ...Object.values(m.mcp?.env ?? {}),
      ...Object.values(m.mcp?.headers ?? {}),
    ];
    for (const t of texts)
      for (const [, kind, key] of t.matchAll(PLACEHOLDER)) {
        if (kind === 'secret' && !secrets.has(key!)) issue(`{{secret:${key}}} names no secret field`);
        if (kind === 'field' && !plain.has(key!)) issue(`{{field:${key}}} names no plain field`);
      }
    // a secret may only travel in env or a header, never in argv (visible in `ps`) or a URL (logs)
    for (const t of [...(m.mcp?.args ?? []), m.mcp?.url ?? ''])
      if (t.includes('{{secret:')) issue('secrets go in env or headers, never in args or the URL');
    if (m.kind === 'mcp-stdio' && m.mcp?.command) {
      const why = unpinnedLauncher(m.mcp.command, m.mcp.args ?? []);
      if (why) issue(why);
    }
    // a stdio server does its own I/O outside safe-net, so an allowlist on it would only mislead
    if (m.kind === 'mcp-stdio' && m.network) issue('network.allowHosts has no effect on an mcp-stdio server');
    if (m.kind === 'mcp-http' && m.mcp?.url) {
      const u = m.mcp.url.split('{{field:').join('x').split('}}').join('');
      if (!httpUrlSchema.safeParse(u).success) issue('mcp.url must be an absolute http(s) URL');
    }
  });

export type Manifest = z.infer<typeof manifestSchema> & Omit<ConnectorManifest, 'auth'>;
/** does this manifest sign in at the MCP server's own pages (no client id from the owner)? */
export const registersClient = (m: Pick<Manifest, 'auth'>) =>
  !!m.auth?.oauth && 'discover' in m.auth.oauth && m.auth.oauth.clientIdFrom === 'register';

export interface CatalogEntry {
  manifest: Manifest;
  file: string;
}
export interface CatalogProblem {
  file: string;
  error: string;
}

const semver = (v: string) => v.split('.').map(Number) as [number, number, number];
export const newer = (a: string, b: string) => {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

/** Every `<dir>/<slug>/<version>.json`; the folder and file name must match the manifest's slug and version. */
export function loadCatalog(dirs: string[]): { entries: CatalogEntry[]; problems: CatalogProblem[] } {
  const entries: CatalogEntry[] = [];
  const problems: CatalogProblem[] = [];
  for (const dir of dirs) {
    let slugs: string[];
    try {
      slugs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const slug of slugs.sort()) {
      const sub = join(dir, slug);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const name of readdirSync(sub).sort()) {
        if (!name.endsWith('.json')) continue;
        const file = join(sub, name);
        try {
          if (statSync(file).size > 64 * 1024) throw new Error('manifest over 64 KiB');
          const m = manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
          if (m.slug !== slug) throw new Error(`slug "${m.slug}" does not match folder "${slug}"`);
          if (`${m.version}.json` !== name)
            throw new Error(`version ${m.version} does not match file ${name}`);
          entries.push({ manifest: m as Manifest, file });
        } catch (e) {
          problems.push({ file, error: (e as Error).message.slice(0, 2000) });
        }
      }
    }
  }
  return { entries, problems };
}

/** The newest version of each slug (a later directory wins a tie). */
export function latest(entries: CatalogEntry[]): Map<string, Manifest> {
  const out = new Map<string, Manifest>();
  for (const { manifest } of entries) {
    const cur = out.get(manifest.slug);
    if (!cur || !newer(cur.version, manifest.version)) out.set(manifest.slug, manifest);
  }
  return out;
}

/** `{{field:key}}` filled with the owner's plain values; `{{secret:…}}` stays for the mcp module to resolve. */
export const fillFields = (t: string, values: Record<string, string>) =>
  t.replace(/\{\{field:([a-z0-9_]+)\}\}/g, (_m, k: string) => values[k] ?? '');

/**
 * The tool classes a manifest declares (7.1), with its `destructive` tools as class `delete` (W38). A tool also
 * declared money or an outbound message keeps that class (it always asks either way); a destructive tag otherwise
 * wins over `publish`.
 */
export function toolClassesOf(m: Pick<Manifest, 'toolClasses' | 'destructive'>): Record<string, ActionClass> {
  const out: Record<string, ActionClass> = { ...(m.toolClasses ?? {}) };
  for (const t of m.destructive ?? [])
    if (out[t] !== 'money' && out[t] !== 'outbound-message') out[t] = 'delete';
  return out;
}
