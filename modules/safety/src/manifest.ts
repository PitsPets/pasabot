/**
 * Skill permission manifest (W31 b): what a skill needs. Enforced at run time by the `/mcp` gateway guard for runs
 * that act for a skill (queue payload `skill`): an undeclared tool, host, messaging call or file path is refused, not
 * logged and allowed. Host and path matching is plain string work (no regex from the skill). A tool input is walked
 * whole (nested objects and arrays); one too deep to read is refused (fail closed).
 */
import { z } from 'zod';

export const manifestSchema = z.object({
  files: z
    .object({
      /** true: only the agent's own workspace; `paths` adds named absolute paths */
      workspaceOnly: z.boolean().default(true),
      paths: z.array(z.string().min(1).max(500)).max(50).default([]),
    })
    .default({ workspaceOnly: true, paths: [] }),
  /** hosts the skill may reach: `example.com` or `*.example.com` */
  network: z
    .object({ hosts: z.array(z.string().min(1).max(253)).max(50).default([]) })
    .default({ hosts: [] }),
  /** may it send messages to other people (still always asks the owner, 7.1) */
  messaging: z.boolean().default(false),
  /** tool names it may call through the gateway; an outside MCP tool is declared by its `server/tool` ref */
  tools: z.array(z.string().min(1).max(200)).max(200).default([]),
});
export type SkillManifest = z.infer<typeof manifestSchema>;

const URL_KEYS = new Set(['url', 'href', 'endpoint', 'uri', 'link', 'origin', 'baseurl']);
const URL_LIST_KEYS = new Set(['urls', 'hrefs', 'endpoints', 'uris', 'links']);
const HOST_KEYS = new Set(['host', 'hostname', 'domain', 'hosts', 'hostnames', 'domains']);
const PATH_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'filename',
  'dir',
  'directory',
  'cwd',
  'dest',
  'destination',
  'paths',
  'files',
  'filepaths',
  'dirs',
  'directories',
]);
const SCHEMES = ['http://', 'https://', 'ws://', 'wss://', 'ftp://'];
/** how deep a tool input is walked; anything deeper is refused as unreadable (fail closed) */
export const MAX_DEPTH = 8;

/**
 * Walks a tool input (objects and arrays, up to MAX_DEPTH) and calls `on` for every string with the key it sits
 * under (an array item gets its array's key). Returns false when the input is nested deeper than it can read.
 */
function walk(input: unknown, on: (key: string, value: string) => void): boolean {
  let complete = true;
  const visit = (v: unknown, key: string, depth: number): void => {
    if (typeof v === 'string') {
      on(key, v);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (depth > MAX_DEPTH) {
      complete = false;
      return;
    }
    if (Array.isArray(v)) for (const x of v) visit(x, key, depth + 1);
    else
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k.toLowerCase(), depth + 1);
  };
  visit(input, '', 0);
  return complete;
}

const hostOf = (x: string): string => {
  try {
    return new URL(x).hostname.toLowerCase();
  } catch {
    return x.toLowerCase();
  }
};

/**
 * Hosts in a tool call's input, at any depth and inside arrays: values under url-like keys (`url`, `href`,
 * `endpoint`, `urls` ...), host-like keys (`host`, `domain` ...) and any string that starts with a URL scheme.
 */
export function hostsOf(input: unknown): string[] {
  const out: string[] = [];
  walk(input, (k, x) => {
    const v = x.trim();
    const lower = v.toLowerCase();
    if (URL_KEYS.has(k) || URL_LIST_KEYS.has(k) || SCHEMES.some((p) => lower.startsWith(p)))
      out.push(hostOf(v));
    else if (HOST_KEYS.has(k)) out.push(lower);
  });
  return out;
}

/** Paths in a tool call's input, at any depth and inside arrays: `path`, `file`, `dir`, `paths` ..., `file://` and `~/`. */
export function pathsOf(input: unknown): string[] {
  const out: string[] = [];
  walk(input, (k, x) => {
    if (PATH_KEYS.has(k)) out.push(x);
    else if (x.toLowerCase().startsWith('file://')) {
      try {
        out.push(decodeURIComponent(new URL(x).pathname));
      } catch {
        out.push('/');
      }
    } else if (x.startsWith('~/')) out.push(x);
  });
  return out;
}

