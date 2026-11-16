/**
 * The team builder's interview as a small, pure state machine. The server owns the order of the questions (at most
 * five, one at a time); a model may only phrase a question or read a free-text answer, and when what it gives cannot
 * be used, `readAnswer` and the built-in wording decide instead. Nothing here does I/O.
 */
import { z } from 'zod';

export const QUESTIONS = ['help', 'people', 'chat', 'email', 'askFirst'] as const;
export type Qid = (typeof QUESTIONS)[number];

/** the quick answers of each question, in the order they are shown */
export const OPTIONS: Record<Qid, readonly string[]> = {
  help: ['shop', 'home', 'work', 'study'],
  people: ['solo', 'family', 'team'],
  chat: ['none', 'telegram', 'whatsapp', 'discord', 'slack'],
  email: ['new', 'connect', 'skip'],
  askFirst: ['none', 'money', 'contact', 'files'],
};

/**
 * The questions that take several quick answers at once (the Stage's "what do you want help with": pick any number,
 * or tell it in your own words); every other question takes one.
 */
export const MULTI: ReadonlySet<Qid> = new Set<Qid>(['help']);

/** caps on everything a person or a model can put into the interview or a plan */
export const CAP = {
  answer: 300,
  phrasing: 240,
  name: 40,
  job: 160,
  instructions: 2000,
  agents: 5,
  /** a plan card's short reason ("Because: online shop") */
  why: 30,
} as const;

