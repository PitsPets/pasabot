/**
 * The built-in team builder (owner onboarding idea, 2026-11-15). Right after "Pick a brain" the server makes ONE
 * agent, the orchestrator, with our own system prompt (`prompts/team-builder.md`), and it opens its chat with a
 * hello and the first question. The interview is a server-side state machine (`interview.ts`): at most five
 * questions, one at a time, each a card with quick answers; the owner taps one or types their own words. A model only
 * words a question or reads typed words (`orchestrator_answer`); when it does not, the server reads the words itself
 * once the turn ends. Then ONE plan card (helpers, their jobs, the brain, the setup steps it will open) with Approve
 * and Change; only the owner's Approve creates the helpers, through the AgentAdmin port, on the orchestrator's brain
 * and at no more than the server's default trust. Email and chat apps open the existing guided pages, where the
 * person types any secret: the builder never asks for one.
 *
 * The Stage (onboarding direction A, ws/r6-onboarding): a new owner gets the same interview full screen (`stage:
 * true` on /start, web route `#/team-setup`). It adds three intro steps the server also drives (hello, the language
 * helpers reply in, the main helper's name), Back on every step and "skip for now" that resumes; it posts no cards in
 * the chat while it runs and ONE summary at the end. The language is the server's state and goes into every
 * helper's instructions here (`instructionsFor`), never from a model's words; the name is checked (`checkName`) and
 * applied through `AgentAdmin.rename`. The setup screen drives every Stage step: its plan is the server's own (from
 * the answers), the model's answer and plan tools refuse, and words in the chat are never read as answers. Words
 * typed with a tapped quick answer go into the helpers' instructions too, never just shown back.
 *
 * Who may act: every route is owner-only, and the three tools work only for the orchestrator agent in a turn the
 * owner started in its own chat (members, guests and other agents are refused). Plans from a model are validated and
 * capped; every text in a card is plain text, rendered as text.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import { SUPPORTED_LOCALES } from '@pasabot/i18n';
import type { MessageBlock, MessageDTO, RunDTO } from '@pasabot/protocol';
import { z } from 'zod';
import * as iv from './interview.js';

const here = dirname(fileURLToPath(import.meta.url));
/** our own, reviewed system prompt of the orchestrator (loaded for that agent only) */
export const PROMPT_FILE = join(here, '..', 'prompts', 'team-builder.md');
let prompt: string | null = null;
export const teamBuilderPrompt = (): string => {
  prompt ??= readFileSync(PROMPT_FILE, 'utf8').trim();
  return prompt;
};

export const MODULE_ID = 'orchestrator';
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SYS = (why: string) => asSystem(`orchestrator: ${why}`);
/** a short reason starts with a capital (in scripts that have one), whoever wrote it: "Because: Money and budget" */
const capFirst = (x: string, lang: string): string => {
  const [first = '', ...rest] = Array.from(x);
  return first.toLocaleUpperCase(lang) + rest.join('');
};
const lowFirst = (x: string, lang: string): string => {
  const [first = '', ...rest] = Array.from(x);
  return first.toLocaleLowerCase(lang) + rest.join('');
};

const optionSchema = z.object({ id: z.string().max(40), label: z.string().max(120) });
export const questionBlockSchema = z.object({
  qid: z.enum(iv.QUESTIONS),
  round: z.number().int(),
  step: z.number().int().min(1).max(iv.QUESTIONS.length),
  total: z.number().int(),
  options: z.array(optionSchema).max(8),
  answer: z.string().max(iv.CAP.answer).nullable(),
  closed: z.boolean(),
});
export const planBlockSchema = z.object({
  planId: z.string().max(40),
  state: z.enum(['open', 'approved', 'changed', 'skipped']),
  brain: z.string().max(120),
  agents: z
    .array(
      z.object({
        key: z.string().max(40),
        name: z.string().max(iv.CAP.name),
        job: z.string().max(iv.CAP.job),
        /** the face the helper will keep (an avatar seed) */
        face: z.string().max(40).optional(),
      }),
    )
    .max(iv.CAP.agents),
  steps: z
    .array(z.object({ kind: z.enum(iv.STEP_KINDS), label: z.string().max(120) }))
    .max(iv.STEP_KINDS.length),
});
export const teamBlockSchema = z.object({
  agents: z
    .array(
      z.object({
        agentId: z.string().regex(ID),
        chatId: z.string().regex(ID),
        name: z.string().max(80),
        /** the helper's avatar salt (the face its plan showed) */
        salt: z.string().max(80).optional(),
        /** the plan role it came from (`mail` = the helper that looks after the mailbox) */
        key: z.string().max(40).optional(),
      }),
    )
    .max(iv.CAP.agents),
  steps: z
    .array(z.object({ kind: z.enum(iv.STEP_KINDS), label: z.string().max(120) }))
    .max(iv.STEP_KINDS.length),
  /** set up on the Stage: what the owner told it, as plain text (shown as text, never read as instructions) */
  summary: z
    .array(z.object({ q: z.string().max(iv.CAP.phrasing), a: z.string().max(iv.CAP.answer) }))
    .max(8)
    .optional(),
});

type Owner = { kind: 'user'; id: string };

