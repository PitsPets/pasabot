/**
 * An agent as a client may see it (the details panel, the agent list, `agent.updated`).
 * - Every agent gets `summary`: what it does in one or two plain sentences, derived here from the first paragraph of
 *   its instructions (its job), deterministically and without a model call. A member or guest never gets one: it
 *   would quote owner-written instructions.
 * - The built-in team builder (the orchestrator module's agent) runs on PasaBot's own internal prompt: that prompt is
 *   never sent to any client (owner included) and `summary` carries a friendly description instead.
 */
import { ORCHESTRATOR_AGENT_SETTING, ORCHESTRATOR_INTERVIEW_SETTING, type ServerI18n } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { AgentDTO } from '@pasabot/protocol';

/** the English description of the built-in team builder when no translation is at hand */
export const BUILDER_SUMMARY_EN =
  'Asks you a few quick questions, then sets up a small team of helpers for you to approve.';
export const BUILDER_SUMMARY_KEY = 'orchestrator:summary';
/** once the team is built: what the main helper does from then on */
export const BUILDER_LEAD_EN =
  'Looks after your team: passes each job to the right helper, and can add or change helpers when you ask.';
export const BUILDER_LEAD_KEY = 'orchestrator:summaryLead';
const SUMMARY_MAX = 160;

/** the built-in team builder's agent id, or null when there is none */
export function builtInAgentId(db: Sqlite): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(ORCHESTRATOR_AGENT_SETTING) as
    | { value: string }
    | undefined;
  if (!r) return null;
  try {
    const v = JSON.parse(r.value) as unknown;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * One line about the agent's job: the first paragraph of its instructions, markdown marks dropped, at most two
 * sentences (one when two run long), cut at a word under 160 characters. '' when there are no instructions.
 */
export function jobSummary(instructions: string): string {
  const plain = (p: string) =>
    p
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
      .replace(/[`*_#>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const paras = instructions
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p));
  // a heading alone ("## Role") or a lead-in ("How it works:") says nothing about the job: the next paragraph does
  const isLabel = (p: string) => /^#+\s/.test(p) && !p.includes('\n');
  const text = plain(paras.find((p) => !isLabel(p) && !/:\s*$/.test(p)) ?? paras[0] ?? '');
  const sentences = text.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu)?.map((s) => s.trim()) ?? [];
  let out = sentences[0] ?? text;
  if (sentences[1] && `${out} ${sentences[1]}`.length <= SUMMARY_MAX) out = `${out} ${sentences[1]}`;
  if (out.length <= SUMMARY_MAX) return out;
  const cut = out.slice(0, SUMMARY_MAX - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > SUMMARY_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

export interface AgentViewOpts {
  /** the reader is the owner (else the member/guest copy: no instructions, no paths) */
  owner: boolean;
  i18n?: ServerI18n | undefined;
  /** the reader's language (default: the owner's) */
  lng?: string | undefined;
  /** the built-in builder's id when the caller already read it */
  builtIn?: string | null;
}

/** the team builder's team is built (its interview finished): it now leads that team */
export function teamBuilt(db: Sqlite): boolean {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(ORCHESTRATOR_INTERVIEW_SETTING) as
    | { value: string }
    | undefined;
  if (!r) return false;
  try {
    return (JSON.parse(r.value) as { status?: unknown } | null)?.status === 'done';
  } catch {
    return false;
  }
}

/**
 * The built-in builder's friendly description in `lng`: while it sets the team up, what the setup does; once the
 * team is built (`lead`), what it does from then on (looks after the team, passes work on, adds or changes helpers).
 */
export function builderSummary(i18n: ServerI18n | undefined, lng?: string, lead = false): string {
  const key = lead ? BUILDER_LEAD_KEY : BUILDER_SUMMARY_KEY;
  const s = i18n?.t(key, undefined, lng);
  return s && s !== key && s !== key.split(':')[1] ? s : lead ? BUILDER_LEAD_EN : BUILDER_SUMMARY_EN;
}

export function agentView(db: Sqlite, a: AgentDTO, o: AgentViewOpts): AgentDTO {
  const builtIn = o.builtIn !== undefined ? o.builtIn : builtInAgentId(db);
  if (builtIn && a.id === builtIn)
    return {
      ...a,
      instructions: '',
      ...(o.owner ? {} : { workspaceDir: '' }),
      builtIn: true,
      summary: builderSummary(o.i18n, o.lng, teamBuilt(db)),
    };
  if (!o.owner) return { ...a, instructions: '', workspaceDir: '', summary: '' };
  return { ...a, summary: jobSummary(a.instructions) };
}