/** Plain text cut to at most `max` characters, at a word when one ends near the cut, with "…" when cut. */
export function clip(text: string, max: number): string {
  const p = plain(text, CAP.answer);
  const chars = Array.from(p);
  if (chars.length <= max) return p;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/u, '')}…`;
}

export interface Answer {
  /** a quick answer id of the question (on a MULTI question the first one picked), or null for words that matched none */
  choice: string | null;
  /** every quick answer picked, in the order the question shows them (a MULTI question; absent on the others) */
  choices?: string[];
  /** what is shown back: the quick answer's label(s), or the person's own words (plain text, capped) */
  text: string;
}

/** Every quick answer an answer holds: its `choices`, else its one `choice`. */
export const choicesOf = (a: Answer | undefined): string[] =>
  !a ? [] : a.choices?.length ? a.choices : a.choice ? [a.choice] : [];

/**
 * An answer's quick answers made whole: on a MULTI question every known id once, in the question's own order (the
 * first is `choice`); on any other question just `choice`. Unknown ids, or several on a one-answer question, are
 * refused.
 */
export function withChoices(qid: Qid, a: Answer): Answer {
  const picked = a.choices ?? (a.choice !== null ? [a.choice] : []);
  for (const c of picked) if (!OPTIONS[qid].includes(c)) throw new Error('unknown quick answer');
  if (!MULTI.has(qid)) {
    if (picked.length > 1) throw new Error('this question takes one answer');
    return { choice: picked[0] ?? null, text: a.text };
  }
  const choices = OPTIONS[qid].filter((o) => picked.includes(o));
  return { choice: choices[0] ?? null, choices, text: a.text };
}

export interface PlanAgent {
  key: string;
  name: string;
  job: string;
  instructions: string;
  /** the helper's face, picked when the plan is made (an avatar seed): the plan shows it and the helper keeps it */
  face?: string;
}
/** the avatar salt that draws `face` whatever the agent's id (`=<seed>`, see avatarSeed in @pasabot/ui) */
export const faceSalt = (face: string): string => `=${face}`;
export const STEP_KINDS = [
  'email-new',
  'email-connect',
  'telegram',
  'whatsapp',
  'discord',
  'slack',
  'people',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export interface Plan {
  id: string;
  agents: PlanAgent[];
  steps: StepKind[];
  state: 'open' | 'approved' | 'changed' | 'skipped';
}

/**
 * The Stage (onboarding direction A, 2026-11-15): the same interview shown full screen, before the chat. Three intro
 * steps come before the questions (a hello, the language, the main helper's name); no card is posted in the chat
 * while it runs, and the chat gets one short summary at the end. Absent on an interview held in the chat (older ones).
 */
export type IntroStep = 'welcome' | 'language' | 'name';
export const INTRO_STEPS: readonly IntroStep[] = ['welcome', 'language', 'name'];

export interface Interview {
  v: 1;
  ownerId: string;
  agentId: string;
  chatId: string;
  /** the language the server words texts in (the owner's UI locale; Taglish reads Filipino) */
  lang: string;
  status: 'asking' | 'plan' | 'done' | 'skipped';
  /** 'stage': shown full screen (no cards in the chat); absent: the in-chat cards */
  mode?: 'stage';
  /** an intro step of the Stage that is open (the questions wait until it is null) */
  intro?: IntroStep | null;
  /** the language helpers reply in (a STAGE_LANGS code), chosen on the Stage; null until chosen */
  language?: string | null;
  /** "Skip for now" on the Stage: kept where it was, shown again only from Settings */
  paused?: boolean;
  /**
   * What the owner had tapped or typed on the open question but not sent when they tapped "Skip for now": shown
   * again (still not sent) when the Stage resumes on that question; any answer, Back or new round drops it
   */
  draft?: Draft | null;
  step: number;
  /** bumped on every (re)start: a tap on a card of an older round is refused */
  round: number;
  answers: Partial<Record<Qid, Answer>>;
  questionMessageId: string | null;
  planMessageId: string | null;
  plan: Plan | null;
  /** the owner's own words typed into the chat while a question was open, waiting for the model's turn to end */
  pending: { text: string; at: number } | null;
  /** the model's wording for the next question (from `orchestrator_answer`), used once */
  phrasing: string | null;
  /** `salt`: the helper's avatar salt (its plan face), so every screen draws the face the plan showed */
  created: { agentId: string; chatId: string; name: string; salt?: string }[];
  /**
   * W40 "A few things need your OK": the Stage's screen after the team is made and before the finish. Each item is
   * one thing (connect email, the chat app, an app, the helpers' own browser, this computer, how often they ask,
   * alerts); `yes` = the owner tapped Connect / Allow (the guided page opened), `later` = Later. Absent: no such step.
   */
  oks?: OkItem[] | null;
  /** the OK screen is open (the Stage resumes on it); false once finished (Later ones became cards in the chat) */
  oksOpen?: boolean;
}

export const OK_KINDS = ['email', 'chat', 'apps', 'browser', 'computer', 'ask', 'alerts'] as const;
export type OkKind = (typeof OK_KINDS)[number];
export interface OkItem {
  kind: OkKind;
  /** the chat app (telegram, ...) or the connector (google-calendar, ...) the item is about */
  app?: string;
  state: 'open' | 'yes' | 'later';
  /** when it was decided (Back undoes the newest one) */
  at?: number;
}
/** apps from the connectors catalogue that fit each help area (only these, at most two in all) */
export const AREA_APPS: Record<string, readonly string[]> = {
  work: ['google-calendar', 'notion'],
  study: ['google-calendar', 'notion'],
  home: ['google-calendar'],
};
export const APP_NAMES: Record<string, string> = {
  'google-calendar': 'Google Calendar',
  notion: 'Notion',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  slack: 'Slack',
};
/**
 * Where each OK opens: the existing guided pages, where the owner does it (and types any secret) themselves. A new
 * mailbox is the main helper's own checklist card in its chat (`chatId`); an existing one is the guided connect.
 * This computer opens the computer module's own setup card for the main helper (`agentId`): "Let <name> use this
 * computer?", the owner's password, then the macOS steps. A tap only opens it; nothing is granted or approved here.
 */
export function okHref(i: Pick<OkItem, 'kind' | 'app'>, chatId?: string, agentId?: string): string {
  switch (i.kind) {
    case 'email':
      return i.app === 'new' && chatId ? `#/chats/${chatId}` : STEP_HREF['email-connect'];
    case 'chat':
      return STEP_HREF.telegram;
    case 'apps':
      return '#/connectors';
    case 'browser':
      return '#/browser';
    case 'computer':
      return agentId && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(agentId)
        ? `#/computer?agent=${agentId}`
        : '#/computer';
    case 'ask':
      return '#/safety';
    case 'alerts':
      return '#/settings/people/push';
  }
}
/**
 * The OK items the owner's answers and plan call for, in a calm order: what they asked to connect first, then what
 * helpers may do, then alerts. `computer`: this computer can be used by a helper (the module is here and the
 * platform supports it). Nothing here grants anything: each item only opens its guided page on the owner's tap.
 */
