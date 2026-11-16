/**
 * First run after claiming (Simplify spec 6, FIRST-TIMER fixes 3-5): exactly two short steps, one primary button each.
 * No language step (the app follows the browser; Settings › Language changes it) and no country step.
 *
 * Step 1 "Pick a brain": the brains ready on this computer, the best one ticked, then a local model server that
 * answers on loopback but is not added yet (W34 detection; choosing it adds it, the owner's own click). The free starter is offered as one
 * tap (one plain sentence; what, where, from and the checksum note sit under "Details"), ticked when no brain is ready. The button makes
 * the built-in team builder on that brain (`POST /api/m/orchestrator/start`: the server makes it, with its own system
 * prompt, a friendly name and its avatar) and lands on its full-screen Stage (onboarding direction A: hello, language,
 * its name, the questions, the plan; there is no agent form in the first run). Without the orchestrator module the button makes
 * one plain agent and opens its chat. `#/welcome?agent=<id>&chat=<id>` (the old step 2) still opens the first-run form.
 */

import type { AgentDTO } from '@pasabot/protocol';
import { Button, Icon } from '@pasabot/ui';
import { useEffect, useId, useState } from 'react';
import { AgentForm } from '../agents/AgentForm.js';
import { BrainTile, brainState } from '../agents/BrainPicker.js';
import { ApiError, api } from '../app/api.js';
import { useI18n, useT } from '../app/i18n.js';
import { navigate, useRoute } from '../app/router.js';
import {
  live,
  loadChats,
  loadProviders,
  type ProviderInfo,
  providerName,
  setState,
  useStore,
} from '../app/store.js';
import { SystemNotices } from '../settings/ThisComputer.js';

/** the free starter as the templates module reports it (`GET /api/m/templates/starter`) */
interface Starter {
  available: boolean;
  models: { id: string; name: string }[];
  consent: { what: string; where: string; from: string } | null;
}

/**
 * "best" first: the apps the user is signed in to, then the big brands' apps, then the free starter, then local and
 * other apps; the test brain always last, so it is never ticked while a real brain is ready
 */
const PREFERRED = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'local', 'acp'];
const family = (id: string) => id.split(/[:._-]/)[0] ?? id;
const rank = (id: string) => {
  const i = PREFERRED.indexOf(family(id));
  return i < 0 ? PREFERRED.length : i;
};
const isTest = (p: ProviderInfo) => (p.id === 'fake' ? 1 : 0);
const notSignedIn = (p: ProviderInfo) => (p.status.signedIn === true ? 0 : 1);
export function bestFirst(list: ProviderInfo[]): ProviderInfo[] {
  return list
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        isTest(a.p) - isTest(b.p) ||
        notSignedIn(a.p) - notSignedIn(b.p) ||
        rank(a.p.id) - rank(b.p.id) ||
        a.i - b.i,
    )
    .map((x) => x.p);
}

/** a local model server that answered on loopback (`GET /api/m/local/detect`) */
interface FoundLocal {
  name: string;
  api: 'ollama' | 'openai';
  url: string;
  models: number;
}

const STARTER = 'starter';
/** the team builder's full-screen Stage (orchestrator module): language, name, the questions, the plan */
const STAGE_PATH = '/team-setup';
const FOUND = 'found:';

export function Welcome() {
  const q = useRoute().query;
  const agentId = q.get('agent');
  const chatId = q.get('chat');
  if (agentId && chatId) return <AgentForm key={agentId} agentId={agentId} first={{ chatId }} />;
  return <PickBrain />;
}

/** The brain's recommended model (the free-tier gate ticks a free one), else the brain's own default. */
async function recommendedModel(providerId: string): Promise<string | null> {
  try {
    const r = await api<{ models: { id: string; recommended?: boolean }[]; listed: boolean }>(
      `/api/v1/providers/${encodeURIComponent(providerId)}/models`,
    );
    return (r.listed && r.models.find((m) => m.recommended)?.id) || null;
  } catch {
    return null;
  }
}

