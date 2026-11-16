/**
 * Create or edit an agent. Up front: name, what it should help with (instructions, with tap-to-fill ideas) and the
 * brain. Everything else (model, backup brain, trust level, the computer-commands switch) sits under a closed
 * "More options" (Simplify FIRST-TIMER fixes 6-7). A brain that is not ready says why and links to the Brains page;
 * `?brain=<provider id>` preselects one.
 *
 * `first`: onboarding step 2 ("Meet your first agent") for the agent step 1 just made: its avatar (with shuffle), name,
 * "What should it help with?" with its ideas and the one-line trust note show; every other field folds under "More
 * options", and "Get me started" saves and opens its chat.
 */
import { PlainWords } from '@pasabot/i18n/react';
import { type AgentDTO, DEFAULT_AGENT_TRUST, type TrustLevel } from '@pasabot/protocol';
import { AgentAvatar, Button, Field, Icon } from '@pasabot/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { navigate, useRoute } from '../app/router.js';
import { live, loadChats, loadProviders, providerHint, setState, useStore } from '../app/store.js';
import { useWords } from '../app/words.js';
import { BrainCards, brainState, ModelPicker } from './BrainPicker.js';
import { TrustNote } from './TrustNote.js';

interface OpsEntry {
  providerId: string;
  model?: string;
  accountId?: string;
}
interface OpsAgent {
  agentId: string;
  fallback: OpsEntry[];
  accountId: string | null;
  compactPct: number | null;
  compactTokens: number | null;
}
/**
 * The backup brain is the first entry of the agent's fallback chain, kept by the provider-ops module. Without that
 * module (404) there is no backup picker.
 */
async function saveBackup(agentId: string, backup: string, model: string, prev: OpsAgent | null) {
  const rest = (prev?.fallback ?? []).slice(1).filter((f) => f.providerId !== backup);
  await api(`/api/m/provider-ops/agents/${agentId}`, {
    method: 'PUT',
    body: {
      fallback: backup ? [{ providerId: backup, ...(model ? { model } : {}) }, ...rest] : rest,
      accountId: prev?.accountId ?? null,
      compactPct: prev?.compactPct ?? null,
      compactTokens: prev?.compactTokens ?? null,
    },
  });
}

/** A fresh avatar salt (server accepts [A-Za-z0-9_-]{0,32}), never the current one. */
function newSalt(current: string): string {
  for (;;) {
    const s = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36);
    if (s !== current) return s;
  }
}

/** the ideas under "What should it help with?": a tap fills the box with the idea's sentence */
const HELP_IDEAS = ['week', 'shopping', 'messages', 'questions'] as const;

/**
 * The helper form speaks plain words while "Technical words" is off, as Settings does (W30/W40): it opens outside
 * Settings (New helper, Edit, onboarding), so it brings its own `<PlainWords>` scope ("New agent" reads "New helper").
 */
export function AgentForm(props: { agentId?: string; first?: { chatId: string } }) {
  const advanced = usePrefs((s) => s.advanced);
  return (
    <PlainWords on={!advanced}>
      <AgentFormBody {...props} />
    </PlainWords>
  );
}