export function okItems(s: Pick<Interview, 'answers' | 'plan'>, o: { computer: boolean }): OkItem[] {
  const out: OkItem[] = [];
  const email = s.answers.email?.choice;
  if ((email === 'new' || email === 'connect') && s.plan?.agents.some((a) => a.key === 'mail'))
    out.push({ kind: 'email', app: email, state: 'open' });
  const chat = s.answers.chat?.choice;
  if (chat === 'telegram' || chat === 'whatsapp' || chat === 'discord' || chat === 'slack')
    out.push({ kind: 'chat', app: chat, state: 'open' });
  const apps = new Set<string>();
  for (const area of choicesOf(s.answers.help)) for (const a of AREA_APPS[area] ?? []) apps.add(a);
  for (const app of [...apps].slice(0, 2)) out.push({ kind: 'apps', app, state: 'open' });
  out.push({ kind: 'browser', state: 'open' });
  if (o.computer) out.push({ kind: 'computer', state: 'open' });
  out.push({ kind: 'ask', state: 'open' });
  out.push({ kind: 'alerts', state: 'open' });
  return out;
}
/**
 * Does this OK block a helper? Only the mailbox: the plan has a mail helper that cannot work without it. Everything
 * else (a chat app, a calendar, the browser, the computer, how often helpers ask, alerts) is an optional idea.
 */
export function okBlocks(i: Pick<OkItem, 'kind'>): boolean {
  return i.kind === 'email';
}
/**
 * The OK cards (by `ref`) whose thing is really done, read from a chat message another module posted or updated:
 * the main helper's email checklist reached its last step (`inbox.guide`, step `done`: a mailbox is connected), or
 * an app's "is connected" card arrived (`connectors.connected`, a system message). Only those two block kinds and
 * their ids count, never a message's words; a done one only settles a card (it grants nothing).
 */
export function okRefsDone(m: {
  authorKind?: string;
  blocks?: readonly { kind: string; data?: unknown }[];
}): string[] {
  const out: string[] = [];
  for (const b of m.blocks ?? []) {
    const d = (b.data ?? {}) as { step?: unknown; slug?: unknown };
    if (b.kind === 'inbox.guide' && d.step === 'done')
      out.push('orchestrator.ok:email:new', 'orchestrator.ok:email:connect');
    else if (
      b.kind === 'connectors.connected' &&
      m.authorKind === 'system' &&
      typeof d.slug === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,39}$/.test(d.slug)
    )
      out.push(`orchestrator.ok:apps:${d.slug}`);
  }
  return [...new Set(out)];
}
/** one OK decided; Back (`undo`) reopens the newest decided one */
export function decideOk(
  s: Interview,
  kind: OkKind,
  app: string | undefined,
  choice: 'yes' | 'later',
): Interview {
  const items = (s.oks ?? []).map((i) =>
    i.kind === kind && (i.app ?? '') === (app ?? '') && i.state === 'open'
      ? { ...i, state: choice, at: Date.now() }
      : i,
  );
  return { ...s, oks: items };
}
export function undoOk(s: Interview): Interview {
  const items = s.oks ?? [];
  let newest = -1;
  items.forEach((i, n) => {
    if (i.state !== 'open' && (newest < 0 || (i.at ?? 0) >= (items[newest]!.at ?? 0))) newest = n;
  });
  if (newest < 0) return s;
  return {
    ...s,
    oks: items.map((i, n) =>
      n === newest ? { kind: i.kind, ...(i.app ? { app: i.app } : {}), state: 'open' } : i,
    ),
  };
}

/** Control and format characters (bidi overrides, zero-width) out, whitespace folded, capped. */
export function plain(text: string, max: number): string {
  return [...text]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 32 || (c >= 127 && c < 160)) return ' ';
      if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
        return '';
      if (c === 0x2028 || c === 0x2029 || c === 0xfeff) return ' ';
      return ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function newInterview(o: {
  ownerId: string;
  agentId: string;
  chatId: string;
  lang: string;
  round?: number;
}): Interview {
  return {
    v: 1,
    ownerId: o.ownerId,
    agentId: o.agentId,
    chatId: o.chatId,
    lang: o.lang,
    status: 'asking',
    step: 0,
    round: o.round ?? 1,
    answers: {},
    questionMessageId: null,
    planMessageId: null,
    plan: null,
    pending: null,
    phrasing: null,
    created: [],
  };
}

export const current = (s: Interview): Qid | null =>
  s.status === 'asking' && !s.intro ? (QUESTIONS[s.step] ?? null) : null;

/** A new interview shown on the Stage: it opens on the hello, before the language and the name. */
export function newStageInterview(o: Parameters<typeof newInterview>[0]): Interview {
  return { ...newInterview(o), mode: 'stage', intro: 'welcome', language: null, paused: false };
}

