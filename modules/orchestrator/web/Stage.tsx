/**
 * The Stage (onboarding direction A, approved 2026-11-15): the team builder's interview shown full screen, one calm
 * question at a time, with the main helper large in the middle. Hello -> language -> its name -> the five questions ->
 * the plan (helpers arrive one by one; Approve / Change) -> done (hand-over to the app, the main helper pinned on top).
 *
 * The server's state machine (`GET /api/m/orchestrator/stage`) is the only truth: every step is one owner-only call
 * that answers with the next view, so a reload, a second tab or "Skip for now" resumes at the same step. Question and
 * quick-answer texts are drawn here from the module's locale files by id (a language pick shows at once); names, jobs
 * and answers are the server's plain text, rendered as text. A call that is slow shows a calm wait, then a plain retry:
 * nothing here waits on the brain.
 */
import { SET_LANGUAGE_EVENT } from '@pasabot/i18n';
import { AgentAvatar, HelperCard, Icon, LogoMark } from '@pasabot/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import './stage.css';

type T = (k: string, o?: Record<string, unknown>) => string;

interface Answer {
  choice: string | null;
  /** every quick answer picked (a question that takes several) */
  choices?: string[];
  text: string;
  /** the text is the owner's own words, not just the label(s) of what they tapped */
  own?: boolean;
}
export interface StageView {
  round: number;
  status: 'asking' | 'plan' | 'done' | 'skipped';
  stage: 'open' | 'paused' | 'done' | null;
  intro: 'welcome' | 'language' | 'name' | null;
  step: number;
  total: number;
  agentId: string;
  chatId: string;
  name: string;
  defaultName: string;
  nameIdeas: string[];
  language: string | null;
  languages: { code: string; ui: string; name: string; sample: string }[];
  qid: string | null;
  /** the open question takes several quick answers */
  multi?: boolean;
  questions: string[];
  options: string[];
  answers: Record<string, Answer | undefined>;
  /** what was tapped or typed on the open question but not sent before "Skip for now": shown again, still unsent */
  draft?: { choices: string[]; text: string } | null;
  plan: {
    planId: string;
    state: string;
    /** `why`: a short reason for this helper, plain text from the server */
    /** `face`: the avatar seed picked with the plan, which the helper keeps once made */
    agents: { key: string; name: string; job: string; why: string | null; face?: string | null }[];
    steps: { kind: string; label: string }[];
  } | null;
  /** `salt`: the helper's avatar salt (its plan face) */
  team: { agentId: string; chatId: string; name: string; salt?: string }[];
  /** W40: "A few things need your OK" (after the team is made, before the finish); null when there is none */
  oks?: { open: boolean; items: OkView[] } | null;
}
export interface OkView {
  kind: 'email' | 'chat' | 'apps' | 'browser' | 'computer' | 'ask' | 'alerts';
  app: string | null;
  appName: string | null;
  state: 'open' | 'yes' | 'later';
  href: string;
}

const API = '/api/m/orchestrator';
/** a call that has not answered after this long shows the calm "one moment" line */
const WAIT_MS = 700;
/** ... and after this long gives up with a plain retry (nothing on the Stage needs the brain) */
export const TIMEOUT_MS = 15000;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_MAX = 40;

class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function call<R>(path: string, body?: unknown, signal?: AbortSignal): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new CallError(r.status, b.code ?? b.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as R;
}