function AgentFormBody({ agentId, first }: { agentId?: string; first?: { chatId: string } }) {
  const t = useT();
  const w = useWords();
  const existing = useStore((s) => (agentId ? s.agents[agentId] : undefined));
  const providers = useStore((s) => s.providers);
  const [name, setName] = useState(existing?.name ?? '');
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [providerId, setProviderId] = useState(existing?.providerId ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [trust, setTrust] = useState<TrustLevel>(existing?.trustLevel ?? DEFAULT_AGENT_TRUST);
  // "Ask before terminal and raw web commands" (7.1): null follows the trust level (off at trusted, on below)
  const [askShell, setAskShell] = useState<boolean | null>(existing?.askShellWeb ?? null);
  // generated avatar re-roll: seed = agent id + salt; previewed here, stored on Save
  const [salt, setSalt] = useState(existing?.avatarSalt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trustSel = useId();
  const asked = useRoute().query.get('brain');
  // null = no provider-ops module here (no backup picker); undefined = still loading
  const [ops, setOps] = useState<OpsAgent | null | undefined>(undefined);
  const [backup, setBackup] = useState('');
  const [backupModel, setBackupModel] = useState('');
  useEffect(() => {
    let gone = false;
    api<{ agents: OpsAgent[] }>('/api/m/provider-ops/settings')
      .then((r) => {
        if (gone) return;
        const mine = agentId ? (r.agents.find((a) => a.agentId === agentId) ?? null) : null;
        setOps(
          mine ?? {
            agentId: agentId ?? '',
            fallback: [],
            accountId: null,
            compactPct: null,
            compactTokens: null,
          },
        );
        setBackup(mine?.fallback[0]?.providerId ?? '');
        setBackupModel(mine?.fallback[0]?.model ?? '');
      })
      .catch(() => {
        if (!gone) setOps(null);
      });
    return () => {
      gone = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setInstructions(existing.instructions);
      setProviderId(existing.providerId);
      setModel(existing.model ?? '');
      setTrust(existing.trustLevel);
      setAskShell(existing.askShellWeb ?? null);
      setSalt(existing.avatarSalt ?? '');
    }
  }, [existing]);
  useEffect(() => {
    // a new agent starts at the owner's server default (the permissive level unless made stricter in Settings)
    if (agentId) return;
    let gone = false;
    api<{ defaultTrust: TrustLevel }>('/api/v1/settings/agent-trust')
      .then((r) => {
        if (!gone) setTrust(r.defaultTrust);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [agentId]);
  // brains installed since the app loaded (ACP registry) show up without a reload
  useEffect(() => {
    void loadProviders();
  }, []);
  useEffect(() => {
    if (!providerId && providers.length) {
      // "Use for a new agent" on the Brains page names the brain; else the first ready one (never Fake outside tests)
      const named = asked ? providers.find((p) => p.id === asked) : undefined;
      const ready =
        named ??
        providers.find((p) => brainState(p) === 'ready' && p.id !== 'fake') ??
        providers.find((p) => p.status.installed) ??
        providers[0]!;
      setProviderId(ready.id);
    }
  }, [providers, providerId, asked]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      name: name.trim(),
      // the built-in team builder's own prompt is never edited here (the server refuses it)
      ...(existing?.builtIn ? {} : { instructions }),
      providerId,
      model: model.trim() || null,
      trustLevel: trust,
      ...(agentId || askShell !== null ? { askShellWeb: askShell } : {}),
      ...(agentId ? { avatarSalt: salt } : {}),
    };
    try {
      if (agentId) {
        const r = await api<{ agent: AgentDTO }>(`/api/v1/agents/${agentId}`, { method: 'PATCH', body });
        setState((s) => ({ agents: { ...s.agents, [r.agent.id]: r.agent } }));
        // the agent is saved already: a backup that could not be saved never turns that into an error (as on create)
        if (
          ops &&
          (backup !== (ops.fallback[0]?.providerId ?? '') || backupModel !== (ops.fallback[0]?.model ?? ''))
        )
          await saveBackup(r.agent.id, backup, backupModel, ops).catch(() => {});
        if (first) {
          await loadChats();
          live.subscribe([`chat:${first.chatId}`, `agent:${r.agent.id}`]);
          navigate(`/chats/${first.chatId}`, true);
        } else history.back();
      } else {
        const r = await api<{ agent: AgentDTO; chatId: string }>('/api/v1/agents', { method: 'POST', body });
        setState((s) => ({ agents: { ...s.agents, [r.agent.id]: r.agent } }));
        if (ops && backup) await saveBackup(r.agent.id, backup, backupModel, null).catch(() => {});
        await loadChats();
        live.subscribe([`chat:${r.chatId}`, `agent:${r.agent.id}`]);
        navigate(`/chats/${r.chatId}`, true);
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'unknown_provider'
          ? t('agents.unknownProvider')
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const chosen = providers.find((p) => p.id === providerId);
  const help = (
    <div className="bk-field" data-testid="help-with">
      <Field
        multiline
        label={t('agents.helpWith')}
        hint={t('agents.instructionsHint')}
        placeholder={t('agents.helpPlaceholder')}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={4}
      />
      <div className="tap-chips" data-testid="help-ideas">
        {HELP_IDEAS.map((k) => (
          <Button key={k} size="sm" onClick={() => setInstructions(t(`agents.helpFill.${k}`))}>
            {t(`agents.helpIdeas.${k}`)}
          </Button>
        ))}
      </div>
    </div>
  );
  const brain = (
    <>
      <BrainCards
        providers={providers}
        value={providerId}
        onChange={(id) => {
          setProviderId(id);
          // a new brain starts on its own default (or its recommended model, once its list arrives)
          setModel('');
          // the backup is never the main brain (the picker hides it; a stale value would still be saved)
          if (backup === id) {
            setBackup('');
            setBackupModel('');
          }
        }}
        label={t('agents.provider')}
        testId="brain-picker"
        keep={existing?.providerId}
      />
      {chosen && providerHint(t, chosen) && <p className="bk-field__hint">{providerHint(t, chosen)}</p>}
      {providers.some((p) => brainState(p) !== 'ready') && (
        <a
          href="#/settings/agents/brains"
          data-testid="brains-setup-link"
          style={{ minBlockSize: 44, display: 'inline-flex', alignItems: 'center', justifySelf: 'start' }}
        >
          {t('agents.setUpBrains')}
        </a>
      )}
    </>
  );
  return (
    <div className="page">
      {first ? (
        <>
          <p className="muted onb-step" data-testid="onb-step">
            {t('onboarding.step', { n: 2, total: 2 })}
          </p>
          <h1>{t('onboarding.meetTitle')}</h1>
          <p className="muted">{t('onboarding.meetIntro')}</p>
        </>
      ) : (
        <h1>{agentId ? t('agents.editTitle', { name: existing?.name ?? '' }) : t('agents.newTitle')}</h1>
      )}
      <form className="bk-card panel stack" onSubmit={submit} data-testid={first ? 'onb-meet' : 'agent-form'}>
        {first && existing && (
          <div className="onb-who">
            <AgentAvatar
              agentId={existing.id}
              salt={salt}
              size={96}
              label={t('agents.avatarAlt', { name: name.trim() || existing.name })}
            />
            <Button
              onClick={() => setSalt(newSalt(salt))}
              data-testid="avatar-shuffle"
              style={{ minBlockSize: 44 }}
            >
              {t('agents.shuffle')}
            </Button>
          </div>
        )}
        {!first && agentId && existing && (
          <div className="bk-field" data-testid="avatar-field">
            <span className="bk-field__label">{t('agents.avatar')}</span>
            <div className="row">
              <AgentAvatar
                agentId={existing.id}
                salt={salt}
                size={96}
                label={t('agents.avatarAlt', { name: name.trim() || existing.name })}
              />
              <Button
                onClick={() => setSalt(newSalt(salt))}
                data-testid="avatar-shuffle"
                style={{ minBlockSize: 44 }}
              >
                {t('agents.shuffle')}
              </Button>
            </div>
            <span className="bk-field__hint">{t('agents.avatarHint')}</span>
          </div>
        )}
        <Field
          label={t('agents.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={60}
        />
        {/* the first agent starts at the owner's default (Trusted unless made stricter): step 2 says what that
            really means in one line, with the full note a tap away, never a stronger promise than the app keeps */}
        {first &&
          (trust === 'trusted' ? (
            <TrustNote testId="onb-safe" />
          ) : (
            <p className="row-ic muted" data-testid="onb-safe">
              <Icon name="shield" />
              <span>{t('onboarding.meetSafe', { name: name.trim() || existing?.name || '' })}</span>
            </p>
          ))}
        {!existing?.builtIn && help}
        {!first && brain}
        <details className="set-more agent-more" data-testid="agent-more">
          <summary data-testid="agent-more-toggle">{t('agents.moreOptions')}</summary>
          <div className="stack">
            {first && brain}
            <ModelPicker
              providerId={providerId}
              value={model}
              onChange={setModel}
              autoDefault={!agentId || providerId !== existing?.providerId}
              testId="model-picker"
            />
            {ops && (
              <>
                <BrainCards
                  providers={providers.filter((p) => brainState(p) === 'ready' || p.id === backup)}
                  value={backup}
                  onChange={(id) => {
                    setBackup(id);
                    setBackupModel('');
                  }}
                  label={t('agents.backup')}
                  testId="backup-picker"
                  exclude={providerId}
                  allowNone
                />
                <p className="bk-field__hint">{t('agents.backupHint')}</p>
                {backup && (
                  <ModelPicker
                    providerId={backup}
                    value={backupModel}
                    onChange={setBackupModel}
                    autoDefault={backup !== (ops.fallback[0]?.providerId ?? '')}
                    testId="backup-model-picker"
                  />
                )}
              </>
            )}
            <div className="bk-field">
              <label className="bk-field__label" htmlFor={trustSel}>
                {w('agents.trust')}
              </label>
              <select
                id={trustSel}
                data-testid="agent-trust"
                className="bk-input"
                value={trust}
                onChange={(e) => setTrust(e.target.value as TrustLevel)}
              >
                {(['guarded', 'standard', 'trusted'] as const).map((l) => (
                  <option key={l} value={l}>
                    {w(`agents.trustLevels.${l}`)}
                  </option>
                ))}
              </select>
              <span className="bk-field__hint">{w('agents.trustHint')}</span>
              {trust === 'trusted' && !first && <TrustNote />}
            </div>
            <div className="bk-field">
              <label className="always-asks__opt">
                <input
                  type="checkbox"
                  checked={askShell ?? trust !== 'trusted'}
                  onChange={(e) => setAskShell(e.target.checked)}
                  data-testid="ask-shell-web"
                />
                <span>{w('agents.askShellWeb')}</span>
              </label>
              <span className="bk-field__hint">{w('agents.askShellWebHint')}</span>
            </div>
          </div>
        </details>
        {error && (
          <p className="bk-field__error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !providerId} data-testid="agent-submit">
            {first ? t('onboarding.start') : agentId ? t('agents.save') : t('agents.create')}
          </Button>
          {!first && (
            <Button variant="ghost" onClick={() => history.back()}>
              {t('core:common.cancel')}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