export function createOrchestratorModule(): PasaBotModule {
  return defineModule({
    id: MODULE_ID,
    register(app: ModuleHost) {
      // ---------- state (one interview: a server has one owner) ----------
      const load = (): iv.Interview | null => app.config.get<iv.Interview | null>('interview', null);
      const save = (s: iv.Interview) => app.config.set('interview', s);
      const t = (lang: string, key: string, params?: Record<string, string | number>) =>
        app.i18n.t(`orchestrator:${key}`, params, lang);
      const labels = (qid: iv.Qid, lang: string): Record<string, string> =>
        Object.fromEntries(iv.OPTIONS[qid].map((id) => [id, t(lang, `q.${qid}.options.${id}`)]));
      const stepLabel = (lang: string, k: iv.StepKind) => t(lang, `plan.steps.${k}`);
      /** several quick answers as one line in `lang` ("My shop or business and Money and budget") */
      const listOf = (lang: string, items: string[]): string => {
        try {
          return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
        } catch {
          return items.join(', ');
        }
      };
      /** the label(s) of an answer's quick answers in `lang` (what a tap alone shows back) */
      const pickedText = (qid: iv.Qid, lang: string, a: iv.Answer): string =>
        listOf(
          lang,
          // one sentence: the labels after the first start small ("My shop or business and school and learning"),
          // except in German, where a noun keeps its capital
          iv.choicesOf(a).map((c, i) => {
            const label = t(lang, `q.${qid}.options.${c}`);
            return i === 0 || lang.startsWith('de') ? label : lowFirst(label, lang);
          }),
        );
      /** every change of the interview runs one at a time (routes, tools and bus events interleave on awaits) */
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(f: () => T | Promise<T>): Promise<T> => {
        const next = chain.then(f, f);
        chain = next.catch(() => {});
        return next;
      };

      // ---------- cards ----------
      const post = (s: iv.Interview, body: string, blocks: MessageBlock[] = []) =>
        app.chats.post(SYS('a setup message'), {
          chatId: s.chatId,
          authorKind: 'agent',
          authorId: s.agentId,
          body,
          blocks,
        });
      const patchCard = (messageId: string | null, patch: Record<string, unknown>) => {
        if (!messageId) return;
        const m = app.chats.message(SYS('settle a setup card'), messageId);
        const b = m?.blocks[0];
        if (!m || !b) return;
        app.chats.updateBlocks(SYS('settle a setup card'), messageId, [
          { ...b, data: { ...(b.data as object), ...patch } },
        ]);
      };
      const ask = (s: iv.Interview): iv.Interview => {
        const qid = iv.current(s);
        if (!qid) return s;
        // the Stage shows the question itself: nothing is posted in the chat while it runs
        if (s.mode === 'stage') return { ...s, questionMessageId: null, phrasing: null };
        const l = labels(qid, s.lang);
        const data: z.infer<typeof questionBlockSchema> = {
          qid,
          round: s.round,
          step: s.step + 1,
          total: iv.QUESTIONS.length,
          options: iv.OPTIONS[qid].map((id) => ({ id, label: l[id] ?? id })),
          answer: null,
          closed: false,
        };
        const m = post(s, s.phrasing ?? t(s.lang, `q.${qid}.text`), [
          { kind: 'orchestrator.question', v: 1, data },
        ]);
        return { ...s, questionMessageId: m.id, phrasing: null };
      };
      const brainName = async (agentId: string) => {
        const a = await app.agents.get(agentId);
        const p = a ? app.providers.get(a.providerId) : undefined;
        if (!p) return a?.providerId ?? '';
        const key = (p as { displayNameKey?: string }).displayNameKey;
        return key ? app.i18n.t(key) : p.displayName;
      };
      /** a language's own name ("Filipino", "日本語"); Taglish in the owner's language */
      const languageName = (code: string, lang: string) =>
        code === 'taglish' ? t(lang, 'stage.lang.taglish') : app.i18n.t('core:meta.name', undefined, code);
      const fold = (x: string) => x.normalize('NFKC').toLocaleLowerCase().trim();
      /**
       * The owner's own words given with a tapped quick answer (or as the answer itself), else null when the text is
       * just the quick answer's label (in any shipped language: the owner may have switched it since).
       */
      const ownWords = (qid: iv.Qid, a: iv.Answer | undefined): string | null => {
        if (!a?.text) return null;
        if (!iv.choicesOf(a).length) return a.text;
        const f = fold(a.text);
        for (const loc of SUPPORTED_LOCALES) if (fold(pickedText(qid, loc, a)) === f) return null;
        return a.text;
      };
      /** `detail`: what the owner said about the answer this helper comes from, when they typed their own words */
      const instructionsFor = (s: iv.Interview, job: string, detail: string | null = null) => {
        const lines = [job];
        if (detail) lines.push(t(s.lang, 'plan.detail', { what: detail }));
        lines.push(t(s.lang, 'plan.base'));
        // the language the owner picked on the Stage, from the server's own state (never from a model's words)
        if (s.language === 'taglish') lines.push(t(s.lang, 'plan.taglish'));
        else if (s.language)
          lines.push(t(s.lang, 'plan.language', { language: languageName(s.language, s.lang) }));
        const a = s.answers.askFirst;
        if (a?.choice && a.choice !== 'none') lines.push(t(s.lang, `plan.askFirst.${a.choice}`));
        // words typed with (or instead of) a quick answer are a rule of their own: never dropped
        const own = ownWords('askFirst', a);
        if (own) lines.push(t(s.lang, 'plan.askFirst.custom', { what: own }));
        return lines.join('\n\n').slice(0, iv.CAP.instructions);
      };
      /** the answer a deterministic plan role comes from */
      const sourceOf = (key: string): iv.Qid | null =>
        key === 'mail' ? 'email' : key in iv.ROLES ? 'help' : null;
      const deterministicPlan = (s: iv.Interview): iv.Plan => {
        const { roles, steps } = iv.planFromAnswers(s.answers);
        const what = s.answers.help?.text || t(s.lang, 'plan.roles.custom.anything');
        return {
          id: ulid(),
          state: 'open',
          steps,
          agents: roles.map((key) => {
            const job = iv.plain(
              key === 'custom'
                ? t(s.lang, 'plan.roles.custom.job', { what })
                : t(s.lang, `plan.roles.${key}.job`),
              iv.CAP.job,
            );
            // the custom job already carries the owner's words
            const q = key === 'custom' ? null : sourceOf(key);
            const detail = q ? ownWords(q, s.answers[q]) : null;
            // the face is picked now, with the plan: the card, the done screen and the app show the same one
            return {
              key,
              name: iv.ROLES[key],
              job,
              instructions: instructionsFor(s, job, detail),
              face: ulid(),
            };
          }),
        };
      };
      const showPlan = async (s: iv.Interview, plan: iv.Plan): Promise<iv.Interview> => {
        if (s.status === 'asking') patchCard(s.questionMessageId, { closed: true });
        if (s.plan?.state === 'open') patchCard(s.planMessageId, { state: 'changed' });
        const data: z.infer<typeof planBlockSchema> = {
          planId: plan.id,
          state: 'open',
          brain: await brainName(s.agentId),
          agents: plan.agents.map((a) => ({
            key: a.key,
            name: a.name,
            job: a.job,
            ...(a.face ? { face: a.face } : {}),
          })),
          steps: plan.steps.map((kind) => ({ kind, label: stepLabel(s.lang, kind) })),
        };
        // the Stage shows the plan itself: no card in the chat
        if (s.mode === 'stage')
          return { ...s, status: 'plan', intro: null, plan, planMessageId: null, pending: null, created: [] };
        const m = post(s, t(s.lang, 'plan.intro'), [{ kind: 'orchestrator.plan', v: 1, data }]);
        // `created` belongs to the plan it was made for: a new plan (e.g. after the first team is done) starts empty,
        // so its Approve really creates its helpers
        return { ...s, status: 'plan', plan, planMessageId: m.id, pending: null, created: [] };
      };
      /** the open question takes this answer; then the next question, or the plan card */
      const advance = async (s: iv.Interview, qid: iv.Qid, a: iv.Answer, phrasing: string | null = null) => {
        patchCard(s.questionMessageId, { answer: iv.plain(a.text, iv.CAP.answer) || a.choice });
        let n = iv.answer(s, qid, a);
        n = n.status === 'asking' ? ask({ ...n, phrasing }) : await showPlan(n, deterministicPlan(n));
        save(n);
        return n;
      };
      const startRound = (s: iv.Interview, intro: string): iv.Interview => {
        if (s.status === 'asking') patchCard(s.questionMessageId, { closed: true });
        if (s.plan?.state === 'open') patchCard(s.planMessageId, { state: 'changed' });
        const n = iv.newInterview({ ...s, round: s.round + 1 });
        post(n, intro);
        const asked = ask(n);
        save(asked);
        return asked;
      };
      const createTeam = async (s: iv.Interview): Promise<iv.Interview> => {
        if (s.plan?.state !== 'approved') throw new Error('the plan is not approved');
        if (s.created.length) return s;
        const orch = await app.agents.get(s.agentId);
        if (!orch) throw new Error('the team builder is gone');
        const owner: Owner = { kind: 'user', id: s.ownerId };
        const created: iv.Interview['created'] = [];
        for (const a of s.plan.agents) {
          const r = app.agentAdmin.importBundle(owner, {
            format: 'pasabot.agent-bundle',
            v: 1,
            exportedAt: Date.now(),
            agent: {
              name: a.name,
              avatar: { hue: Math.floor(Math.random() * 360), glyph: a.name.slice(0, 1).toUpperCase() },
              instructions: a.instructions,
              providerId: orch.providerId,
              model: orch.model,
              fallback: [],
              // importBundle keeps min(this, the server's default): the helpers start at the default trust
              trustLevel: 'trusted',
              limits: {},
            },
            chats: [{ ref: 'c1', kind: 'direct', title: a.name, createdAt: Date.now(), messages: [] }],
          });
          // the face the plan showed (decided when the plan was made, kept on the server)
          const salt = a.face ? iv.faceSalt(a.face) : undefined;
          if (salt) app.agentAdmin.rename(owner, r.agentId, { name: a.name, avatarSalt: salt });
          created.push({
            agentId: r.agentId,
            chatId: r.chatIds[0]!,
            name: a.name,
            ...(salt ? { salt } : {}),
          });
        }
        const data: z.infer<typeof teamBlockSchema> = {
          // each with its plan role, so the inbox knows which helper looks after the mailbox
          agents: created.map((c, i) => ({ ...c, key: s.plan!.agents[i]!.key })),
          steps: s.plan.steps.map((kind) => ({ kind, label: stepLabel(s.lang, kind) })),
        };
        if (s.mode === 'stage') {
          // the chat keeps a short summary of the Stage: the language, each answer, then the helpers' links
          const summary: { q: string; a: string }[] = [];
          if (s.language)
            summary.push({ q: t(s.lang, 'stage.summary.language'), a: languageName(s.language, s.lang) });
          for (const q of iv.QUESTIONS) {
            const a = s.answers[q];
            if (a) summary.push({ q: t(s.lang, `q.${q}.text`), a: iv.plain(a.text, iv.CAP.answer) || '-' });
          }
          data.summary = summary;
          post(s, t(s.lang, 'stage.summary.body'), [{ kind: 'orchestrator.team', v: 1, data }]);
        } else post(s, t(s.lang, 'team.ready'), [{ kind: 'orchestrator.team', v: 1, data }]);
        const n: iv.Interview = { ...s, status: 'done', created };
        save(n);
        // the main helper's one-line job now says what it does from here on (it leads the team): an unchanged
        // limits write republishes `agent.updated`, so an open side panel shows it at once
        app.agentAdmin.setLimits(owner, s.agentId, {});
        return n;
      };
      /** a live orchestrator (its agent still there, not deleted) */
      const live = async (): Promise<iv.Interview | null> => {
        const s = load();
        if (!s) return null;
        const a = await app.agents.get(s.agentId);
        return a && !a.archivedAt ? s : null;
      };

      // ---------- blocks ----------
      app.blocks.register('orchestrator.question', questionBlockSchema);
      app.blocks.register('orchestrator.plan', planBlockSchema);
      app.blocks.register('orchestrator.team', teamBlockSchema);

      // ---------- routes (owner only) ----------
      const owner = (ctx: AuthedCtx<unknown>): string => {
        const p = ctx.principal;
        if (p.kind !== 'session' || p.userKind !== 'owner')
          throw new HttpError(403, 'only the owner sets up the team', 'owner_only');
        return p.userId;
      };
      const mine = async (userId: string): Promise<iv.Interview> => {
        const s = await live();
        if (!s || s.ownerId !== userId) throw new HttpError(404, 'no team setup here', 'not_found');
        return s;
      };
      const langOf = (l: string | undefined) => (l && LANG.test(l) ? l : 'en');

      const makeOrchestrator = async (
        userId: string,
        brain: { providerId: string; model: string | null },
        lang: string,
        stage = false,
      ): Promise<iv.Interview> => {
        const name = t(lang, 'defaultName');
        const r = app.agentAdmin.importBundle(
          { kind: 'user', id: userId },
          {
            format: 'pasabot.agent-bundle',
            v: 1,
            exportedAt: Date.now(),
            agent: {
              name,
              avatar: { hue: Math.floor(Math.random() * 360), glyph: name.slice(0, 1).toUpperCase() },
              instructions: teamBuilderPrompt(),
              providerId: brain.providerId,
              model: brain.model,
              fallback: [],
              trustLevel: 'trusted',
              limits: {},
            },
            chats: [{ ref: 'c1', kind: 'direct', title: name, createdAt: Date.now(), messages: [] }],
          },
          // recorded as the built-in builder before it is published: its prompt never reaches a client
          { teamBuilder: true },
        );
        app.config.set('agentId', r.agentId);
        const base = { ownerId: userId, agentId: r.agentId, chatId: r.chatIds[0]!, lang };
        if (stage) {
          // the Stage says hello itself; the chat stays empty until the summary
          const st = iv.newStageInterview(base);
          save(st);
          return st;
        }
        const s = iv.newInterview(base);
        post(s, t(lang, 'hello', { name }));
        const asked = ask(s);
        save(asked);
        return asked;
      };

      // ---------- the Stage (onboarding direction A): the same interview, full screen ----------
      /** 'open' (shown on the next visit), 'paused' (skipped for now), 'done', or null for a chat interview */
      const stageState = (s: iv.Interview): 'open' | 'paused' | 'done' | null => {
        if (s.mode !== 'stage') return null;
        // W40: the "needs your OK" screen is still part of the Stage (the app brings the owner back to it)
        if (s.status === 'done' && s.oksOpen) return s.paused ? 'paused' : 'open';
        if (s.status === 'done' || s.status === 'skipped') return 'done';
        return s.paused ? 'paused' : 'open';
      };
      /**
       * Why a deterministic plan role is there, as a short reason (a model's plan has none): the money helper has its
       * own fixed reason (it comes with the shop helper, so the two never repeat each other), and so has the mail
       * helper (what it looks after, not the email answer's label); the others show the answer they came from,
       * clipped to a short line.
       */
      const whyOf = (s: iv.Interview, key: string): string | null => {
        // the money and mail helpers have their own fixed reason (an answer label like "Make a new mailbox" is no reason)
        if (key === 'money' || key === 'mail') return capFirst(t(s.lang, `plan.roles.${key}.why`), s.lang);
        const q = sourceOf(key);
        const a = q ? s.answers[q] : undefined;
        if (!q || !a) return null;
        // several areas picked: each helper names its own one (never the whole list on every card)
        const own = iv.HELP_OF[key as iv.RoleKey];
        const why =
          q === 'help' && own && iv.choicesOf(a).length > 1
            ? t(s.lang, `q.help.options.${own}`)
            : a.text || pickedText(q, s.lang, a);
        return capFirst(iv.clip(why, iv.CAP.why), s.lang);
      };
      /**
       * What the Stage needs to draw the current step. Question texts and quick-answer labels are drawn from the
       * module's locale files by id (so a language change shows at once); names, jobs and answers are the server's
       * plain text. Nothing internal (the team builder's prompt, the helpers' instructions) is in it.
       */
      const stageView = async (s: iv.Interview) => {
        const me = await app.agents.get(s.agentId);
        const qid = iv.current(s);
        return {
          round: s.round,
          status: s.status,
          stage: stageState(s),
          intro: s.intro ?? null,
          step: iv.stageStep(s),
          total: iv.STAGE_TOTAL,
          agentId: s.agentId,
          chatId: s.chatId,
          name: me?.name ?? t(s.lang, 'defaultName'),
          defaultName: t(s.lang, 'defaultName'),
          nameIdeas: iv.NAME_IDEAS,
          language: s.language ?? null,
          languages: iv.stageLanguages(SUPPORTED_LOCALES).map((code) => ({
            code,
            ui: iv.uiLocale(code),
            name: languageName(code, s.lang),
            sample: code === 'taglish' ? t(s.lang, 'stage.lang.taglishSample') : t(code, 'stage.lang.sample'),
          })),
          qid,
          /** the open question takes several quick answers (checkboxes, not one pick) */
          multi: qid ? iv.MULTI.has(qid) : false,
          questions: iv.QUESTIONS,
          options: qid ? iv.OPTIONS[qid] : [],
          // `own`: the answer is the owner's own words (shown as typed), not just the quick answer(s) they tapped
          answers: Object.fromEntries(
            Object.entries(s.answers).map(([q, a]) => [q, { ...a, own: ownWords(q as iv.Qid, a) !== null }]),
          ),
          /** an answer tapped or typed on this question but not sent before "Skip for now": shown again, unsent */
          draft: (() => {
            const d = iv.draftFor(s);
            return d ? { choices: d.choices, text: d.text } : null;
          })(),
          plan:
            s.plan && s.status !== 'asking'
              ? {
                  planId: s.plan.id,
                  state: s.plan.state,
                  agents: s.plan.agents.map((a) => ({
                    key: a.key,
                    name: a.name,
                    job: a.job,
                    why: whyOf(s, a.key),
                    face: a.face ?? null,
                  })),
                  steps: s.plan.steps.map((kind) => ({ kind, label: stepLabel(s.lang, kind) })),
                }
              : null,
          team: s.status === 'done' ? s.created : [],
          /** W40: the "A few things need your OK" screen (after the team is made, before the finish) */
          oks: s.oks?.length
            ? {
                open: !!s.oksOpen,
                items: s.oks.map((i) => ({
                  kind: i.kind,
                  app: i.app ?? null,
                  appName: i.app && i.kind !== 'email' ? (iv.APP_NAMES[i.app] ?? i.app) : null,
                  state: i.state,
                  href: iv.okHref(i, s.chatId, s.agentId),
                })),
              }
            : null,
        };
      };
      /** this computer can be used by a helper: the computer module is here and the platform supports it */
      const computerHere = () =>
        (process.platform === 'darwin' || process.platform === 'linux') &&
        app.tools.list().some((d) => d.name.startsWith('computer_'));
      /**
       * Every OK not done yet becomes a card from the main helper in its chat: the ones left "Later", and the ones
       * whose page was opened from the OK screen (a tap only opens the guided page; leaving it unfinished must not lose
       * the item). Only an OK that blocks a helper (the mail helper's mailbox) needs an answer and is counted in the
       * pinned decision bar; the optional connects and allows are quiet ideas. A tap on Connect / Allow only opens the
       * guided page: the card stays open until the owner says "Not now", or until the thing is really done (the email
       * checklist reached its last step, the app's "is connected" card arrived: `okRefsDone` below).
       */
      const laterCards = (s: iv.Interview) => {
        for (const i of s.oks ?? []) {
          if (i.state === 'open') continue;
          const name = i.app && i.kind !== 'email' ? (iv.APP_NAMES[i.app] ?? i.app) : '';
          const link = i.kind === 'email' || i.kind === 'chat' || i.kind === 'apps';
          const blocks = iv.okBlocks(i);
          try {
            app.cards.post({
              chatId: s.chatId,
              authorAgentId: s.agentId,
              card: {
                variant: blocks ? (link ? 'connect' : 'ok') : 'suggestion',
                title: { key: `orchestrator:oks.${i.kind}.title`, params: { app: name } },
                text: { key: `orchestrator:oks.${i.kind}.why`, params: { app: name } },
                actions: [
                  {
                    id: 'yes',
                    label: { key: `orchestrator:oks.${i.kind}.yes` },
                    style: 'primary',
                    href: iv.okHref(i, s.chatId, s.agentId),
                  },
                  { id: 'later', label: { key: 'orchestrator:oks.notNow' }, style: 'ghost', settle: 'later' },
                ],
                ...(blocks ? { needsAnswer: true } : {}),
                ref: `orchestrator.ok:${i.kind}:${i.app ?? ''}`,
                source: 'orchestrator.ok',
                agentId: s.agentId,
              },
            });
          } catch (e) {
            app.log.warn('an OK card was not posted', { error: (e as Error).message });
          }
        }
      };
      /** a Stage step route: the owner's live Stage interview, open, on the step the screen showed */
      const onStage = async (ctx: AuthedCtx<unknown>, intro?: iv.IntroStep): Promise<iv.Interview> => {
        const s = await mine(owner(ctx));
        if (s.mode !== 'stage' || (s.status !== 'asking' && s.status !== 'plan'))
          throw new HttpError(409, 'the team setup is not open', 'stale');
        if (intro && s.intro !== intro) throw new HttpError(409, 'that step was already done', 'stale');
        return s;
      };

      app.http.route({
        method: 'GET',
        url: '/stage',
        auth: 'session',
        handler: async (ctx) => {
          const s = await mine(owner(ctx));
          if (s.mode !== 'stage') throw new HttpError(404, 'no team setup screen here', 'not_found');
          return stageView(s);
        },
      });

      app.http.route({
        method: 'POST',
        url: '/stage/welcome',
        auth: 'session',
        handler: (ctx) =>
          serial(async () => {
            const n: iv.Interview = { ...(await onStage(ctx, 'welcome')), intro: 'language', paused: false };
            save(n);
            return stageView(n);
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/stage/language',
        auth: 'session',
        /** `stay`: a tap on a language card saves the pick at once; Continue (no `stay`) also moves on */
        body: z.object({ code: z.string().max(20), stay: z.boolean().optional() }),
        handler: (ctx) =>
          serial(async () => {
            const s = await onStage(ctx, 'language');
            const code = ctx.body.code;
            if (!iv.stageLanguages(SUPPORTED_LOCALES).includes(code))
              throw new HttpError(400, 'unknown language', 'invalid_input');
            // the owner's pick: texts are worded in its UI locale; helpers are told to reply in it (Taglish = mix)
            const n: iv.Interview = {
              ...s,
              language: code,
              lang: iv.uiLocale(code),
              intro: ctx.body.stay ? 'language' : 'name',
            };
            save(n);
            return stageView(n);
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/stage/name',
        auth: 'session',
        body: z.object({ name: z.string().max(200) }),
        handler: (ctx) =>
          serial(async () => {
            const s = await onStage(ctx, 'name');
            const others = (await app.agents.list())
              .filter((a) => a.id !== s.agentId && !a.archivedAt)
              .map((a) => a.name);
            const c = iv.checkName(ctx.body.name, others);
            if (!c.ok) throw new HttpError(400, 'that name cannot be used', `name_${c.code}`);
            // the default name keeps the original look; any other name gets its own face (seed = id + name)
            const salt = c.name === t(s.lang, 'defaultName') ? '' : c.name;
            app.agentAdmin.rename({ kind: 'user', id: s.ownerId }, s.agentId, {
              name: c.name,
              avatarSalt: salt,
            });
            const n: iv.Interview = { ...s, intro: null };
            save(n);
            return stageView(n);
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/stage/back',
        auth: 'session',
        body: z.object({ step: z.number().int() }),
        handler: (ctx) =>
          serial(async () => {
            const s = await onStage(ctx);
            // a second tap (or a second tab) on a step already left goes nowhere
            if (iv.stageStep(s) !== ctx.body.step) throw new HttpError(409, 'that step was left', 'stale');
            const n = iv.back(s);
            save(n);
            return stageView(n);
          }),
      });

      app.http.route({
        method: 'GET',
        url: '/state',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const s = await live();
          return s
            ? {
                agentId: s.agentId,
                chatId: s.chatId,
                status: s.status,
                stage: stageState(s),
                // W40: the Stage is open on its "needs your OK" screen
                ...(s.status === 'done' && s.oksOpen ? { oks: true } : {}),
              }
            : { agentId: null, chatId: null, status: null, stage: null };
        },
      });

      app.http.route({
        method: 'POST',
        url: '/start',
        auth: 'session',
        body: z.object({
          providerId: z.string().min(1).max(80),
          model: z.string().max(200).nullish(),
          lang: z.string().max(20).optional(),
          /** the first run's Stage (full screen) instead of the cards in the chat */
          stage: z.boolean().optional(),
        }),
        handler: (ctx) =>
          serial(async () => {
            const userId = owner(ctx);
            if (!app.providers.get(ctx.body.providerId))
              throw new HttpError(400, 'unknown brain', 'unknown_provider');
            const had = await live();
            // resumable: a second start (a reload, a second tab) opens the same chat where it left off
            if (had)
              return { agentId: had.agentId, chatId: had.chatId, status: had.status, stage: stageState(had) };
            const s = await makeOrchestrator(
              userId,
              { providerId: ctx.body.providerId, model: ctx.body.model ?? null },
              langOf(ctx.body.lang),
              ctx.body.stage === true,
            );
            return httpResponse(201, {
              agentId: s.agentId,
              chatId: s.chatId,
              status: s.status,
              stage: stageState(s),
            });
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/answer',
        auth: 'session',
        body: z.object({
          round: z.number().int(),
          qid: z.enum(iv.QUESTIONS),
          choice: z.string().max(40).optional(),
          /** several quick answers at once: only on a MULTI question (the Stage's "what do you want help with") */
          choices: z.array(z.string().max(40)).min(1).max(8).optional(),
          text: z.string().min(1).max(2000).optional(),
        }),
        handler: (ctx) =>
          serial(async () => {
            const s = await mine(owner(ctx));
            const { qid, round, choice, choices, text } = ctx.body;
            if (s.round !== round || iv.current(s) !== qid)
              throw new HttpError(409, 'that question was already answered', 'stale');
            let a: iv.Answer;
            const picked = choices ?? (choice !== undefined ? [choice] : null);
            if (picked) {
              if (choice !== undefined && choices)
                throw new HttpError(400, 'choice or choices', 'invalid_input');
              if (picked.length > 1 && !iv.MULTI.has(qid))
                throw new HttpError(400, 'this question takes one answer', 'invalid_input');
              if (picked.some((c) => !iv.OPTIONS[qid].includes(c)))
                throw new HttpError(400, 'unknown quick answer', 'invalid_input');
              // tapped quick answer(s) with the owner's own words (the Stage): the words are what is shown back
              const own = text ? iv.plain(app.redact(text), iv.CAP.answer) : '';
              const whole = iv.withChoices(qid, { choice: picked[0]!, choices: picked, text: '' });
              a = { ...whole, text: own || pickedText(qid, s.lang, whole) };
            } else if (text) {
              a = iv.readAnswer(qid, app.redact(text), [labels(qid, s.lang), labels(qid, 'en')]);
            } else throw new HttpError(400, 'an answer is needed', 'invalid_input');
            const n = await advance(s, qid, a);
            return n.mode === 'stage' ? await stageView(n) : { status: n.status };
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/approve',
        auth: 'session',
        body: z.object({ planId: z.string().max(40) }),
        handler: (ctx) =>
          serial(async () => {
            const s = await mine(owner(ctx));
            if (s.plan?.id !== ctx.body.planId || s.plan.state !== 'open')
              throw new HttpError(409, 'that plan is no longer open', 'stale');
            const approved: iv.Interview = { ...s, plan: { ...s.plan, state: 'approved' } };
            save(approved);
            patchCard(s.planMessageId, { state: 'approved' });
            let n = await createTeam(approved);
            if (n.mode === 'stage') {
              // W40: before the finish, one screen of the things that need the owner's OK (from the answers + plan)
              const oks = iv.okItems(n, { computer: computerHere() });
              if (oks.length) {
                n = { ...n, oks, oksOpen: true };
                save(n);
              }
            }
            return n.mode === 'stage'
              ? { ...(await stageView(n)), created: n.created }
              : { created: n.created };
          }),
      });

      // ---------- W40: "A few things need your OK" (owner only; nothing is granted here) ----------
      const onOks = async (ctx: AuthedCtx<unknown>): Promise<iv.Interview> => {
        const s = await mine(owner(ctx));
        if (s.mode !== 'stage' || s.status !== 'done' || !s.oksOpen)
          throw new HttpError(409, 'that screen is already done', 'stale');
        return s;
      };
      app.http.route({
        method: 'POST',
        url: '/stage/ok',
        auth: 'session',
        body: z.object({
          kind: z.enum(iv.OK_KINDS),
          app: z.string().max(40).optional(),
          choice: z.enum(['yes', 'later']),
        }),
        handler: (ctx) =>
          serial(async () => {
            const s = await onOks(ctx);
            const item = s.oks?.find(
              (i) => i.kind === ctx.body.kind && (i.app ?? '') === (ctx.body.app ?? '') && i.state === 'open',
            );
            if (!item) throw new HttpError(409, 'that one is already answered', 'stale');
            const n = iv.decideOk(s, ctx.body.kind, ctx.body.app, ctx.body.choice);
            save(n);
            return {
              ...(await stageView(n)),
              ...(ctx.body.choice === 'yes' ? { go: iv.okHref(item, n.chatId, n.agentId) } : {}),
            };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/stage/ok/back',
        auth: 'session',
        body: z.object({}).optional(),
        handler: (ctx) =>
          serial(async () => {
            const n = iv.undoOk(await onOks(ctx));
            save(n);
            return await stageView(n);
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/stage/ok/finish',
        auth: 'session',
        body: z.object({}).optional(),
        handler: (ctx) =>
          serial(async () => {
            const s = await onOks(ctx);
            // whatever is still open counts as Later ("Skip all" too); each Later one becomes a card in the chat
            const n: iv.Interview = {
              ...s,
              oks: (s.oks ?? []).map((i) =>
                i.state === 'open' ? { ...i, state: 'later', at: Date.now() } : i,
              ),
              oksOpen: false,
              paused: false,
            };
            save(n);
            laterCards(n);
            return await stageView(n);
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/change',
        auth: 'session',
        body: z.object({ planId: z.string().max(40) }),
        handler: (ctx) =>
          serial(async () => {
            const s = await mine(owner(ctx));
            if (s.plan?.id !== ctx.body.planId || s.plan.state !== 'open')
              throw new HttpError(409, 'that plan is no longer open', 'stale');
            if (s.mode === 'stage') {
              // the Stage goes back to the first question; every answer stays picked, ready to change
              const n: iv.Interview = {
                ...s,
                status: 'asking',
                intro: null,
                step: 0,
                round: s.round + 1,
                plan: null,
                pending: null,
              };
              save(n);
              return await stageView(n);
            }
            const n = startRound(s, t(s.lang, 'change'));
            return { status: n.status };
          }),
      });

      app.http.route({
        method: 'POST',
        url: '/skip',
        auth: 'session',
        body: z
          .object({
            /** the Stage: an answer tapped or typed on the open question but not sent yet, kept for the resume */
            draft: z
              .object({
                round: z.number().int(),
                qid: z.string().max(40),
                choices: z.array(z.string().max(40)).max(8).optional(),
                text: z.string().max(2000).optional(),
              })
              .optional(),
          })
          .optional(),
        handler: (ctx) =>
          serial(async () => {
            const s = await mine(owner(ctx));
            if (s.status !== 'asking' && s.status !== 'plan') return { status: s.status };
            if (s.mode === 'stage') {
              // "Skip for now" on the Stage keeps every step where it is (an unsent answer too); Settings opens it
              // again there
              if (!s.paused) post(s, t(s.lang, 'stage.skipped'));
              const d = ctx.body?.draft;
              const draft = iv.keepDraft(s, d && { ...d, ...(d.text ? { text: app.redact(d.text) } : {}) });
              const n: iv.Interview = { ...s, paused: true, pending: null, draft };
              save(n);
              return { status: n.status, stage: stageState(n), chatId: n.chatId };
            }
            if (s.status === 'asking') patchCard(s.questionMessageId, { closed: true });
            if (s.plan?.state === 'open') patchCard(s.planMessageId, { state: 'skipped' });
            const n: iv.Interview = {
              ...s,
              status: 'skipped',
              pending: null,
              plan: s.plan ? { ...s.plan, state: s.plan.state === 'open' ? 'skipped' : s.plan.state } : null,
            };
            post(n, t(s.lang, 'skipped'));
            save(n);
            return { status: n.status };
          }),
      });

      // "Set up my team again" (Settings): a new round in the same chat; with no team builder left, a new one on the
      // brain of the newest agent
      app.http.route({
        method: 'POST',
        url: '/restart',
        auth: 'session',
        body: z.object({ lang: z.string().max(20).optional(), stage: z.boolean().optional() }),
        handler: (ctx) =>
          serial(async () => {
            const userId = owner(ctx);
            const s = await live();
            if (s && ctx.body.stage) {
              // run the Stage again: an unfinished one resumes where it was; a finished (or chat) one starts a new
              // round on the hello, keeping the language and the answers picked. Helpers already made stay.
              // W40: a Stage still on its "needs your OK" screen resumes there too (Continue in Settings)
              const open =
                s.mode === 'stage' &&
                (s.status === 'asking' || s.status === 'plan' || (s.status === 'done' && !!s.oksOpen));
              let n: iv.Interview;
              if (open) n = { ...s, paused: false };
              else {
                if (s.status === 'asking') patchCard(s.questionMessageId, { closed: true });
                if (s.plan?.state === 'open') patchCard(s.planMessageId, { state: 'changed' });
                n = {
                  ...iv.newStageInterview({ ...s, round: s.round + 1 }),
                  language: s.language ?? null,
                  answers: s.answers,
                };
              }
              save(n);
              return { agentId: n.agentId, chatId: n.chatId, status: n.status, stage: stageState(n) };
            }
            if (s) {
              const lang = ctx.body.lang ? langOf(ctx.body.lang) : s.lang;
              const n = startRound({ ...s, lang }, t(lang, 'again'));
              return { agentId: n.agentId, chatId: n.chatId, status: n.status };
            }
            const newest = (await app.agents.list()).sort((a, b) => b.createdAt - a.createdAt)[0];
            if (!newest || !app.providers.get(newest.providerId))
              throw new HttpError(409, 'set up a brain first', 'no_brain');
            const n = await makeOrchestrator(
              userId,
              { providerId: newest.providerId, model: newest.model },
              langOf(ctx.body.lang),
              ctx.body.stage === true,
            );
            return httpResponse(201, {
              agentId: n.agentId,
              chatId: n.chatId,
              status: n.status,
              stage: stageState(n),
            });
          }),
      });

      // ---------- tools: the orchestrator only, in a turn its owner started in its own chat ----------
      const STAGE_ONLY =
        'This team is set up on the setup screen, which drives every step (the language, the name, the questions ' +
        'and the plan). Nothing was saved. Do not ask the setup questions in this chat. If the owner wants to go on, ' +
        'tell them to open Settings and tap “Continue my team setup” (or “Set up my team again” when it is done).';
      const bound = (ctx: ToolCtx): iv.Interview => {
        const s = load();
        if (!s || ctx.agent.id !== s.agentId) throw new Error('Only the team builder can use this.');
        if (ctx.sender.kind !== 'owner' || ctx.sender.id !== s.ownerId)
          throw new Error('Only the owner, in their own chat with the team builder, can do this.');
        if (app.chats.runChat(ctx.run.id) !== s.chatId)
          throw new Error('This works only in the team builder’s own chat with the owner.');
        return s;
      };
      app.tools.addGuard((call) =>
        call.name.startsWith(`${MODULE_ID}_`) && call.agent.id !== load()?.agentId
          ? 'only the team builder can use this tool'
          : null,
      );

      app.tools.add({
        name: 'orchestrator_answer',
        title: 'Save a setup answer',
        description:
          'Team setup: save the owner’s answer to the open setup question, read from their own words. `answer` is a ' +
          'short summary of what they said, `choice` the matching quick answer id when one clearly fits, ' +
          '`next_question` (optional) the next question re-worded in one short line in their language. Only the ' +
          'team builder can use this, and only for the owner.',
        input: iv.modelAnswerSchema,
        tier: 0,
        handler: (input, ctx) =>
          serial(async () => {
            const s = bound(ctx);
            // the setup screen drives every step of a Stage interview: words in the chat never answer it
            if (s.mode === 'stage') throw new Error(STAGE_ONLY);
            const qid = iv.current(s);
            if (!qid) return 'No setup question is open right now.';
            const l = [labels(qid, s.lang), labels(qid, 'en')];
            const said = app.redact(input.answer);
            const a: iv.Answer =
              input.choice && iv.OPTIONS[qid].includes(input.choice)
                ? { choice: input.choice, text: said }
                : iv.readAnswer(qid, said, l);
            const n = await advance(s, qid, a, iv.usablePhrasing(input.next_question));
            return n.status === 'plan'
              ? 'Saved. PasaBot now shows the plan card. Reply with one short sentence.'
              : 'Saved. PasaBot now shows the next question card. Reply with one short sentence; do not ask it yourself.';
          }),
      });

      app.tools.add({
        name: 'orchestrator_show_plan',
        title: 'Show a team plan',
        description:
          'Team setup: show the owner ONE plan card for up to five helpers (a name and a one-line job each, plain ' +
          'words with no links or email addresses; setup steps from a fixed list). Nothing is created: only the ' +
          'owner’s tap on Approve creates the helpers, and Approve adds them to any helpers made before. Only the ' +
          'team builder can use this, and only for the owner.',
        input: iv.proposedPlanSchema,
        tier: 0,
        handler: (input, ctx) =>
          serial(async () => {
            const s = bound(ctx);
            // a Stage's plan is made by the server from the owner's answers on the setup screen, never by a model
            if (s.mode === 'stage') throw new Error(STAGE_ONLY);
            const agents: iv.PlanAgent[] = [];
            for (const [i, a] of input.agents.entries()) {
              const name = iv.usablePlanText(app.redact(a.name), iv.CAP.name);
              const job = iv.usablePlanText(app.redact(a.job), iv.CAP.job);
              if (name === null || job === null)
                throw new Error(
                  'A plan cannot contain links or email addresses. Use plain names and one-line jobs.',
                );
              const n = name || iv.ROLES.custom;
              const j = job || n;
              // the helper's instructions come from the job the card shows, never from the model
              agents.push({
                key: `p${i + 1}`,
                name: n,
                job: j,
                instructions: instructionsFor(s, j),
                face: ulid(),
              });
            }
            const plan: iv.Plan = {
              id: ulid(),
              state: 'open',
              steps: [...new Set(input.steps ?? [])],
              agents,
            };
            save(await showPlan(s, plan));
            return 'The plan card is shown. Only the owner’s tap on Approve creates these helpers.';
          }),
      });

      app.tools.add({
        name: 'orchestrator_create_team',
        title: 'Create the approved team',
        description:
          'Team setup: create the helpers of the plan card the owner approved with their own tap (once; again it ' +
          'just lists them). Refuses when the owner has not tapped Approve. Only the team builder can use this.',
        input: z.object({}),
        tier: 0,
        handler: (_input, ctx) =>
          serial(async () => {
            const s = bound(ctx);
            if (s.plan?.state !== 'approved')
              throw new Error('The owner has not approved a plan card. Ask them to tap Approve on it.');
            const n = await createTeam(s);
            return `Created: ${n.created.map((c) => c.name).join(', ')}.`;
          }),
      });

      // ---------- the model reads typed words; the server does when it does not ----------
      app.prompt.register({
        id: MODULE_ID,
        async contribute(req) {
          const s = load();
          if (!s || req.agent.id !== s.agentId) return null;
          const items: { text: string; meta?: Record<string, string> }[] = [];
          if (s.mode === 'stage') {
            // what the owner set on the Stage, from the server's state: the helper's own name and reply language
            const me = await app.agents.get(s.agentId);
            if (me)
              items.push({
                text: 'Your name (the owner chose it); call yourself this',
                meta: { name: me.name },
              });
            if (s.language === 'taglish')
              items.push({ text: 'Reply in Taglish: a natural, casual mix of Filipino and English.' });
            else if (s.language)
              items.push({
                text: 'Reply in the language the owner chose',
                meta: { language: languageName(s.language, 'en') },
              });
          }
          const asking = req.chatId === s.chatId && (s.status === 'asking' || s.status === 'plan');
          if (!asking) return items.length ? { source: MODULE_ID, label: 'Team setup', items } : null;
          const qid = iv.current(s);
          if (s.mode === 'stage') {
            // the setup screen drives every step: the chat never asks, answers or plans for it
            items.push({
              text:
                'The owner sets up the team on the setup screen, which drives every step (the language, the name, ' +
                'the questions, the plan). Do not ask setup questions, save answers or propose a plan in this chat. ' +
                (s.paused
                  ? 'They left it for now; to go on, they open Settings and tap “Continue my team setup”.'
                  : 'It is open on their screen.'),
              meta: { language: s.lang },
            });
          } else {
            items.push({
              text:
                s.status === 'plan'
                  ? 'All questions are answered; the plan is waiting for the owner.'
                  : `Open question ${s.step + 1} of ${iv.QUESTIONS.length} (${qid}): ${t('en', `q.${qid}.text`)}`,
              meta: { language: s.lang },
            });
            if (qid) items.push({ text: `Quick answer ids: ${iv.OPTIONS[qid].join(', ')}` });
          }
          for (const q of iv.QUESTIONS) {
            const a = s.answers[q];
            if (a) items.push({ text: `${q}: ${a.text}`, meta: { choice: a.choice ?? 'own words' } });
          }
          return { source: MODULE_ID, label: 'Team setup', items };
        },
      });

      const onMessage = (m: MessageDTO) => {
        const s = load();
        // a Stage interview is answered on the setup screen only, never by words in the chat
        if (s?.status !== 'asking' || s.mode === 'stage' || m.chatId !== s.chatId) return;
        // only the owner's own words count; a member or guest in the chat never answers for them
        if (m.authorKind !== 'user' || m.authorId !== s.ownerId || !m.body.trim()) return;
        save({ ...s, pending: { text: iv.plain(m.body, iv.CAP.answer), at: Date.now() } });
      };
      const onRunFinished = (r: RunDTO) =>
        serial(async () => {
          const s = load();
          if (s?.status !== 'asking' || s.mode === 'stage' || !s.pending) return;
          if (app.chats.runChat(r.id) !== s.chatId) return;
          const qid = iv.current(s);
          if (!qid) return save({ ...s, pending: null });
          // the model did not save it: read the owner's words with the built-in rules. Only words that name a quick
          // answer count; anything else (a greeting, "what is this?") was not an answer, and the card stays open
          const a = iv.readAnswer(qid, s.pending.text, [labels(qid, s.lang), labels(qid, 'en')]);
          if (a.choice === null) {
            save({ ...s, pending: null });
            return;
          }
          await advance(s, qid, a);
        });
      app.bus.subscribe((ev) => {
        if (ev.live) return;
        try {
          // an OK card settles once its thing is really done (the email checklist finished, the app connected)
          if (ev.type === 'message.created' || ev.type === 'message.updated')
            try {
              for (const ref of iv.okRefsDone(ev.data as MessageDTO))
                app.cards.settleRef(ref, { state: 'done' });
            } catch (e) {
              app.log.warn('team setup: an OK card did not settle', { error: String(e) });
            }
          if (ev.type === 'message.created') onMessage(ev.data as MessageDTO);
          else if (ev.type === 'run.finished')
            void onRunFinished(ev.data as RunDTO).catch((e) =>
              app.log.warn('team setup: reading an answer failed', { error: String(e) }),
            );
        } catch (e) {
          app.log.warn('team setup: event handling failed', { error: String(e) });
        }
      });
    },
  });
}

export default createOrchestratorModule();