/** true when the input is nested too deep to read whole (the guard then refuses: fail closed) */
export const tooDeep = (input: unknown): boolean => !walk(input, () => {});

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => {
    const p = a.toLowerCase().trim();
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const insideRoot = (path: string, root: string) => {
  const p = norm(path);
  return p === norm(root) || p.startsWith(`${norm(root)}/`);
};

function pathAllowed(path: string, m: SkillManifest, workspace: string | null): boolean {
  const p = norm(path);
  if (p.split('/').includes('..')) return false;
  // a relative path is inside the run's workspace
  if (!p.startsWith('/') && !/^[a-z]:\//i.test(p) && !p.startsWith('~')) return true;
  if (workspace && insideRoot(p, workspace)) return true;
  return m.files.paths.some((root) => insideRoot(p, root));
}

export interface ToolUse {
  name: string;
  input: unknown;
  /** the call's action class as the gateway resolved it (a dynamic class included), when it has one */
  actionClass?: string;
  /** the agent's workspace directory, when known */
  workspace?: string | null;
}

/** The gateway tool that calls a tool of an outside MCP server; its inner `server/tool` ref must be declared too. */
export const OUTSIDE_TOOL = 'tools_invoke';
/**
 * Tools that can reach a host the call does not name (a click follows a link or posts a form, typed keys submit).
 * Their target cannot be checked before they run, so a skill run may not use them (fail closed) until the browser
 * and computer modules report the real navigation target to the guard.
 */
export const IMPLICIT_NETWORK_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'computer_click',
  'computer_type',
  'computer_key',
]);
/**
 * Tools that start or schedule other work (another agent, a workflow, a routine). A skill's limits do not follow
 * that work yet, so a skill run may not use them even when declared.
 */
export const STARTS_WORK_TOOLS = new Set([
  'collab_delegate',
  'collab_handoff',
  'workflows_create',
  'workflows_update',
  'workflows_run',
  'routines_create',
]);

/** null = allowed; otherwise the refusal the agent and the receipt see. */
export function checkUse(skillId: string, m: SkillManifest, use: ToolUse): string | null {
  if (!m.tools.includes(use.name))
    return `the skill "${skillId}" did not declare the tool "${use.name}" in its permission manifest`;
  if (STARTS_WORK_TOOLS.has(use.name))
    return `a run for the skill "${skillId}" may not start other work with "${use.name}" (the skill's limits would not follow it)`;
  if (IMPLICIT_NETWORK_TOOLS.has(use.name))
    return `a run for the skill "${skillId}" may not use "${use.name}": where it leads cannot be checked against the skill's permission manifest`;
  if (use.name === OUTSIDE_TOOL) {
    const ref = (use.input as { tool?: unknown } | null)?.tool;
    if (typeof ref !== 'string' || !m.tools.includes(ref))
      return `the skill "${skillId}" did not declare the outside tool "${String(ref ?? '').slice(0, 120)}" in its permission manifest`;
  }
  if (use.actionClass === 'outbound-message' && !m.messaging)
    return `the skill "${skillId}" did not declare messaging in its permission manifest`;
  if (tooDeep(use.input))
    return `the skill "${skillId}" sent a tool input nested too deeply to check against its permission manifest`;
  for (const h of hostsOf(use.input))
    if (!hostAllowed(h, m.network.hosts))
      return `the skill "${skillId}" did not declare the host "${h.slice(0, 253)}" in its permission manifest`;
  for (const p of pathsOf(use.input))
    if (!pathAllowed(p, m, use.workspace ?? null))
      return `the skill "${skillId}" may not use the path "${p.slice(0, 120)}" (not declared in its permission manifest)`;
  return null;
}

/** A host pattern allows nothing `prev` does not: an exact host `prev` allows, or a wildcard inside a wildcard. */
function hostPatternWithin(next: string, prev: string[]): boolean {
  const n = next.toLowerCase().trim().replace(/\.$/, '');
  if (!n.startsWith('*.')) return hostAllowed(n, prev);
  return prev.some((a) => {
    const p = a.toLowerCase().trim();
    return p === n || (p.startsWith('*.') && n.endsWith(p.slice(1)));
  });
}

/**
 * Does `next` only narrow `prev`? A subset of tools, hosts and named paths; messaging only from true to false;
 * workspace-only never switched off. An agent may change a manifest only when this holds (7.4: only the owner widens).
 */
export function narrows(next: SkillManifest, prev: SkillManifest): boolean {
  if (!next.tools.every((t) => prev.tools.includes(t))) return false;
  if (next.messaging && !prev.messaging) return false;
  if (prev.files.workspaceOnly && !next.files.workspaceOnly) return false;
  if (!next.network.hosts.every((h) => hostPatternWithin(h, prev.network.hosts))) return false;
  return next.files.paths.every(
    (p) => !norm(p).split('/').includes('..') && prev.files.paths.some((root) => insideRoot(p, root)),
  );
}
