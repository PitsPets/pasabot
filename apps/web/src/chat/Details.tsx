/**
 * Right-hand agent details, short by default: the agent, what it does in one or two sentences (`summary`, made on the
 * server from its job), which brain it thinks with, and Edit / Change. Everything else (full instructions, backup
 * brains, trust, the module dock panels: tools, memory, schedules...) is behind one More disclosure. The built-in
 * team builder's own prompt never reaches the client, so it has nothing to read or edit here.
 */
import type { AgentDTO } from '@pasabot/protocol';
import { AgentAvatar, BrandTile, Button, Card } from '@pasabot/ui';
import { useEffect, useState } from 'react';
import { BrainCards, ModelPicker, useModels } from '../agents/BrainPicker.js';
import { api } from '../app/api.js';
import { useI18n } from '../app/i18n.js';
import { navigate } from '../app/router.js';
import { slots } from '../app/slots.js';
import { agentStatus, providerName, setState, useStore } from '../app/store.js';
import { useWords } from '../app/words.js';
import { DockPanelSlots } from '../shell/slots.js';
import { sinceText } from './format.js';

export function Details({ agentId, onHide }: { agentId: string; chatId: string; onHide(): void }) {
  const { t, lang } = useI18n();
  const w = useWords();
  const agent = useStore((s) => s.agents[agentId]);
  const owner = useStore((s) => s.me?.kind === 'owner');
  const status = useStore((s) => agentStatus(s, agentId));
  const providers = useStore((s) => s.providers);
  const [changing, setChanging] = useState(false);
  const backup = useBackup(agentId, owner, agent);
  if (!agent) return null;
  const pname = (id: string) => {
    const p = providers.find((x) => x.id === id);
    return p ? providerName(t, p) : id;
  };
  const since = sinceText(agent.createdAt, lang);
  // the built-in team builder runs on PasaBot's own prompt: nothing to edit or read here (the server never sends it)
  const editable = owner && !agent.builtIn;
  const instructions = editable ? agent.instructions.trim() : '';
  return (
    // short by default (owner: "the side has too much on it"): who, what it does in a line, its brain; the rest is
    // behind More
    <Card className="det-inner det-card">
      <div className="hero det-sec">
        <AgentAvatar
          agentId={agent.id}
          salt={agent.avatarSalt}
          size={64}
          state={status === 'working' ? 'thinking' : 'idle'}
        />
        <div className="grow">
          <h2>{agent.name}</h2>
          <p className="muted small" data-testid="details-status">
            {t(`status.${status}`)} · {t('details.since', { date: since })}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onHide} data-details-hide="">
          {t('details.hide')}
        </Button>
      </div>
      <section className="box det-sec" aria-labelledby="det-does" data-testid="details-does">
        <h3 id="det-does" className="box-h">
          <span>{t('details.does', { name: agent.name })}</span>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(`/agents/${agent.id}/edit`)}
              data-testid="details-edit"
            >
              {t('details.edit')}
            </Button>
          )}
        </h3>
        <p data-testid="details-summary">{agent.summary || t('details.noSummary')}</p>
      </section>
      <section className="box det-sec" aria-labelledby="det-brain" data-testid="details-brain">
        <h3 id="det-brain" className="box-h">
          <span>{t('details.thinksWith')}</span>
          {owner && !changing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setChanging(true)}
              data-testid="details-brain-change"
            >
              {t('details.change')}
            </Button>
          )}
        </h3>
        {changing && <BrainChange agent={agent} onDone={() => setChanging(false)} />}
        <p className="det-main" data-testid="details-main">
          <BrandTile id={agent.providerId} size={24} fallback="brain" />
          {pname(agent.providerId)}
          {agent.model ? (
            <>
              {' · '}
              <ModelName providerId={agent.providerId} model={agent.model} ask={owner} />
            </>
          ) : (
            ''
          )}
        </p>
      </section>
      <details className="set-more det-more det-sec" data-testid="details-more">
        <summary data-testid="details-more-toggle">{t('details.more')}</summary>
        <div className="det-more__body">
          {instructions && (
            <section className="det-part" aria-labelledby="det-instr">
              <h3 id="det-instr" className="box-h">
                <span>{t('details.instructions')}</span>
              </h3>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
              <div className="det-instr pre" tabIndex={0} data-testid="details-instructions">
                {instructions}
              </div>
            </section>
          )}
          <section className="det-part" aria-labelledby="det-backup">
            <h3 id="det-backup" className="box-h">
              <span>{t('details.backupBrains')}</span>
            </h3>
            <p className="det-main" data-testid="details-backup">
              {backup.length
                ? backup.map((f, i) => (
                    <span key={`${f.providerId}:${f.model ?? ''}`} className="det-brain">
                      {i > 0 ? ', ' : ''}
                      <BrandTile id={f.providerId} size={24} fallback="brain" />
                      {pname(f.providerId)}
                      {f.model ? (
                        <>
                          {' · '}
                          <ModelName providerId={f.providerId} model={f.model} ask={owner} />
                        </>
                      ) : null}
                    </span>
                  ))
                : t('details.none')}
            </p>
          </section>
          <section className="det-part" aria-labelledby="det-trust">
            <h3 id="det-trust" className="box-h">
              <span>{w('details.trust')}</span>
            </h3>
            <p>{w(`agents.trustLevels.${agent.trustLevel}`)}</p>
          </section>
          {/* tools, memory, schedules...: whatever the modules add, never placeholders */}
          {slots.dockPanels.map((d) => (
            <section className="det-part" key={d.id} aria-label={t(d.labelKey)}>
              <h3 className="box-h">
                <span>{t(d.labelKey)}</span>
              </h3>
              <DockPanelSlots slots={{ ...slots, dockPanels: [d] }} />
            </section>
          ))}
        </div>
      </details>
    </Card>
  );
}

