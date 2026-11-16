/** Block schemas shared by the server (BlockKindRegistry) and the tools; the web renders the same shapes. */
import { httpUrlSchema } from '@pasabot/protocol';
import { z } from 'zod';

export const FILE_MAX = 100 * 1024 * 1024; // per file (8, "DoS")
export const MESSAGE_MAX = 250 * 1024 * 1024; // per message
export const CHUNK = 4 * 1024 * 1024; // resumable upload chunk

const answerSchema = z.object({
  optionIds: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  by: z.string().optional(),
  at: z.number().optional(),
});
const promptState = z.enum(['open', 'answered', 'expired', 'cancelled']);

export const askBlock = z.object({
  promptId: z.string(),
  question: z.string().max(500),
  options: z
    .array(z.object({ id: z.string(), label: z.string().max(80) }))
    .min(2)
    .max(8),
  multi: z.boolean().default(false),
  state: promptState,
  answer: answerSchema.optional(),
});
export type AskBlock = z.infer<typeof askBlock>;

export const formField = z.object({
  name: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/),
  label: z.string().min(1).max(80),
  type: z.enum(['text', 'textarea', 'number', 'select', 'checkbox', 'date']),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(80)).max(20).optional(),
  placeholder: z.string().max(80).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FormField = z.infer<typeof formField>;
export const formBlock = z.object({
  promptId: z.string(),
  title: z.string().max(120),
  fields: z.array(formField).min(1).max(12),
  submitLabel: z.string().max(40).optional(),
  state: promptState,
  answer: answerSchema.optional(),
});
export type FormBlock = z.infer<typeof formBlock>;

export const htmlBlock = z.object({
  title: z.string().max(120),
  /** absolute http(s) URL on the separate sites origin (never javascript: or data:) */
  url: httpUrlSchema,
  height: z.number().int().min(120).max(1200).default(360),
});
export type HtmlBlock = z.infer<typeof htmlBlock>;

export const fileRef = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(255),
  mime: z.string().max(127),
  size: z.number().int().nonnegative().max(FILE_MAX),
});
export type FileRef = z.infer<typeof fileRef>;
export const filesBlock = z.object({ files: z.array(fileRef).min(1).max(20) });
export type FilesBlock = z.infer<typeof filesBlock>;

/**
 * Checks a form submission against the field spec. Returns the cleaned values or the first error key.
 * Unknown names are dropped; numbers are parsed; selects must be one of the options.
 */
export function checkFormValues(
  fields: FormField[],
  raw: Record<string, unknown>,
): { ok: true; values: Record<string, string | number | boolean> } | { ok: false; field: string } {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = raw[f.name];
    const empty = v === undefined || v === null || v === '';
    if (f.type === 'checkbox') {
      out[f.name] = v === true || v === 'true' || v === 'on';
      if (f.required && !out[f.name]) return { ok: false, field: f.name };
      continue;
    }
    if (empty) {
      if (f.required) return { ok: false, field: f.name };
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, field: f.name };
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max))
        return { ok: false, field: f.name };
      out[f.name] = n;
      continue;
    }
    const s = String(v).slice(0, f.type === 'textarea' ? 4000 : 400);
    if (f.type === 'select' && !(f.options ?? []).includes(s)) return { ok: false, field: f.name };
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, field: f.name };
    out[f.name] = s;
  }
  return { ok: true, values: out };
}
