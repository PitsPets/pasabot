/**
 * Server-side translation (W24). Text a person reads that never passes through the web (stored chat messages, push,
 * channel posts) is rendered here in the person's saved app language; text the web shows is sent as a `Msg` (key +
 * params) and translated there. A person's language is saved by the web (`PUT /api/v1/me/language`) in `settings`
 * under `user.language:<userId>`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Msg, ServerI18n } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import { createI18n, type i18n, type Resource } from '@pasabot/i18n';
import { loadLocaleDir } from '@pasabot/i18n/node';
import { findWorkspaceRoot } from '../host/discovery.js';

/** a language code as the web saves it: `en`, `fil`, `pt-BR`, `zh-Hans` */
export const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const languageKey = (userId: string) => `user.language:${userId}`;

let workspaceLocales: Resource | undefined;
/**
 * Locale files when the server runs without a discovery root (tests, the e2e server): the workspace this server
 * belongs to, read once. An install with a root reads its own (`loadLocaleDir(root)`).
 */
export function workspaceLocaleFiles(): Resource {
  if (workspaceLocales) return workspaceLocales;
  let found: Resource = {};
  try {
    const root = findWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)));
    if (root && existsSync(root)) found = loadLocaleDir(root);
  } catch {
    found = {};
  }
  workspaceLocales = found;
  return found;
}

export function createServerI18n(db: Sqlite, resources: Resource): ServerI18n {
  const instances = new Map<string, i18n>();
  const inst = (lng: string) => {
    let i = instances.get(lng);
    if (!i) {
      i = createI18n(resources, lng);
      instances.set(lng, i);
    }
    return i;
  };
  const saved = (userId: string): string | null => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(languageKey(userId)) as
      | { value: string }
      | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value) as unknown;
      return typeof v === 'string' && LANGUAGE_CODE.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  const language = (userId?: string | null): string => {
    if (userId) return saved(userId) ?? 'en';
    const owner = db.prepare("SELECT id FROM users WHERE kind = 'owner' ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined;
    return (owner && saved(owner.id)) || 'en';
  };
  const t = (key: string, params?: Record<string, string | number>, lng?: string) =>
    inst(lng ?? language()).t(key, { ...(params ?? {}), interpolation: { escapeValue: false } }) as string;
  const render = (m: Msg, lng?: string): string => {
    const l = lng ?? language();
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(m.params ?? {}))
      params[k] = typeof v === 'object' && v !== null ? render(v, l) : v;
    const i = inst(l);
    if (m.fallback !== undefined && !i.exists(m.key)) return m.fallback;
    return i.t(m.key, { ...params, interpolation: { escapeValue: false } }) as string;
  };
  return { language, t, render };
}