/**
 * The languages the Stage offers: English, Filipino and Taglish first, then every other language the app ships.
 * Taglish is not a UI locale: the app reads Filipino, and helpers are told to mix Filipino and English.
 */
export function stageLanguages(shipped: readonly string[]): string[] {
  return ['en', 'fil', 'taglish', ...shipped.filter((l) => l !== 'en' && l !== 'fil')];
}
/** the UI locale of a Stage language */
export const uiLocale = (code: string): string => (code === 'taglish' ? 'fil' : code);

/** The Stage's step number (1-based) out of `stageTotal`: the language, the name, each question, the plan. */
export const STAGE_TOTAL = 2 + QUESTIONS.length + 1;
export function stageStep(s: Interview): number {
  if (s.intro === 'welcome') return 0;
  if (s.intro === 'language') return 1;
  if (s.intro === 'name') return 2;
  if (s.status === 'asking') return 3 + s.step;
  return STAGE_TOTAL;
}

/**
 * Back, one step at a time: the plan goes back to the last question (the plan is dropped), a question to the one
 * before it (its answer stays, shown as picked), the first question to the name, the name to the language, the
 * language to the hello. A finished team and the hello stay where they are.
 */
export function back(s: Interview): Interview {
  if (s.mode !== 'stage' || s.status === 'done' || s.status === 'skipped') return s;
  if (s.draft) return back({ ...s, draft: null });
  if (s.status === 'plan')
    return { ...s, status: 'asking', step: QUESTIONS.length - 1, intro: null, plan: null, pending: null };
  if (s.intro === 'name') return { ...s, intro: 'language' };
  if (s.intro === 'language') return { ...s, intro: 'welcome' };
  if (s.intro === 'welcome') return s;
  if (s.step > 0) return { ...s, step: s.step - 1, pending: null };
  return { ...s, intro: 'name', pending: null };
}

/** Name ideas offered on the Stage (none of them a plan role's name, so a helper never shares the main one's name). */
export const NAME_IDEAS = ['Tala', 'Mayumi', 'Diwa', 'Hiraya', 'Lualhati'] as const;
/** Names the main helper may not take: the product, the roles people read in a chat, and every plan role's name. */
const RESERVED = ['pasabot', 'system', 'owner', 'admin', 'you', 'me', 'everyone', 'guest', 'member'];
export type NameCheck = { ok: true; name: string } | { ok: false; code: 'empty' | 'long' | 'bad' | 'taken' };
/**
 * The main helper's new name, as typed: trimmed; refused when empty, longer than CAP.name, carrying a control or
 * format character (bidi overrides, zero-width), or the same (ignoring case) as a reserved name, a plan role's name
 * or another helper's name in `taken`.
 */