function PickBrain() {
  const t = useT();
  const { lang: uiLang } = useI18n();
  const lang = () => uiLang;
  const providers = useStore((s) => s.providers);
  const [starter, setStarter] = useState<Starter | null | undefined>(undefined);
  const [found, setFound] = useState<FoundLocal[]>([]);
  // the owner's own tap; until then the pick follows the data as it lands (the brain list is the slow one)
  const [picked, setPicked] = useState<string | null>(null);
  // this visit's brain list has answered (or failed); the boot list in the store may be missing or stale
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // a failed free-starter download: the plain line above, the raw reason under "Details"
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const group = useId();
  const head = useId();

  useEffect(() => {
    let gone = false;
    void loadProviders().finally(() => !gone && setListed(true));
    // no templates module here (404): no free starter offer
    api<Starter>('/api/m/templates/starter')
      .then((s) => !gone && setStarter(s))
      .catch(() => !gone && setStarter(null));
    // no local models module, or nothing answering: no local option
    api<{ found: FoundLocal[] }>('/api/m/local/detect')
      .then((r) => !gone && setFound(r.found ?? []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);

  const ready = bestFirst(providers.filter((p) => brainState(p) === 'ready'));
  // nothing is decided before the brain list is known: a ready brain in hand, or this visit's list has answered
  const brainsKnown = listed || ready.length > 0;
  const offerStarter =
    brainsKnown && !!starter?.available && !!starter.consent && !ready.some((p) => p.id === 'opencode');
  const options = [
    ...ready.map((p) => p.id),
    ...found.map((f) => FOUND + f.url),
    ...(offerStarter ? [STARTER] : []),
  ];
  // the best ready brain is ticked; else a local model that answers; else (no brain ready) the free starter.
  // A tap is kept whatever lands later, as long as that choice is still on the list.
  const auto = !brainsKnown
    ? ''
    : (ready[0]?.id ?? (found[0] ? FOUND + found[0].url : offerStarter ? STARTER : ''));
  const choice = picked && options.includes(picked) ? picked : auto;

  // the team builder (orchestrator module); a server without it gets one plain agent instead
  const make = async (
    providerId: string,
    model: string | null,
  ): Promise<{ agentId: string; chatId: string; stage?: string | null }> => {
    try {
      // a new owner meets the team builder on its full-screen Stage, not in a chat
      return await api<{ agentId: string; chatId: string; stage?: string | null }>(
        '/api/m/orchestrator/start',
        {
          method: 'POST',
          body: { providerId, model, lang: lang(), stage: true },
        },
      );
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    const r = await api<{ agent: AgentDTO; chatId: string }>('/api/v1/agents', {
      method: 'POST',
      body: { name: t('onboarding.defaultName'), instructions: '', providerId, model },
    });
    setState((s) => ({ agents: { ...s.agents, [r.agent.id]: r.agent } }));
    return { agentId: r.agent.id, chatId: r.chatId };
  };
  const go = async () => {
    if (!choice) return;
    setBusy(true);
    setErr(null);
    setErrDetail(null);
    try {
      let made: { agentId: string; chatId: string; stage?: string | null };
      if (choice === STARTER && starter) {
        // the tap is the consent: the sentence above the button says what happens, Details says what, where, from
        await api('/api/m/templates/starter/install', { method: 'POST', body: { consent: true } });
        const model = starter.models[0]?.id ?? null;
        made = await make('opencode', model);
        await api('/api/m/templates/starter/agents', {
          method: 'POST',
          body: { agentId: made.agentId, model },
        }).catch(() => {});
        void loadProviders();
      } else if (choice.startsWith(FOUND)) {
        // the owner's click adds the local server (owner-only route; agents never reach it), then the agent uses it
        const f = found.find((x) => FOUND + x.url === choice)!;
        const r = await api<{ endpoint: { providerId: string } }>('/api/m/local/endpoints', {
          method: 'POST',
          body: { name: f.name, api: f.api, url: f.url, tools: 'auto' },
        });
        await loadProviders();
        made = await make(r.endpoint.providerId, await recommendedModel(r.endpoint.providerId));
      } else made = await make(choice, await recommendedModel(choice));
      const { agent } = await api<{ agent: AgentDTO }>(`/api/v1/agents/${encodeURIComponent(made.agentId)}`);
      setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
      await loadChats();
      live.subscribe([`chat:${made.chatId}`, `agent:${made.agentId}`]);
      if (made.stage === 'open') navigate(STAGE_PATH, true);
      else navigate(`/chats/${encodeURIComponent(made.chatId)}`, true);
    } catch (e) {
      setErr(choice === STARTER ? t('onboarding.starterFailedPlain') : t('errors.generic'));
      if (choice === STARTER) setErrDetail((e as Error).message || null);
      setBusy(false);
    }
  };

  const loading = !brainsKnown || (starter === undefined && !ready.length);
  const nothing = !loading && !options.length;
  const option = (id: string, title: string, sub: string, tile: string) => {
    const on = choice === id;
    return (
      <label key={id} className="brain-card" data-testid={`onb-brain-${id}`} data-on={on || undefined}>
        <input
          type="radio"
          className="bk-visually-hidden"
          name={group}
          value={id}
          checked={on}
          disabled={busy}
          onChange={() => setPicked(id)}
        />
        <BrainTile id={tile} />
        <span className="grow">
          <span className="brain-card__name">{title}</span>
          <span className="brain-card__state">{sub}</span>
        </span>
        {on && <Icon name="check-circle" size={20} />}
      </label>
    );
  };

  return (
    <div className="page onb" data-testid="onb-brain">
      <p className="muted onb-step" data-testid="onb-step">
        {t('onboarding.step', { n: 1, total: 2 })}
      </p>
      <h1>{t('onboarding.brainTitle')}</h1>
      <p className="muted">{t('onboarding.brainIntro')}</p>
      {/* what the owner should know about this computer first (no helper sandbox on Windows, a locked vault) */}
      <SystemNotices />
      <div className="bk-card panel stack">
        {loading && <p className="muted">{t('core:common.loading')}</p>}
        {nothing && (
          <p className="row-ic" data-testid="onb-no-brain">
            <Icon name="alert" />
            <span>{t('onboarding.noBrain')}</span>
          </p>
        )}
        {brainsKnown && options.length > 0 && (
          <div className="bk-field">
            <span className="bk-field__label bk-visually-hidden" id={head}>
              {t('onboarding.brainTitle')}
            </span>
            <div role="radiogroup" aria-labelledby={head} className="brain-cards" data-testid="onb-brains">
              {ready.map((p) => option(p.id, providerName(t, p), t('agents.brainReady'), p.id))}
              {found.map((f) => option(FOUND + f.url, f.name, t('onboarding.localSub'), 'local'))}
              {offerStarter &&
                option(STARTER, t('onboarding.starterName'), t('onboarding.starterSub'), 'opencode')}
            </div>
          </div>
        )}
        {choice === STARTER && starter?.consent && (
          <div className="onb-starter" data-testid="onb-starter-note">
            <p>{t('onboarding.starterBody')}</p>
            <details className="set-more">
              <summary>{t('onboarding.details')}</summary>
              <ul className="onb-facts" data-testid="onb-starter-details">
                <li>{t('onboarding.starterWhat', { what: starter.consent.what })}</li>
                <li>{t('onboarding.starterWhere', { where: starter.consent.where })}</li>
                <li>{t('onboarding.starterFrom', { from: starter.consent.from })}</li>
                <li>{t('onboarding.starterCheck')}</li>
              </ul>
            </details>
          </div>
        )}
        {err && (
          <div data-testid="onb-error-box">
            <p className="bk-field__error" role="alert" data-testid="onb-error">
              {err}
            </p>
            {errDetail && (
              <details className="set-more">
                <summary>{t('onboarding.details')}</summary>
                <p className="muted" data-testid="onb-error-detail">
                  {errDetail}
                </p>
              </details>
            )}
          </div>
        )}
        <div className="row">
          {nothing ? (
            <a className="bk-btn bk-btn--primary" href="#/settings/agents/brains" data-testid="onb-next">
              {t('onboarding.setUpBrain')}
            </a>
          ) : (
            <Button
              variant="primary"
              onClick={() => void go()}
              disabled={busy || !choice}
              data-testid="onb-next"
            >
              {busy
                ? t(choice === STARTER ? 'onboarding.starterWorking' : 'onboarding.working')
                : t(choice === STARTER ? 'onboarding.starterGo' : 'onboarding.next')}
            </Button>
          )}
        </div>
      </div>
      {!nothing && (
        <a className="onb-other" href="#/settings/agents/brains" data-testid="onb-other-brain">
          {t('onboarding.otherBrain')}
        </a>
      )}
    </div>
  );
}