const go = (hash: string) => {
  window.location.hash = hash;
};
/** the seed salt the server gives a renamed main helper: none for the default name (its original look) */
const saltFor = (name: string, def: string) => {
  const n = name.trim().replace(/\s+/g, ' ');
  return !n || n === def ? '' : n;
};
const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Stage({ t }: { t: T }) {
  const [view, setView] = useState<StageView | null>(null);
  const [missing, setMissing] = useState(false);
  // busy: a call is out (buttons wait); wait: it is slow (the calm line shows); slow / failed: a plain retry
  const [phase, setPhase] = useState<'idle' | 'busy' | 'wait' | 'slow' | 'failed'>('idle');
  const [nameErr, setNameErr] = useState<string | null>(null);
  const last = useRef<(() => Promise<void>) | null>(null);
  const busy = phase === 'busy' || phase === 'wait';
  // what the open question holds but has not sent yet: "Skip for now" keeps it for the resume
  const draft = useRef<{ round: number; qid: string; choices: string[]; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await call<StageView>('/stage'));
    } catch (e) {
      if (e instanceof CallError && (e.status === 404 || e.status === 403)) setMissing(true);
      else setPhase('failed');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // a Stage opened on another device or after a reload reads in the language picked there
  useEffect(() => {
    if (!view?.language) return;
    const ui = view.languages.find((l) => l.code === view.language)?.ui;
    if (ui && document.documentElement.lang !== ui)
      window.dispatchEvent(new CustomEvent(SET_LANGUAGE_EVENT, { detail: ui }));
  }, [view?.language, view?.languages]);
  useEffect(() => {
    if (missing) go('#/');
  }, [missing]);

  /** one step: the server answers with the next view; slow -> a calm wait; too slow or failed -> a plain retry */
  const act = useCallback(
    async (path: string, body: unknown, after?: (v: StageView) => void) => {
      const run = async () => {
        const ctl = new AbortController();
        const waitT = setTimeout(() => setPhase('wait'), WAIT_MS);
        const stopT = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        setPhase('busy');
        setNameErr(null);
        try {
          const v = await call<StageView>(path, body, ctl.signal);
          setView(v);
          setPhase('idle');
          after?.(v);
        } catch (e) {
          if (e instanceof CallError && e.status === 409) {
            // that step was already taken (a double tap, a second tab): show where things are now
            setPhase('idle');
            await load();
          } else if (e instanceof CallError && e.code.startsWith('name_')) {
            setPhase('idle');
            setNameErr(t(`stage.name.errors.${e.code.slice(5)}`, { max: NAME_MAX }));
          } else setPhase(ctl.signal.aborted ? 'slow' : 'failed');
        } finally {
          clearTimeout(waitT);
          clearTimeout(stopT);
        }
      };
      last.current = run;
      await run();
    },
    [load, t],
  );

  const skip = async () => {
    try {
      const d = draft.current;
      const keep = d && view?.qid === d.qid && view.round === d.round && view.status === 'asking' ? d : null;
      const r = await call<{ chatId?: string }>('/skip', keep ? { draft: keep } : {});
      go(r.chatId && ID.test(r.chatId) ? `#/chats/${r.chatId}` : '#/');
    } catch {
      go('#/');
    }
  };
  const backTo = (v: StageView) => void act('/stage/back', { step: v.step });

  // move focus to the new step's heading, so a screen reader reads the new question
  const head = useRef<HTMLHeadingElement>(null);
  const where = view ? `${view.status}:${view.intro}:${view.qid}:${view.round}` : '';
  const first = useRef(true);
  useEffect(() => {
    if (!where) return;
    if (first.current) {
      first.current = false;
      return;
    }
    head.current?.focus();
  }, [where]);

  if (!view)
    return (
      <div className="stg" data-testid="stage" data-step="loading">
        <StageTop t={t} />
        <div className="stg-center" aria-busy={phase !== 'failed'}>
          {phase === 'failed' ? (
            <Retry t={t} text={t('web.failed')} onRetry={() => void load()} />
          ) : (
            <p className="stg-sub">{t('stage.wait')}</p>
          )}
        </div>
      </div>
    );

  const step =
    view.intro ??
    (view.status === 'asking'
      ? 'question'
      : view.status === 'plan'
        ? 'plan'
        : view.oks?.open
          ? 'oks'
          : 'done');
  // W40: Connect / Allow opens the guided page; the Stage resumes on this screen when the owner comes back
  const okTap = (i: OkView, choice: 'yes' | 'later') =>
    void act('/stage/ok', { kind: i.kind, ...(i.app ? { app: i.app } : {}), choice }, (v) => {
      const to = (v as StageView & { go?: string }).go;
      if (choice === 'yes' && to?.startsWith('#/')) go(to);
    });
  const okFinish = () => void act('/stage/ok/finish', {});
  const status = (
    <StatusLine
      t={t}
      phase={phase}
      onRetry={() => {
        if (last.current) void last.current();
      }}
    />
  );
  const common = { t, view, busy, head, status, back: () => backTo(view) };
  return (
    <div className="stg" data-testid="stage" data-step={step} data-qid={view.qid ?? undefined}>
      <StageTop
        t={t}
        step={step === 'done' ? undefined : view.step}
        total={view.total}
        onSkip={step === 'done' ? undefined : step === 'oks' ? okFinish : () => void skip()}
        plan={step === 'plan'}
      />
      {step === 'welcome' && <Welcome {...common} onNext={() => void act('/stage/welcome', {})} />}
      {step === 'language' && (
        <Language {...common} onNext={(code) => void act('/stage/language', { code })} />
      )}
      {step === 'name' && (
        <NameStep
          {...common}
          error={nameErr}
          clearError={() => setNameErr(null)}
          onNext={(name) => void act('/stage/name', { name })}
        />
      )}
      {step === 'question' && view.qid && (
        <Question
          key={`${view.qid}:${view.round}`}
          {...common}
          onDraft={(d) => {
            draft.current = { round: view.round, qid: view.qid!, ...d };
          }}
          onNext={(a) => void act('/answer', { round: view.round, qid: view.qid, ...a })}
        />
      )}
      {step === 'plan' && view.plan && (
        <Plan
          {...common}
          onApprove={() => void act('/approve', { planId: view.plan!.planId })}
          onChange={() => void act('/change', { planId: view.plan!.planId })}
        />
      )}
      {step === 'oks' && view.oks && (
        <Oks {...common} back={() => void act('/stage/ok/back', {})} onTap={okTap} onFinish={okFinish} />
      )}
      {step === 'done' && <Done {...common} />}
    </div>
  );
}