export function checkName(raw: string, taken: readonly string[]): NameCheck {
  const name = raw.normalize('NFC').trim();
  if (!name) return { ok: false, code: 'empty' };
  if ([...name].length > CAP.name) return { ok: false, code: 'long' };
  const control = [...name].some((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      c < 32 ||
      (c >= 127 && c < 160) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0xfeff
    );
  });
  if (control || /[<>{}`]/.test(name)) return { ok: false, code: 'bad' };
  const f = fold(name);
  const roles = Object.values(ROLES).map(fold);
  if (RESERVED.includes(f) || roles.includes(f) || taken.some((t) => fold(t) === f))
    return { ok: false, code: 'taken' };
  return { ok: true, name: name.replace(/\s+/g, ' ') };
}

/** Record the answer to the open question and move on; at the end the interview waits for its plan. */
export function answer(s: Interview, qid: Qid, a: Answer): Interview {
  if (current(s) !== qid) throw new Error('that question is not open');
  const whole = withChoices(qid, a);
  const answers = { ...s.answers, [qid]: { ...whole, text: plain(a.text, CAP.answer) } };
  const step = s.step + 1;
  return {
    ...s,
    answers,
    step,
    status: step >= QUESTIONS.length ? 'plan' : 'asking',
    pending: null,
    draft: null,
  };
}

/** an unsent answer on the open question, kept over "Skip for now" */
export interface Draft {
  round: number;
  qid: Qid;
  choices: string[];
  text: string;
}

/**
 * The unsent answer to keep when the owner skips: only for the question that is open in this round, only known quick
 * answers (one, unless the question takes several), the words plain and capped; null when nothing is left to keep.
 */
export function keepDraft(
  s: Interview,
  d: { round: number; qid: string; choices?: readonly string[]; text?: string } | undefined,
): Draft | null {
  const qid = current(s);
  if (!d || !qid || s.status !== 'asking' || d.round !== s.round || d.qid !== qid) return null;
  const choices = [...new Set((d.choices ?? []).filter((c) => OPTIONS[qid].includes(c)))];
  const picked = MULTI.has(qid) ? choices : choices.slice(0, 1);
  const text = plain(d.text ?? '', CAP.answer);
  return picked.length || text ? { round: s.round, qid, choices: picked, text } : null;
}

/** the kept draft for the question the Stage shows now, else null */
export const draftFor = (s: Interview): Draft | null =>
  s.draft && s.status === 'asking' && s.draft.round === s.round && s.draft.qid === current(s)
    ? s.draft
    : null;

/** Words that name a quick answer, in English and Filipino (the other languages match the labels themselves). */
const WORDS: Record<Qid, Record<string, RegExp>> = {
  help: {
    shop: /\b(shop|store|sell|selling|orders?|business|customers?|tindahan|negosyo|benta|tinda|paninda)\b/i,
    home: /\b(home|family|kids|house|meals?|chores|bahay|pamilya|anak|luto)\b/i,
    work: /\b(work|job|office|clients?|meetings?|trabaho|opisina|kliyente)\b/i,
    study: /\b(study|school|class|homework|exams?|learn|aral|eskwela|paaralan|takdang)\b/i,
  },
  people: {
    solo: /\b(just me|only me|myself|me only|alone|ako lang|ako lamang|sarili ko)\b/i,
    family: /\b(family|wife|husband|kids|pamilya|asawa|anak)\b/i,
    team: /\b(team|staff|co-?workers?|employees?|crew|kasama|empleyado|tauhan)\b/i,
  },
  chat: {
    telegram: /telegram/i,
    whatsapp: /whats\s*app/i,
    discord: /discord/i,
    slack: /slack/i,
    none: /\b(no|none|nope|not now|later|skip|wala|hindi|huwag|mamaya)\b/i,
  },
  email: {
    connect: /\b(connect|existing|my own|my email|i have|ikonekta|mayroon|meron|sarili kong)\b/i,
    new: /\b(new|make one|create|bago|gumawa)\b/i,
    skip: /\b(no|none|skip|not now|later|wala|hindi|huwag|mamaya)\b/i,
  },
  askFirst: {
    money: /\b(money|pay|paying|spend|spending|buy|buying|purchases?|pera|bayad|gastos|bili)\b/i,
    contact: /\b(message|messages|send|sending|email|contact|post|mensahe|padala|magpadala)\b/i,
    files: /\b(files?|delete|deleting|documents?|bura|burahin|dokumento)\b/i,
    none: /\b(no|none|nothing|that'?s all|that is all|ok|okay|wala|wala na|ayos na|hindi)\b/i,
  },
};

const fold = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();

/**
 * The deterministic reading of a person's own words: a quick answer whose label (in their language or English) they
 * typed, else one whose words appear, else no choice at all (the words themselves are kept).
 */
export function readAnswer(qid: Qid, text: string, labels: Record<string, string>[]): Answer {
  const said = plain(text, CAP.answer);
  const f = fold(said);
  for (const set of labels)
    for (const id of OPTIONS[qid])
      if (set[id] && fold(set[id]) === f) return withChoices(qid, { choice: id, text: said });
  // a MULTI question keeps every quick answer the words name ("my shop and my kids' homework": shop + study)
  if (MULTI.has(qid)) {
    const hits = Object.entries(WORDS[qid])
      .filter(([, re]) => re.test(said))
      .map(([id]) => id);
    return withChoices(qid, { choice: null, choices: hits, text: said });
  }
  for (const [id, re] of Object.entries(WORDS[qid])) if (re.test(said)) return { choice: id, text: said };
  return { choice: null, text: said };
}

/** what a model may hand back through `orchestrator_answer` (anything else is ignored and the fallback decides) */
export const modelAnswerSchema = z.object({
  choice: z.string().max(40).nullish(),
  answer: z.string().min(1).max(CAP.answer),
  next_question: z.string().max(CAP.phrasing).nullish(),
});

/** a model's wording of the next question: one short line of plain text, else null (the built-in wording is used) */
export function usablePhrasing(text: string | null | undefined): string | null {
  if (!text) return null;
  const p = plain(text, CAP.phrasing);
  if (p.length < 4 || /https?:\/\//i.test(p) || /[{}<>]/.test(p)) return null;
  return p;
}

/**
 * A name or job from a model's plan as the card shows it: plain text, capped, and refused (null) when it carries a
 * link or an email address (injected wording that steers a helper somewhere). The card shows exactly this text, and
 * the helper's instructions are built from it alone, so the owner approves what they see.
 */
export function usablePlanText(text: string, max: number): string | null {
  const p = plain(text, max);
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(p) || /\bwww\./i.test(p) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(p))
    return null;
  return p;
}

/**
 * A plan as a model may propose it through `orchestrator_show_plan`: validated, capped, plain text only. A model
 * names helpers and their one-line jobs; it never writes their instructions (the server builds them from the job the
 * card shows, so nothing the owner did not see is approved).
 */
export const proposedPlanSchema = z.object({
  agents: z
    .array(
      z.object({
        name: z.string().min(1).max(CAP.name),
        job: z.string().min(1).max(CAP.job),
      }),
    )
    .min(1)
    .max(CAP.agents),
  steps: z.array(z.enum(STEP_KINDS)).max(STEP_KINDS.length).optional(),
});
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;

/** One role the deterministic plan can add: its fixed name and its locale keys (`plan.roles.<key>.*`). */
export const ROLES = {
  shop: 'Ligaya',
  money: 'Dalisay',
  home: 'Sinag',
  work: 'Amihan',
  study: 'Tanglaw',
  custom: 'Bituin',
  mail: 'Liham',
} as const;
export type RoleKey = keyof typeof ROLES;

/** the help answer each help role comes from (the money helper comes with the shop helper) */
export const HELP_OF: Partial<Record<RoleKey, string>> = {
  shop: 'shop',
  money: 'shop',
  home: 'home',
  work: 'work',
  study: 'study',
};

/** the helper each help area brings first (the money helper is the shop area's extra, not an area of its own) */
const AREA_ROLE: Record<string, RoleKey> = { shop: 'shop', home: 'home', work: 'work', study: 'study' };

/**
 * Which roles and setup steps the answers call for: at most CAP.agents roles, duplicates removed. When an email is
 * made or connected, the mail helper always keeps its seat (the help roles get the others), so the email setup step
 * never comes without the helper it is for; within the help roles every area picked keeps its own helper before an
 * extra (the shop area's money helper) takes a seat.
 */
export function planFromAnswers(a: Interview['answers']): { roles: RoleKey[]; steps: StepKind[] } {
  const wanted: RoleKey[] = [];
  // every area picked brings its helpers (several may be picked); none picked: one helper for the person's own words
  for (const h of choicesOf(a.help)) {
    if (h === 'shop') wanted.push('shop', 'money');
    else if (AREA_ROLE[h]) wanted.push(AREA_ROLE[h]);
  }
  if (!wanted.length) wanted.push('custom');
  const help = [...new Set(wanted)];
  const email = a.email?.choice;
  const mail = email === 'new' || email === 'connect';
  const seats = CAP.agents - (mail ? 1 : 0);
  const areas = new Set<RoleKey>([...Object.values(AREA_ROLE), 'custom']);
  let extras = Math.max(0, seats - help.filter((r) => areas.has(r)).length);
  const roles = help.filter((r) => areas.has(r) || extras-- > 0).slice(0, seats);
  if (mail) roles.push('mail');
  const steps: StepKind[] = [];
  if (roles.includes('mail') && email === 'new') steps.push('email-new');
  if (roles.includes('mail') && email === 'connect') steps.push('email-connect');
  const chat = a.chat?.choice;
  if (chat === 'telegram' || chat === 'whatsapp' || chat === 'discord' || chat === 'slack') steps.push(chat);
  const people = a.people?.choice;
  if (people === 'family' || people === 'team') steps.push('people');
  return { roles, steps };
}

/** Where each setup step opens: the existing guided pages, where the person types any secret themselves. */
export const STEP_HREF: Record<StepKind, string> = {
  // the guided email setup (the main helper's checklist card is in its chat too)
  'email-new': '#/inbox/connect',
  'email-connect': '#/inbox/connect',
  telegram: '#/settings/people/channels',
  whatsapp: '#/settings/people/channels',
  discord: '#/settings/people/channels',
  slack: '#/settings/people/channels',
  people: '#/people',
};
