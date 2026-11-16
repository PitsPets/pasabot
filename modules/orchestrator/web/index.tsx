/**
 * Team builder (web): the full-screen Stage a new owner meets first (`#/team-setup`, see Stage.tsx), the setup cards
 * of an interview held in the chat (a question with tap answers, the ONE plan card with Approve / Change; older
 * owners), the "your team is ready" card (with the Stage's short summary) and the Settings entry "Set up my team
 * again". Every text in a card is plain text from the server, rendered as text; links are built here from validated
 * ids and a fixed list of setup pages, never taken from the card.
 */
import type { WebModule } from '@pasabot/core/web';
import { documentLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { MessageBlock } from '@pasabot/protocol';
import { AgentAvatar, Button, Icon } from '@pasabot/ui';
import { useEffect, useState } from 'react';
import { Stage } from './Stage.js';

type T = (k: string, o?: Record<string, unknown>) => string;
const translations = moduleTranslator(
  'orchestrator',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): T {
  return useModuleT(translations).t;
}

const API = '/api/m/orchestrator';
class CallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    throw new CallError(r.status, b.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

/** where each setup step opens: the existing guided pages (the person types any secret there, never in chat) */
const STEP_HREF: Record<string, string> = {
  'email-new': '#/inbox/connect',
  'email-connect': '#/inbox/connect',
  telegram: '#/settings/people/channels',
  whatsapp: '#/settings/people/channels',
  discord: '#/settings/people/channels',
  slack: '#/settings/people/channels',
  people: '#/people',
};
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface QuestionData {
  qid: string;
  round: number;
  step: number;
  total: number;
  options: { id: string; label: string }[];
  answer: string | null;
  closed: boolean;
}
interface PlanData {
  planId: string;
  state: 'open' | 'approved' | 'changed' | 'skipped';
  brain: string;
  /** `face`: the avatar seed picked with the plan, which the helper keeps */
  agents: { key: string; name: string; job: string; face?: string }[];
  steps: { kind: string; label: string }[];
}
interface TeamData {
  /** `salt`: the helper's avatar salt (its plan face) */
  agents: { agentId: string; chatId: string; name: string; salt?: string }[];
  steps: { kind: string; label: string }[];
  summary?: { q: string; a: string }[];
}

const card: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  marginBlockStart: 10,
  padding: 14,
  borderRadius: 16,
  border: '1px solid var(--bk-line)',
  background: 'var(--bk-panel)',
  maxInlineSize: 560,
};
const small: React.CSSProperties = { margin: 0, fontSize: 13, color: 'var(--bk-ink-2)' };

/** "Skip for now": keeps just the team builder; any card offers it while the setup is open */
function useAct(t: T) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await call(path, body);
    } catch (e) {
      setErr(e instanceof CallError && e.status === 403 ? t('web.ownerOnly') : t('web.failed'));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

function SkipLink({ t, busy, onSkip }: { t: T; busy: boolean; onSkip(): void }) {
  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={onSkip} data-testid="orch-skip">
      {t('web.skip')}
    </Button>
  );
}

function QuestionCard({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as QuestionData;
  const { busy, err, run } = useAct(t);
  const open = d.answer === null && !d.closed;
  return (
    <div style={card} data-testid="orch-question" data-qid={d.qid} data-open={open ? 'true' : 'false'}>
      <p style={small}>{t('web.step', { n: d.step, total: d.total })}</p>
      {open ? (
        <>
          <fieldset
            className="tap-chips"
            style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
            data-testid="orch-options"
          >
            <legend className="bk-visually-hidden">{t('web.quick')}</legend>
            {d.options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                disabled={busy}
                data-testid={`orch-option-${o.id}`}
                onClick={() => void run('/answer', { round: d.round, qid: d.qid, choice: o.id })}
              >
                {o.label}
              </Button>
            ))}
          </fieldset>
          <p style={small}>{t('web.typeOwn')}</p>
          <div>
            <SkipLink t={t} busy={busy} onSkip={() => void run('/skip', {})} />
          </div>
        </>
      ) : d.answer ? (
        <p className="row-ic" style={{ margin: 0 }} data-testid="orch-answered">
          <Icon name="check-circle" size={16} />
          <span dir="auto">{d.answer}</span>
        </p>
      ) : (
        <p style={small} data-testid="orch-closed">
          {t('web.closed')}
        </p>
      )}
      {err && (
        <p className="bk-field__error" role="alert" data-testid="orch-error" style={{ margin: 0 }}>
          {err}
        </p>
      )}
    </div>
  );
}