interface StepProps {
  t: T;
  view: StageView;
  busy: boolean;
  head: React.RefObject<HTMLHeadingElement | null>;
  status: React.ReactNode;
  back(): void;
}

function StageTop({
  t,
  step,
  total,
  onSkip,
  plan,
}: {
  t: T;
  step?: number;
  total?: number;
  onSkip?: () => void;
  plan?: boolean;
}) {
  const shown = !!step && !!total;
  return (
    <header className="stg-top">
      <span className="stg-brand">
        <LogoMark size={34} />
        <span>{t('stage.brand')}</span>
      </span>
      <div className="stg-prog">
        {shown && (
          <>
            <div
              className="stg-segs"
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={total}
              aria-valuenow={step}
              aria-label={t('stage.progress', { n: step, total })}
              data-testid="stage-progress"
            >
              {Array.from({ length: total }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
                <i key={i} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : undefined} />
              ))}
            </div>
            <small aria-hidden="true">
              <span className="stg-long">
                {t('stage.progress', { n: step, total })}
                {plan ? ` · ${t('stage.last')}` : ''}
              </span>
              <span className="stg-short">{t('stage.progressShort', { n: step, total })}</span>
            </small>
          </>
        )}
      </div>
      <div className="stg-right">
        {onSkip && (
          <button type="button" className="stg-skip" onClick={onSkip} data-testid="stage-skip">
            {t('stage.skip')}
          </button>
        )}
      </div>
    </header>
  );
}

function StatusLine({ t, phase, onRetry }: { t: T; phase: string; onRetry(): void }) {
  return (
    <div className="stg-status" aria-live="polite" data-testid="stage-status" data-phase={phase}>
      {phase === 'wait' && <span className="stg-wait">{t('stage.wait')}</span>}
      {(phase === 'slow' || phase === 'failed') && (
        <Retry t={t} text={phase === 'slow' ? t('stage.slow') : t('web.failed')} onRetry={onRetry} />
      )}
    </div>
  );
}

function Retry({ t, text, onRetry }: { t: T; text: string; onRetry(): void }) {
  return (
    <span className="stg-retry" role="alert">
      <span>{text}</span>
      <button type="button" className="stg-btn sec" onClick={onRetry} data-testid="stage-retry">
        <Icon name="refresh" size={18} />
        <span>{t('stage.retry')}</span>
      </button>
    </span>
  );
}

function Foot({
  t,
  busy,
  back,
  next,
  nextLabel,
  disabled,
  status,
  testid = 'stage-next',
}: {
  t: T;
  busy: boolean;
  back?: () => void;
  next(): void;
  nextLabel: string;
  disabled?: boolean;
  status: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="stg-foot">
      {back ? (
        <button
          type="button"
          className="stg-back"
          onClick={back}
          disabled={busy}
          aria-label={t('stage.back')}
          data-testid="stage-back"
        >
          <Icon name="back" size={18} />
          <span className="stg-back-l">{t('stage.back')}</span>
        </button>
      ) : (
        <span />
      )}
      {status}
      <button
        type="button"
        className="stg-btn pri"
        onClick={next}
        disabled={busy || disabled}
        data-testid={testid}
      >
        <span>{nextLabel}</span>
        <Icon name="chevron" size={20} />
      </button>
    </div>
  );
}

