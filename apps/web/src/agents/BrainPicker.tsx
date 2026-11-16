/**
 * The brain picker (Simplify: model picker). Brain = radio cards (icon tile, name, state), ready ones first; a
 * brain that is not ready is dimmed and offers its one action (the Brains page). Under the chosen brain, Model =
 * the models that brain offers right now (asked from the provider itself, `GET /api/v1/providers/:id/models`), each
 * a row with a plain hint and a tick on the chosen one. "Automatic" (the brain's own default) is always first; a
 * brain that recommends a model gets it ticked on a new agent, so a first-timer never has to choose.
 */
import { BrandTile, Button, Icon } from '@pasabot/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { type ProviderInfo, providerName } from '../app/store.js';
import { useWords } from '../app/words.js';

export type BrainState = 'ready' | 'needsSignIn' | 'notInstalled' | 'notReachable';
/** the Brains page's states (SPEC "Simplify" §5.1) from what `GET /api/v1/providers` reports */
export function brainState(p: ProviderInfo): BrainState {
  if (p.status.reachable === false) return 'notReachable';
  if (!p.status.installed) return 'notInstalled';
  if (p.status.signedIn === false) return 'needsSignIn';
  return 'ready';
}
/** ready brains first, the rest after, each group in the server's order */
export function sortBrains(list: ProviderInfo[]): ProviderInfo[] {
  return [...list.filter((p) => brainState(p) === 'ready'), ...list.filter((p) => brainState(p) !== 'ready')];
}

/** A brain's icon tile (polish B: its mark, never letters); `local-ollama` and `acp:foo` take their family's mark. */
export function BrainTile({ id, size = 40 }: { id: string; size?: number }) {
  return <BrandTile id={id} size={size} fallback="brain" className="brain-tile" />;
}

export interface ModelRow {
  id: string;
  label?: string;
  hint?: 'fast' | 'balanced' | 'smart' | 'smartest' | 'free';
  recommended?: boolean;
  curated?: boolean;
}
type ModelList =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error' }
  | { state: 'ok'; models: ModelRow[]; curated: boolean };

/** The brain's model list, fresh from the server (which keeps it a few minutes); `reload` asks the provider anew. */
export function useModels(providerId: string) {
  const [list, setList] = useState<ModelList>({ state: 'loading' });
  const gen = useRef(0);
  const load = useCallback(
    (refresh = false) => {
      if (!providerId) return;
      const mine = ++gen.current;
      setList({ state: 'loading' });
      api<{ models: ModelRow[]; listed: boolean; error?: string }>(
        `/api/v1/providers/${encodeURIComponent(providerId)}/models${refresh ? '?refresh=1' : ''}`,
      )
        .then((r) => {
          if (mine !== gen.current) return;
          if (r.error) setList({ state: 'error' });
          else if (!r.listed) setList({ state: 'none' });
          else setList({ state: 'ok', models: r.models, curated: r.models.some((m) => m.curated) });
        })
        .catch(() => {
          if (mine === gen.current) setList({ state: 'error' });
        });
    },
    [providerId],
  );
  useEffect(() => load(), [load]);
  return { list, reload: () => load(true) };
}