type Chain = { providerId: string; model?: string | null }[];
/**
 * The agent's backup brains. The agent form saves them in the provider-ops module (its fallback chain), not on the
 * agent row, so the owner's panel reads them there; without that module (or for a member) the agent row's own list
 * is shown. Read again whenever the agent changes (e.g. after an edit).
 */
function useBackup(agentId: string, owner: boolean, agent: AgentDTO | undefined): Chain {
  const [chain, setChain] = useState<{ id: string; fallback: Chain } | null>(null);
  useEffect(() => {
    if (!owner || !agent) return;
    let live = true;
    api<{ settings: { fallback: Chain } }>(`/api/m/provider-ops/agents/${encodeURIComponent(agentId)}`)
      .then((r) => live && setChain({ id: agentId, fallback: r.settings.fallback }))
      .catch(() => live && setChain(null));
    return () => {
      live = false;
    };
  }, [agentId, owner, agent]);
  return chain?.id === agentId ? chain.fallback : (agent?.fallback ?? []);
}

/** The details panel's inline main-brain picker (owner): the same brain cards and model list as the agent form. */
function BrainChange({ agent, onDone }: { agent: AgentDTO; onDone(): void }) {
  const { t } = useI18n();
  const providers = useStore((s) => s.providers);
  const [providerId, setProviderId] = useState(agent.providerId);
  const [model, setModel] = useState(agent.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await api<{ agent: AgentDTO }>(`/api/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: { providerId, model: model || null },
      });
      setState((s) => ({ agents: { ...s.agents, [r.agent.id]: r.agent } }));
      onDone();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" data-testid="details-brain-picker">
      <BrainCards
        providers={providers}
        value={providerId}
        onChange={(id) => {
          setProviderId(id);
          setModel('');
        }}
        label={t('agents.provider')}
        testId="brain-picker"
        keep={agent.providerId}
      />
      <ModelPicker
        providerId={providerId}
        value={model}
        onChange={setModel}
        autoDefault={providerId !== agent.providerId}
        testId="model-picker"
      />
      {error && (
        <p className="bk-field__error" role="alert">
          {t('errors.generic')}
        </p>
      )}
      <div className="row">
        <Button variant="primary" onClick={save} disabled={busy || !providerId}>
          {t('agents.save')}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t('core:common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** A model as its brain names it ("Opus", not `opus`); the id itself while the list loads or when it is not listed. */
function ModelName({ providerId, model, ask }: { providerId: string; model: string; ask: boolean }) {
  // only the owner may ask a brain for its models (members and guests read the id)
  const { list } = useModels(ask ? providerId : '');
  const label = list.state === 'ok' ? list.models.find((m) => m.id === model)?.label : undefined;
  return <>{label || model}</>;
}