function Welcome({ t, view, busy, head, status, onNext }: StepProps & { onNext(): void }) {
  return (
    <section className="stg-center stg-welcome" aria-labelledby="stg-h">
      <div className="stg-hero">
        <span className="stg-glow" aria-hidden="true" />
        <AgentAvatar agentId={view.agentId} salt={saltFor(view.name, view.defaultName)} size={176} />
      </div>
      <p className="stg-tag">
        <span className="stg-dot" aria-hidden="true" />
        <span dir="auto">{t('stage.welcome.tag', { name: view.name })}</span>
      </p>
      <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
        {t('stage.welcome.title')}
      </h1>
      <p className="stg-sub">{t('stage.welcome.body')}</p>
      <div className="stg-cta">
        <button
          type="button"
          className="stg-btn pri big"
          onClick={onNext}
          disabled={busy}
          data-testid="stage-next"
        >
          <span>{t('stage.welcome.start')}</span>
          <Icon name="chevron" size={20} />
        </button>
        {status}
      </div>
      <ul className="stg-promises">
        <li>
          <Icon name="chats" size={18} />
          {t('stage.welcome.p1')}
        </li>
        <li>
          <Icon name="shield" size={18} />
          {t('stage.welcome.p2')}
        </li>
        <li>
          <Icon name="refresh" size={18} />
          {t('stage.welcome.p3')}
        </li>
      </ul>
    </section>
  );
}

const MAIN_LANGS = ['en', 'fil', 'taglish'];

function Language({ t, view, busy, head, status, back, onNext }: StepProps & { onNext(code: string): void }) {
  const [picked, setPicked] = useState<string | null>(view.language);
  const others = view.languages.filter((l) => !MAIN_LANGS.includes(l.code));
  const [more, setMore] = useState(!!picked && !MAIN_LANGS.includes(picked));
  const group = useId();
  const pick = (code: string) => {
    setPicked(code);
    // the owner's UI language follows the pick at once; the rest of the Stage reads in it
    const ui = view.languages.find((l) => l.code === code)?.ui;
    if (ui) window.dispatchEvent(new CustomEvent(SET_LANGUAGE_EVENT, { detail: ui }));
    // ... and the pick is saved on the server at once (Back keeps it; Continue saves it again and moves on)
    void call('/stage/language', { code, stay: true }).catch(() => {});
  };
  const card = (l: StageView['languages'][number]) => (
    <label
      key={l.code}
      className="stg-lang"
      data-on={picked === l.code || undefined}
      data-testid={`stage-lang-${l.code}`}
    >
      <input
        type="radio"
        className="bk-visually-hidden"
        name={group}
        value={l.code}
        checked={picked === l.code}
        disabled={busy}
        onChange={() => pick(l.code)}
      />
      <b lang={l.ui} dir="auto">
        {l.name}
      </b>
      <span className="stg-eg" lang={l.ui} dir="auto">
        {l.sample}
      </span>
      {picked === l.code && (
        <span className="stg-tick" aria-hidden="true">
          <Icon name="check" size={18} />
        </span>
      )}
    </label>
  );
  const otherPicked = others.find((l) => l.code === picked);
  return (
    <>
      <section className="stg-center" aria-labelledby="stg-h">
        <AgentAvatar agentId={view.agentId} salt={saltFor(view.name, view.defaultName)} size={104} />
        <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
          {t('stage.lang.title')}
        </h1>
        <p className="stg-sub">{t('stage.lang.body')}</p>
        <div className="stg-langs" role="radiogroup" aria-labelledby="stg-h" data-testid="stage-langs">
          {view.languages.filter((l) => MAIN_LANGS.includes(l.code)).map(card)}
          <button
            type="button"
            className="stg-lang stg-other"
            aria-expanded={more}
            aria-controls={`${group}-more`}
            data-on={otherPicked ? true : undefined}
            onClick={() => setMore((m) => !m)}
            data-testid="stage-lang-other"
          >
            <b>{otherPicked ? otherPicked.name : t('stage.lang.other')}</b>
            <span className="stg-more">
              {t('stage.lang.otherSub', {
                names: others
                  .slice(0, 3)
                  .map((l) => l.name)
                  .join(', '),
              })}
            </span>
            <span className="stg-seeall">
              <Icon name="globe" size={18} />
              {t('stage.lang.seeAll')}
            </span>
            {otherPicked && (
              <span className="stg-tick" aria-hidden="true">
                <Icon name="check" size={18} />
              </span>
            )}
          </button>
        </div>
        {more && (
          <div
            className="stg-langlist"
            id={`${group}-more`}
            role="radiogroup"
            aria-label={t('stage.lang.listTitle')}
            data-testid="stage-lang-list"
          >
            {others.map((l) => (
              <label
                key={l.code}
                className="stg-chip"
                data-on={picked === l.code || undefined}
                data-testid={`stage-lang-${l.code}`}
              >
                <input
                  type="radio"
                  className="bk-visually-hidden"
                  name={group}
                  value={l.code}
                  checked={picked === l.code}
                  disabled={busy}
                  onChange={() => pick(l.code)}
                />
                {picked === l.code && <Icon name="check" size={18} />}
                <span lang={l.ui} dir="auto">
                  {l.name}
                </span>
              </label>
            ))}
          </div>
        )}
      </section>
      <Foot
        t={t}
        busy={busy}
        back={back}
        next={() => picked && onNext(picked)}
        nextLabel={t('stage.next')}
        disabled={!picked}
        status={status}
      />
    </>
  );
}