/** The brain radio cards. `allowNone` adds a "None" card first (the backup brain). */
export function BrainCards({
  providers,
  value,
  onChange,
  label,
  testId,
  keep,
  exclude,
  allowNone,
}: {
  providers: ProviderInfo[];
  value: string;
  onChange(id: string): void;
  label: string;
  testId: string;
  /** a brain the agent already runs on stays selectable even when it is not ready now */
  keep?: string;
  /** a brain not offered here (the main brain in the backup picker) */
  exclude?: string;
  allowNone?: boolean;
}) {
  const t = useT();
  const name = useId();
  const head = useId();
  const list = sortBrains(providers.filter((p) => p.id !== exclude));
  return (
    <div className="bk-field">
      <span className="bk-field__label" id={head}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={head} className="brain-cards" data-testid={testId}>
        {allowNone && (
          <label className="brain-card" data-testid="brain-option-none" data-on={value === '' || undefined}>
            <input
              type="radio"
              className="bk-visually-hidden"
              name={name}
              value=""
              checked={value === ''}
              onChange={() => onChange('')}
            />
            <span className="brain-tile brain-tile--none" aria-hidden="true">
              <Icon name="close" size={18} />
            </span>
            <span className="grow">
              <span className="brain-card__name">{t('agents.backupNone')}</span>
            </span>
            {value === '' && <Icon name="check-circle" size={20} />}
          </label>
        )}
        {list.map((p) => {
          const st = brainState(p);
          const disabled = (st === 'notInstalled' || st === 'notReachable') && p.id !== keep;
          const on = value === p.id;
          const stateId = `${name}-${p.id}-state`;
          const fixId = `${name}-${p.id}-fix`;
          return (
            <div key={p.id} className="brain-card-wrap">
              <label
                className="brain-card"
                data-testid={`brain-option-${p.id}`}
                data-on={on || undefined}
                data-dim={st !== 'ready' || undefined}
                aria-disabled={disabled || undefined}
              >
                {/* a brain that cannot be picked yet stays in the Tab and arrow order (never `disabled`), so a
                    keyboard or screen-reader user hears why and that a set-up link sits right after it */}
                <input
                  type="radio"
                  className="bk-visually-hidden"
                  name={name}
                  value={p.id}
                  checked={on}
                  aria-disabled={disabled || undefined}
                  aria-describedby={st !== 'ready' ? `${stateId} ${fixId}` : stateId}
                  onChange={() => {
                    if (!disabled) onChange(p.id);
                  }}
                />
                <BrainTile id={p.id} />
                <span className="grow">
                  <span className="brain-card__name">{providerName(t, p)}</span>
                  <span className="brain-card__state" id={stateId}>
                    {st === 'ready' ? t('agents.brainReady') : t(`agents.${st}`)}
                  </span>
                </span>
                {on && <Icon name="check-circle" size={20} />}
              </label>
              {st !== 'ready' && (
                <a
                  className="brain-card__fix"
                  id={fixId}
                  href={`#/settings/agents/brains?brain=${encodeURIComponent(p.id)}`}
                >
                  {t(
                    st === 'notInstalled'
                      ? 'agents.fixInstall'
                      : st === 'needsSignIn'
                        ? 'agents.fixSignIn'
                        : 'agents.fixCheck',
                  )}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The model rows for one brain. `value` '' = Automatic. `autoDefault`: tick the brain's recommended model once its
 * list arrives (a new agent, or a brain just switched to), unless something is ticked already.
 */
export function ModelPicker({
  providerId,
  value,
  onChange,
  autoDefault,
  testId,
}: {
  providerId: string;
  value: string;
  onChange(model: string): void;
  autoDefault: boolean;
  testId: string;
}) {
  const t = useT();
  const w = useWords();
  const head = useId();
  const name = useId();
  const { list, reload } = useModels(providerId);
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!autoDefault || list.state !== 'ok' || applied.current === providerId) return;
    applied.current = providerId;
    const rec = list.models.find((m) => m.recommended);
    if (rec && value === '') onChange(rec.id);
  }, [autoDefault, list, providerId, value, onChange]);
  if (!providerId) return null;
  const models = list.state === 'ok' ? list.models : [];
  // a model the agent already runs on that the list does not (or no longer) offer stays visible and ticked
  const rows: ModelRow[] = value && !models.some((m) => m.id === value) ? [...models, { id: value }] : models;
  const row = (id: string, label: string, hint: string | null) => {
    const on = value === id;
    return (
      <label
        key={id || 'auto'}
        className="model-row"
        data-on={on || undefined}
        data-testid={`model-option-${id || 'auto'}`}
      >
        <input
          type="radio"
          className="bk-visually-hidden"
          name={name}
          value={id}
          checked={on}
          onChange={() => onChange(id)}
        />
        <span className="grow">
          <span className="model-row__name">{label}</span>
          {hint && <span className="model-row__hint">{hint}</span>}
        </span>
        {on ? <Icon name="check-circle" size={20} /> : <span className="model-row__off" aria-hidden="true" />}
      </label>
    );
  };
  return (
    <div className="bk-field" data-testid={testId}>
      <div className="model-head">
        <span className="bk-field__label" id={head}>
          {w('agents.model')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={reload}
          aria-label={w('agents.modelsRefresh')}
          data-testid="models-refresh"
          disabled={list.state === 'loading'}
        >
          <Icon name="refresh" size={18} />
        </Button>
      </div>
      <div role="radiogroup" aria-labelledby={head} className="model-rows">
        {row('', t('agents.modelAuto'), t('agents.modelAutoHint'))}
        {rows.map((m) => row(m.id, m.label ?? m.id, m.hint ? t(`agents.modelHints.${m.hint}`) : null))}
      </div>
      {list.state === 'loading' && (
        <span className="bk-field__hint" role="status">
          {t('agents.modelsLoading')}
        </span>
      )}
      {list.state === 'error' && (
        <span className="bk-field__hint" role="alert" data-testid="models-error">
          {w('agents.modelsError')}
        </span>
      )}
      {list.state === 'ok' && list.curated && (
        <span className="bk-field__hint">{t('agents.modelsCurated')}</span>
      )}
    </div>
  );
}