function PlanCard({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as PlanData;
  const { busy, err, run } = useAct(t);
  const open = d.state === 'open';
  return (
    <div style={card} data-testid="orch-plan" data-state={d.state}>
      <h3 style={{ margin: 0, fontSize: 16 }}>{t('web.planTitle')}</h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {d.agents.map((a) => (
          <li
            key={a.key}
            className="row-ic"
            style={{ alignItems: 'flex-start', gap: 10 }}
            data-testid="orch-plan-agent"
          >
            <AgentAvatar agentId={a.face || `plan-${d.planId}-${a.key}`} size={36} />
            <span style={{ display: 'grid', gap: 2, minInlineSize: 0 }}>
              <strong dir="auto">{a.name}</strong>
              <span dir="auto" style={{ fontSize: 14 }}>
                {a.job}
              </span>
              <span style={small}>{t('web.brain', { name: d.brain })}</span>
            </span>
          </li>
        ))}
      </ul>
      {d.steps.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <p style={{ ...small, fontWeight: 700 }}>{t('web.stepsTitle')}</p>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 14 }} data-testid="orch-plan-steps">
            {d.steps.map((s) => (
              <li key={s.kind} dir="auto">
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open ? (
        <>
          <div className="tap-chips">
            <Button
              variant="primary"
              disabled={busy}
              data-testid="orch-approve"
              onClick={() => void run('/approve', { planId: d.planId })}
            >
              {t('web.approve')}
            </Button>
            <Button
              disabled={busy}
              data-testid="orch-change"
              onClick={() => void run('/change', { planId: d.planId })}
            >
              {t('web.changePlan')}
            </Button>
          </div>
          <div>
            <SkipLink t={t} busy={busy} onSkip={() => void run('/skip', {})} />
          </div>
        </>
      ) : (
        <p style={small} data-testid="orch-plan-state">
          {t(`web.plan_${d.state}`)}
        </p>
      )}
      {err && (
        <p className="bk-field__error" role="alert" data-testid="orch-error" style={{ margin: 0 }}>
          {err}
        </p>
      )}
    </div>
  );
}

function TeamCard({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as TeamData;
  return (
    <div style={card} data-testid="orch-team">
      {d.summary && d.summary.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }} data-testid="orch-summary">
          <p style={{ ...small, fontWeight: 700 }}>{t('web.summaryTitle')}</p>
          <dl style={{ margin: 0, display: 'grid', gap: 6, fontSize: 14 }}>
            {d.summary.map((x) => (
              <div key={x.q} style={{ display: 'grid', gap: 0 }}>
                <dt dir="auto" style={{ color: 'var(--bk-ink-2)', fontSize: 13 }}>
                  {x.q}
                </dt>
                <dd dir="auto" style={{ margin: 0 }}>
                  {x.a}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {d.agents
          .filter((a) => ID.test(a.chatId) && ID.test(a.agentId))
          .map((a) => (
            <li key={a.agentId}>
              <a
                className="bk-btn bk-btn--secondary row-ic"
                style={{ justifyContent: 'flex-start', gap: 10, minBlockSize: 44 }}
                href={`#/chats/${a.chatId}`}
                data-testid="orch-team-agent"
              >
                <AgentAvatar agentId={a.agentId} salt={a.salt} size={28} />
                <span dir="auto">{t('web.open', { name: a.name })}</span>
              </a>
            </li>
          ))}
      </ul>
      {d.steps.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <p style={{ ...small, fontWeight: 700 }}>{t('web.stepsNext')}</p>
          <div className="tap-chips">
            {d.steps
              .filter((s) => STEP_HREF[s.kind])
              .map((s) => (
                <a
                  key={s.kind}
                  className="bk-btn bk-btn--secondary bk-btn--sm"
                  href={STEP_HREF[s.kind]}
                  data-testid={`orch-step-${s.kind}`}
                >
                  {s.label}
                </a>
              ))}
          </div>
          <p style={small}>{t('web.secretsNote')}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Settings › Agents & brains: run the team setup again on the Stage. A Stage left half-way (skipped for now) picks up
 * where it was; a finished one starts over on the hello, keeping the helpers already made.
 */
function SetupAgain() {
  const t = useT();
  const [state, setState] = useState<{ chatId: string | null; stage?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    call<{ chatId: string | null; stage?: string | null }>('/state')
      .then((s) => !gone && setState(s))
      .catch(() => !gone && setState({ chatId: null }));
    return () => {
      gone = true;
    };
  }, []);
  const again = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call<{ chatId: string }>('/restart', { lang: documentLocale(), stage: true });
      window.location.hash = '#/team-setup';
    } catch (e) {
      setErr(e instanceof CallError && e.status === 409 ? t('web.settings.noBrain') : t('web.failed'));
      setBusy(false);
    }
  };
  return (
    <section style={{ display: 'grid', gap: 10 }} data-testid="orch-settings">
      <p style={{ margin: 0 }}>{t('web.settings.body')}</p>
      <div className="tap-chips">
        <Button
          variant="primary"
          disabled={busy || !state}
          onClick={() => void again()}
          data-testid="orch-again"
        >
          {busy
            ? t('web.settings.working')
            : state?.stage === 'open' || state?.stage === 'paused'
              ? t('web.settings.continue')
              : t('web.settings.again')}
        </Button>
        {state?.chatId && ID.test(state.chatId) && (
          <a
            className="bk-btn bk-btn--secondary"
            href={`#/chats/${state.chatId}`}
            data-testid="orch-open-chat"
          >
            {t('web.settings.openChat')}
          </a>
        )}
      </div>
      {err && (
        <p className="bk-field__error" role="alert" style={{ margin: 0 }}>
          {err}
        </p>
      )}
    </section>
  );
}

function StageRoute() {
  return <Stage t={useT()} />;
}

const mod: WebModule = {
  id: 'orchestrator',
  // the first-run Stage: full screen (no chats list, no side panel), the owner only
  routes: [{ path: '/team-setup', component: StageRoute, bare: true, titleKey: 'orchestrator:stage.title' }],
  messageBlockRenderers: {
    'orchestrator.question': QuestionCard,
    'orchestrator.plan': PlanCard,
    'orchestrator.team': TeamCard,
  },
  settingsSections: [
    {
      id: 'team-setup',
      labelKey: 'orchestrator:web.settings.title',
      hintKey: 'orchestrator:web.settings.hint',
      keywordsKey: 'orchestrator:web.settings.keywords',
      icon: 'agent',
      group: 'agents',
      order: 40,
      optional: true,
      component: SetupAgain,
    },
  ],
};
export default mod;