function NameStep({
  t,
  view,
  busy,
  head,
  status,
  back,
  error,
  clearError,
  onNext,
}: StepProps & { error: string | null; clearError(): void; onNext(name: string): void }) {
  const [name, setName] = useState(view.name);
  const field = useId();
  const n = name.trim();
  const local = !n
    ? t('stage.name.errors.empty')
    : [...n].length > NAME_MAX
      ? t('stage.name.errors.long', { max: NAME_MAX })
      : null;
  const [tried, setTried] = useState(false);
  const shownErr = error ?? (tried ? local : null);
  const submit = () => {
    setTried(true);
    if (local) return;
    onNext(n);
  };
  const salt = saltFor(name, view.defaultName);
  const ideas = view.nameIdeas.includes(view.defaultName)
    ? view.nameIdeas
    : [view.defaultName, ...view.nameIdeas];
  return (
    <>
      <section className="stg-center" aria-labelledby="stg-h">
        <div className="stg-hero mid">
          <span className="stg-glow" aria-hidden="true" />
          <AgentAvatar agentId={view.agentId} salt={salt} size={150} />
          {salt && (
            <span className="stg-react" aria-hidden="true">
              {t('stage.name.newLook')}
            </span>
          )}
        </div>
        <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
          {t('stage.name.title')}
        </h1>
        <p className="stg-sub">{t('stage.name.body', { name: view.defaultName })}</p>
        <form
          className="stg-namefield"
          data-bad={shownErr ? true : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={field} className="bk-visually-hidden">
            {t('stage.name.label')}
          </label>
          <input
            id={field}
            value={name}
            maxLength={NAME_MAX + 10}
            autoComplete="off"
            spellCheck={false}
            dir="auto"
            disabled={busy}
            aria-invalid={shownErr ? true : undefined}
            aria-describedby={`${field}-hint${shownErr ? ` ${field}-err` : ''}`}
            onChange={(e) => {
              setName(e.target.value);
              clearError();
            }}
            data-testid="stage-name"
          />
          <span className="stg-hint" id={`${field}-hint`}>
            {t('stage.name.hint')}
          </span>
        </form>
        {shownErr && (
          <p className="stg-err" id={`${field}-err`} role="alert" data-testid="stage-name-error">
            {shownErr}
          </p>
        )}
        <fieldset className="stg-ideas">
          <legend className="bk-visually-hidden">{t('stage.name.ideas')}</legend>
          <span className="stg-lbl" aria-hidden="true">
            {t('stage.name.ideas')}
          </span>
          {ideas.map((idea) => (
            <button
              key={idea}
              type="button"
              className="stg-chip nm"
              aria-pressed={n === idea}
              data-on={n === idea || undefined}
              disabled={busy}
              onClick={() => {
                setName(idea);
                clearError();
              }}
              data-testid={`stage-idea-${idea}`}
            >
              <AgentAvatar
                agentId={view.agentId}
                salt={saltFor(idea, view.defaultName)}
                size={36}
                shape="circle"
              />
              <span>{idea}</span>
            </button>
          ))}
        </fieldset>
      </section>
      <Foot
        t={t}
        busy={busy}
        back={back}
        next={submit}
        nextLabel={n && !local ? t('stage.name.go', { name: n }) : t('stage.next')}
        status={status}
      />
    </>
  );
}

function Question({
  t,
  view,
  busy,
  head,
  status,
  back,
  onNext,
  onDraft,
}: StepProps & {
  onNext(a: { choice?: string; choices?: string[]; text?: string }): void;
  /** what is tapped or typed but not sent yet (kept over "Skip for now") */
  onDraft?(d: { choices: string[]; text: string }): void;
}) {
  const qid = view.qid!;
  const multi = !!view.multi;
  const prev = view.answers[qid];
  // an answer left unsent when the owner skipped comes back as it was (still unsent); else the answer given before
  const kept = view.draft;
  // what is picked: one answer, or (a question that takes several) any number of them
  const [picked, setPicked] = useState<string[]>(
    kept
      ? kept.choices
      : prev
        ? prev.choices?.length
          ? prev.choices
          : prev.choice
            ? [prev.choice]
            : []
        : [],
  );
  // the owner's own words come back with the answer (a tapped answer alone comes back as its label)
  const [text, setText] = useState(
    kept
      ? kept.text
      : prev && (prev.own ?? (prev.choice === null || prev.text !== t(`q.${qid}.options.${prev.choice}`)))
        ? prev.text
        : '',
  );
  useEffect(() => {
    onDraft?.({ choices: picked, text });
  }, [picked, text, onDraft]);
  const group = useId();
  const free = useRef<HTMLTextAreaElement>(null);
  const ready = picked.length > 0 || !!text.trim();
  const toggle = (o: string) =>
    setPicked((p) => (multi ? (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]) : [o]));
  const submit = () => {
    if (!ready) return;
    const words = text.trim() ? { text: text.trim() } : {};
    if (multi) onNext({ ...(picked.length ? { choices: picked } : {}), ...words });
    else onNext({ ...(picked[0] ? { choice: picked[0] } : {}), ...words });
  };
  // the quick answers: checkboxes on a question that takes several, else one pick (radios)
  const chips = (
    <>
      {view.options.map((o) => (
        <label
          key={o}
          className="stg-chip"
          data-on={picked.includes(o) || undefined}
          data-testid={`stage-option-${o}`}
        >
          <input
            type={multi ? 'checkbox' : 'radio'}
            className="bk-visually-hidden"
            name={group}
            value={o}
            checked={picked.includes(o)}
            disabled={busy}
            onChange={() => toggle(o)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          {picked.includes(o) && <Icon name="check" size={18} />}
          <span>{t(`q.${qid}.options.${o}`)}</span>
        </label>
      ))}
      <button
        type="button"
        className="stg-chip"
        data-testid="stage-option-own"
        disabled={busy}
        onClick={() => {
          // one-answer questions: "something else" replaces the pick; several: the picks stay, words are added
          if (!multi) setPicked([]);
          free.current?.focus();
        }}
      >
        <Icon name="plus" size={18} />
        <span>{t('stage.q.other')}</span>
      </button>
    </>
  );
  return (
    <>
      <section className="stg-center stg-q" aria-labelledby="stg-h">
        <div className="stg-qrow">
          <AgentAvatar agentId={view.agentId} salt={saltFor(view.name, view.defaultName)} size={88} />
          <div>
            <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1} data-testid="stage-question">
              {t(`q.${qid}.text`)}
            </h1>
            <p className="stg-sub">{t(multi ? 'stage.q.subMulti' : 'stage.q.sub')}</p>
          </div>
        </div>
        {multi ? (
          <fieldset
            className="stg-chips"
            aria-labelledby="stg-h"
            data-multi="true"
            data-testid="stage-options"
          >
            {chips}
          </fieldset>
        ) : (
          <div className="stg-chips" role="radiogroup" aria-labelledby="stg-h" data-testid="stage-options">
            {chips}
          </div>
        )}
        <div className="stg-free">
          <label htmlFor={`${group}-free`}>{t('stage.q.typeLabel')}</label>
          <textarea
            id={`${group}-free`}
            ref={free}
            rows={2}
            maxLength={300}
            dir="auto"
            value={text}
            disabled={busy}
            placeholder={t('stage.q.typePlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            data-testid="stage-free"
          />
        </div>
      </section>
      <Foot
        t={t}
        busy={busy}
        back={back}
        next={submit}
        nextLabel={t('stage.next')}
        disabled={!ready}
        status={status}
      />
    </>
  );
}

/**
 * An answer on the plan as a short phrase that says what it answers ("No chat app for now", "Nothing to ask first"):
 * the owner's own words as typed, else the quick answer's own summary in the current language.
 */
const shownAnswer = (t: T, qid: string, a: Answer | null | undefined) => {
  if (!a) return '';
  const picked = a.choices?.length ? a.choices : a.choice ? [a.choice] : [];
  const own = a.own ?? (!picked.length || a.text !== t(`q.${qid}.options.${picked[0]}`));
  if (own || !picked.length) return a.text;
  return picked.map((c) => t(`stage.plan.pick.${qid}.${c}`)).join(' · ');
};

function Plan({
  t,
  view,
  busy,
  head,
  status,
  onApprove,
  onChange,
}: StepProps & { onApprove(): void; onChange(): void }) {
  const plan = view.plan!;
  const total = plan.agents.length;
  const [shown, setShown] = useState(() => (reducedMotion() ? total : 1));
  useEffect(() => {
    if (shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), 520);
    return () => clearTimeout(id);
  }, [shown, total]);
  const lang = view.languages.find((l) => l.code === view.language);
  const picks = [
    lang ? t('stage.plan.pick.language', { language: lang.name }) : '',
    ...['people', 'chat', 'email', 'askFirst'].map((q) => shownAnswer(t, q, view.answers[q])),
  ].filter((x): x is string => !!x);
  // a reason every card would repeat says nothing: then no card shows it
  const whys = plan.agents.map((a) => a.why);
  const sameWhy = whys.length > 1 && whys.every((w) => w === whys[0]);
  return (
    <>
      <section className="stg-center stg-plan" aria-labelledby="stg-h">
        <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
          {t('stage.plan.title')}
        </h1>
        <div className="stg-lead" data-testid="stage-lead">
          <AgentAvatar
            agentId={view.agentId}
            salt={saltFor(view.name, view.defaultName)}
            size={60}
            shape="circle"
          />
          <div>
            <b dir="auto">{view.name}</b>
            <span>{t('stage.plan.lead')}</span>
          </div>
        </div>
        <div className="stg-wires" aria-hidden="true" />
        {/* each card draws its own line up to a rail that runs from the first card's centre to the last one's */}
        <ul className="stg-team" aria-busy={shown < total} data-testid="stage-plan">
          {plan.agents.slice(0, shown).map((a, i) => (
            <li
              key={a.key}
              className="stg-hcard"
              data-arriving={i === shown - 1 && shown < total ? true : undefined}
              data-testid="stage-plan-agent"
            >
              {i === shown - 1 && shown < total && (
                <span className="stg-arriving" aria-hidden="true">
                  {t('stage.plan.arriving')}
                </span>
              )}
              <span className="stg-hav">
                <AgentAvatar agentId={a.face || `plan-${plan.planId}-${a.key}`} size={92} />
              </span>
              <b dir="auto">{a.name}</b>
              <p dir="auto">{a.job}</p>
              {a.why && !sameWhy && (
                <span className="stg-why" dir="auto" data-testid="stage-plan-why">
                  {t('stage.plan.because', { what: a.why })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {picks.length > 0 && (
          <ul className="stg-picks" aria-label={t('stage.plan.picks')} data-testid="stage-picks">
            {picks.map((p) => (
              <li key={p} dir="auto">
                {p}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="stg-foot center">
        {status}
        <div className="stg-pair">
          <button
            type="button"
            className="stg-btn sec"
            onClick={onChange}
            disabled={busy}
            data-testid="stage-change"
          >
            <Icon name="pencil" size={18} />
            <span>{t('stage.plan.change')}</span>
          </button>
          <button
            type="button"
            className="stg-btn pri"
            onClick={onApprove}
            disabled={busy}
            data-testid="stage-approve"
          >
            <span>{t('stage.plan.approve')}</span>
            <Icon name="check" size={20} />
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * W40 "A few things need your OK": a short stack of cards built by the server from the owner's answers and the plan,
 * each one thing with one plain sentence of why, and Connect / Allow or Later. Nothing is turned on here: a tap opens
 * the existing guided page (the Stage resumes on this screen afterwards). Continue (or Skip) leaves the rest as Later:
 * the main helper keeps each one as a card in its chat and in the pinned bar.
 */
function Oks({
  t,
  view,
  busy,
  head,
  status,
  back,
  onTap,
  onFinish,
}: StepProps & { onTap(i: OkView, choice: 'yes' | 'later'): void; onFinish(): void }) {
  const items = view.oks?.items ?? [];
  const left = items.filter((i) => i.state === 'open').length;
  const decided = items.some((i) => i.state !== 'open');
  return (
    <section className="stg-center stg-oks" aria-labelledby="stg-h" data-testid="stage-oks">
      <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
        {t('oks.title')}
      </h1>
      <p className="stg-sub">{t('oks.sub', { name: view.name })}</p>
      <div className="stg-oks-list">
        {items.map((i) => {
          const p = { app: i.appName ?? '' };
          return (
            <HelperCard
              key={`${i.kind}:${i.app ?? ''}`}
              id={`ok-${i.kind}-${i.app ?? ''}`}
              testId={`ok-${i.kind}`}
              variant={i.kind === 'email' || i.kind === 'chat' || i.kind === 'apps' ? 'connect' : 'ok'}
              title={t(`oks.${i.kind}.title`, p)}
              text={t(`oks.${i.kind}.why`, p)}
              state={i.state === 'open' ? 'open' : i.state === 'yes' ? 'done' : 'later'}
              settledLabel={i.state === 'yes' ? t('oks.opened') : t('oks.later', { name: view.name })}
              busy={busy}
              actions={[
                {
                  id: 'yes',
                  label: t(`oks.${i.kind}.yes`),
                  style: 'primary',
                  onAction: () => onTap(i, 'yes'),
                },
                {
                  id: 'later',
                  label: t('oks.laterBtn'),
                  style: 'secondary',
                  onAction: () => onTap(i, 'later'),
                },
              ]}
            />
          );
        })}
      </div>
      <Foot
        t={t}
        busy={busy}
        back={decided ? back : undefined}
        next={onFinish}
        nextLabel={left ? t('oks.continueLater', { count: left }) : t('oks.continue')}
        status={status}
        testid="stage-oks-finish"
      />
    </section>
  );
}

function Done({ t, view, head }: StepProps) {
  const team = view.team.filter((a) => ID.test(a.agentId) && ID.test(a.chatId));
  // the one next step the email answer brought: connect opens the guided flow, a new mailbox the lead's checklist
  const mail = view.answers.email?.choice;
  const chat = `#/chats/${ID.test(view.chatId) ? view.chatId : ''}`;
  const spots = [
    { left: 0, top: 96 },
    { left: 58, top: 12 },
    { left: 222, top: 6 },
    { left: 236, top: 110 },
  ];
  return (
    <section className="stg-fin" aria-labelledby="stg-h">
      <div className="stg-fin-l">
        <div className="stg-cluster" aria-hidden="true">
          {team.slice(0, 4).map((a, i) => (
            <span key={a.agentId} className="stg-cl" style={{ left: spots[i]!.left, top: spots[i]!.top }}>
              <AgentAvatar agentId={a.agentId} salt={a.salt} size={76} shape="circle" />
            </span>
          ))}
          <span className="stg-cl main">
            <AgentAvatar
              agentId={view.agentId}
              salt={saltFor(view.name, view.defaultName)}
              size={124}
              shape="circle"
            />
          </span>
        </div>
        <h1 className="stg-say" id="stg-h" ref={head} tabIndex={-1}>
          {t('stage.done.title')}
        </h1>
        <p className="stg-sub">{t('stage.done.body', { name: view.name })}</p>
        {(mail === 'new' || mail === 'connect') && (
          <div className="stg-next" data-testid="stage-done-next">
            <b>{t('stage.done.next.title')}</b>
            <span dir="auto">{t(`stage.done.next.${mail}`, { name: view.name })}</span>
            <button
              type="button"
              className="stg-btn sec"
              onClick={() => go(mail === 'connect' ? '#/inbox/connect' : chat)}
              data-testid="stage-done-email"
            >
              <Icon name="inbox" size={20} />
              <span dir="auto">{t(`stage.done.next.${mail}Go`, { name: view.name })}</span>
            </button>
          </div>
        )}
        <div className="stg-cta start">
          <button type="button" className="stg-btn pri big" onClick={() => go(chat)} data-testid="stage-open">
            <span>{t('stage.done.open')}</span>
            <Icon name="chevron" size={20} />
          </button>
        </div>
      </div>
      <section className="stg-listcard" aria-labelledby="stg-chats">
        <h2 id="stg-chats">
          <span>{t('stage.done.chats')}</span>
          <span>{team.length + 1}</span>
        </h2>
        <div className="stg-row pinned" data-testid="stage-done-pinned">
          <AgentAvatar
            agentId={view.agentId}
            salt={saltFor(view.name, view.defaultName)}
            size={48}
            shape="circle"
          />
          <div>
            <b dir="auto">{view.name}</b>
            <span>{t('stage.done.lead')}</span>
          </div>
          <Icon name="pin" size={20} />
        </div>
        <p className="stg-callout">
          <Icon name="pin" size={18} />
          <span dir="auto">{t('stage.done.pinned', { name: view.name })}</span>
        </p>
        <div className="stg-divider" />
        {team.map((a) => (
          <div key={a.agentId} className="stg-row" data-testid="stage-done-agent">
            <AgentAvatar agentId={a.agentId} salt={a.salt} size={44} shape="circle" />
            <div>
              <b dir="auto">{a.name}</b>
              <span>{t('stage.done.ready')}</span>
            </div>
          </div>
        ))}
      </section>
    </section>
  );
}
