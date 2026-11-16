/**
 * Agent templates: the manifest, the built-ins in catalog/templates, a template folder on the server, the
 * `.pasabot-template.json` bundle (publish = export, round-trips equal), importers for other products' public agent
 * config formats, and "make me an agent that…" drafts. Everything here only builds a draft: the owner reviews it and
 * the web app creates the agent through the core agents API, at no more than the server's default trust.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const templateSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  instructions: z.string().max(20_000).default(''),
  tags: z.array(z.string().max(30)).max(20).default([]),
  /** optional brain hints; the owner picks the brain in the review form */
  providerHint: z.string().max(40).optional(),
  model: z.string().max(100).optional(),
  version: z.string().max(40).default('1'),
});
export type Template = z.infer<typeof templateSchema>;

/** What the owner reviews before an agent is made. Never carries trust: the agent starts at the server default. */
export interface AgentDraft {
  name: string;
  instructions: string;
  templateId?: string;
  providerHint?: string;
  model?: string;
}

export class TemplateError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'exists' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}

const MAX_FILE = 256_000;

export function parseTemplate(raw: unknown): Template {
  const r = templateSchema.safeParse(raw);
  if (!r.success)
    throw new TemplateError('invalid', `not a valid template: ${r.error.issues[0]?.message ?? ''}`);
  return r.data;
}

/** Reads `<dir>/template.json`. Symlinks and oversize files are refused. */
export function readTemplateFolder(dir: string): Template {
  const f = join(dir, 'template.json');
  if (!existsSync(f)) throw new TemplateError('not_found', 'no template.json in that folder');
  const st = lstatSync(f);
  if (!st.isFile() || st.size > MAX_FILE)
    throw new TemplateError('invalid', 'template.json must be a small file');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new TemplateError('invalid', 'template.json is not JSON');
  }
  return parseTemplate(raw);
}

/** Built-in templates: one folder per template under catalog/templates. */
export function builtinTemplates(catalogDir: string): Template[] {
  if (!existsSync(catalogDir)) return [];
  const out: Template[] = [];
  for (const name of readdirSync(catalogDir).sort()) {
    const d = join(catalogDir, name);
    if (name.startsWith('.') || !lstatSync(d).isDirectory()) continue;
    try {
      out.push(readTemplateFolder(d));
    } catch {
      // a broken built-in is skipped, never fatal
    }
  }
  return out;
}

// ---------- bundle (publish = export) ----------

export const BUNDLE_FORMAT = 'pasabot-template';
const bundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  v: z.literal(1),
  template: templateSchema,
});
export type TemplateBundle = z.infer<typeof bundleSchema>;

export function exportBundle(t: Template): TemplateBundle {
  return { format: BUNDLE_FORMAT, v: 1, template: parseTemplate(t) };
}

/** A template made from an existing agent (its name and instructions; never its secrets, trust or workspace). */
export function templateFromAgent(a: {
  name: string;
  instructions: string;
  providerId: string;
  model: string | null;
}) {
  return parseTemplate({
    id: slugify(a.name),
    name: a.name.slice(0, 60),
    description: '',
    instructions: a.instructions,
    providerHint: a.providerId,
    ...(a.model ? { model: a.model } : {}),
  });
}

export function slugify(s: string): string {
  let out = '';
  let dash = false;
  for (const ch of s.toLowerCase().normalize('NFKD')) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (ok) {
      out += ch;
      dash = false;
    } else if (!dash && out) {
      out += '-';
      dash = true;
    }
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/, '');
  return out || 'agent';
}

// ---------- importers ----------

/**
 * Imports a file into a template. Formats: our own `.pasabot-template.json`; a Markdown agent file with a front
 * matter block (`name:`, `description:`, `model:` lines, body = instructions), the public layout several coding
 * CLIs use for sub-agents; and an assistant-style JSON object (`name`, `instructions`, optional `description`,
 * `model`). Imported text is data: it becomes the draft the owner reviews, nothing runs.
 */
export function importFile(fileName: string, content: string): { template: Template; format: string } {
  if (content.length > MAX_FILE) throw new TemplateError('invalid', 'file too large');
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new TemplateError('invalid', 'the file is not JSON');
    }
    const b = bundleSchema.safeParse(raw);
    if (b.success) return { template: b.data.template, format: 'pasabot' };
    const a = z
      .object({
        name: z.string().min(1).max(60),
        instructions: z.string().max(20_000),
        description: z.string().max(300).optional(),
        model: z.string().max(100).optional(),
      })
      .safeParse(raw);
    if (a.success)
      return {
        template: parseTemplate({
          id: slugify(a.data.name),
          name: a.data.name,
          description: a.data.description ?? '',
          instructions: a.data.instructions,
        }),
        format: 'assistant-json',
      };
    throw new TemplateError('unsupported', 'this JSON file is not an agent PasaBot can read');
  }
  if (lower.endsWith('.md')) {
    const { meta, body } = frontMatter(content);
    const name = (meta.name ?? fileName.replace(/\.md$/i, '')).slice(0, 60);
    return {
      template: parseTemplate({
        id: slugify(name),
        name,
        description: (meta.description ?? '').slice(0, 300),
        instructions: body.trim(),
      }),
      format: 'markdown-agent',
    };
  }
  throw new TemplateError(
    'unsupported',
    'PasaBot reads .pasabot-template.json, agent .md and assistant .json files',
  );
}

/** A minimal front matter reader: `key: value` lines between two `---` lines; no YAML features beyond that. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: text };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const l of lines.slice(1, end)) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    let v = l.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    if (k && !(k in meta)) meta[k] = v;
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

// ---------- "make me an agent that…" ----------

const STOP = new Set([
  'a',
  'an',
  'the',
  'me',
  'my',
  'that',
  'to',
  'and',
  'or',
  'for',
  'of',
  'make',
  'agent',
  'which',
]);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/**
 * A valid draft from a plain request, built without a model call: the closest template (by tag overlap) supplies
 * the base instructions, the owner's own words are added as the agent's job, and a short name is made from them.
 * The owner reviews and edits it before anything is created.
 */
export function draftFromPrompt(prompt: string, templates: Template[]): AgentDraft {
  const text = prompt.trim().slice(0, 2000);
  if (!text) throw new TemplateError('invalid', 'say what the agent should do');
  const ws = words(text);
  let best: Template | undefined;
  let score = 0;
  for (const t of templates) {
    const tags = new Set(t.tags.map((x) => x.toLowerCase()));
    // plain plural/verb forms count too ("drafts emails" matches "draft", "email")
    const s = ws.filter((w) => tags.has(w) || (w.endsWith('s') && tags.has(w.slice(0, -1)))).length;
    if (s > score) {
      score = s;
      best = t;
    }
  }
  const job = text.replace(
    /^(please\s+)?(make|create|build)\s+(me\s+)?(an?\s+)?agent\s+(that|who|which|to)\s+/i,
    '',
  );
  const nameWords = words(job).slice(0, 3);
  const name = best
    ? best.name
    : nameWords.length
      ? nameWords.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
      : 'New agent';
  const instructions = [`Your job: ${job.charAt(0).toUpperCase()}${job.slice(1)}`, best?.instructions]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20_000);
  return {
    name: name.slice(0, 60),
    instructions,
    ...(best ? { templateId: best.id } : {}),
    ...(best?.providerHint ? { providerHint: best.providerHint } : {}),
  };
}
