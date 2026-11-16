/**
 * W34 web: Settings → Local models. Shows Ollama / LM Studio found on this computer's usual ports, lets the owner
 * check and add an address (a local-network one with a warning), lists each endpoint's models with whether they can
 * use tools (chat only otherwise), and changes or removes an endpoint. Each endpoint is a brain agents and fallback
 * chains can pick (`local:<id>`).
 */
import type { WebModule } from '@pasabot/core/web';
import { documentLocale, localeInstances, localeResources } from '@pasabot/i18n';
import { usePlainScope } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';

const NS = 'local';
const RES = localeResources(NS, import.meta.glob('../locales/*.json', { eager: true, import: 'default' }));
const i18n = localeInstances(RES);
function useT() {
  const lang = documentLocale();
  const inst = i18n[lang];
  // Settings' plain words (Technical words off): `plain.<key>` when this provider ships one
  const plain = usePlainScope();
  return (k: string, o?: Record<string, unknown>) => {
    const p = `${NS}:plain.${k}`;
    return inst.t(plain && inst.exists(p) ? p : `${NS}:${k}`, o ?? {}) as string;
  };
}
const API = '/api/m/local';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const muted: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--bk-muted)' };
const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 };

type Api = 'ollama' | 'openai';
interface Endpoint {
  id: string;
  providerId: string;
  name: string;
  api: Api;
  url: string;
  scope: 'loopback' | 'lan';
  tools: 'auto' | 'off';
  warning?: 'lan';
}
interface Model {
  id: string;
  tools: boolean | null;
}
interface Probe {
  reachable: boolean;
  models: Model[];
  error?: string;
}

function Select({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  options: [string, string][];
  testId?: string;
}) {
  return (
    <label className="bk-field">
      <span className="bk-field__label">{label}</span>
      <select
        className="bk-input"
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        style={{ minHeight: 44, maxWidth: '100%' }}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModelList({ probe }: { probe: Probe | null }) {
  const t = useT();
  if (!probe) return <p style={muted}>{t('models.loading')}</p>;
  if (!probe.reachable) return <p style={muted}>{t('models.unreachable')}</p>;
  if (!probe.models.length) return <p style={muted}>{t('models.none')}</p>;
  return (
    <ul style={{ display: 'grid', gap: 8, padding: 0, margin: 0, listStyle: 'none' }}>
      {probe.models.map((m) => (
        <li
          key={m.id}
          data-local-model={m.id}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minHeight: 32 }}
        >
          <code style={{ ...wrap, fontSize: 14 }}>{m.id}</code>
          {m.tools === false ? (
            <Badge data-testid="local-tools-off">{t('models.chatOnly')}</Badge>
          ) : m.tools ? (
            <Badge>{t('models.tools')}</Badge>
          ) : (
            <Badge>{t('models.toolsTry')}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function EndpointCard({ ep, onChange }: { ep: Endpoint; onChange(): void }) {
  const t = useT();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => {
    setProbe(null);
    call<Probe>(`${API}/endpoints/${encodeURIComponent(ep.id)}/models`)
      .then(setProbe)
      .catch(() => setProbe({ reachable: false, models: [] }));
  }, [ep.id]);
  useEffect(load, [load]);
  const act = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card as="section" data-local-endpoint={ep.name} style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h3 style={{ margin: 0, ...wrap }}>{ep.name}</h3>
        <Badge>{ep.api === 'ollama' ? t('api.ollama') : t('api.openai')}</Badge>
        <Badge>{ep.scope === 'lan' ? t('scope.lan') : t('scope.loopback')}</Badge>
      </div>
      <code style={{ ...wrap, fontSize: 14 }}>{ep.url}</code>
      {ep.warning === 'lan' && (
        <p
          role="note"
          data-testid="local-lan-warning"
          style={{ ...muted, color: 'var(--bk-warn, var(--bk-muted))' }}
        >
          {t('warning.lan')}
        </p>
      )}
      <ModelList probe={probe} />
      <Select
        label={t('tools.label')}
        value={ep.tools}
        testId="local-tools-mode"
        onChange={(v) => void act(() => call(`${API}/endpoints/${ep.id}`, json('PATCH', { tools: v })))}
        options={[
          ['auto', t('tools.auto')],
          ['off', t('tools.off')],
        ]}
      />
      <p style={muted}>{t('use', { id: ep.providerId })}</p>
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="secondary" onClick={load}>
          {t('refresh')}
        </Button>
        {confirm ? (
          <>
            <Button
              variant="danger"
              onClick={() => void act(() => call(`${API}/endpoints/${ep.id}`, json('DELETE')))}
            >
              {t('remove.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t('remove.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirm(true)}>
            {t('remove.button')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function AddForm({
  onAdded,
  preset,
}: {
  onAdded(): void;
  preset: { api: Api; url: string; name: string } | null;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [api, setApi] = useState<Api>('ollama');
  const [url, setUrl] = useState('');
  const [check, setCheck] = useState<(Probe & { url: string; warning?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!preset) return;
    setName(preset.name);
    setApi(preset.api);
    setUrl(preset.url);
    setCheck(null);
  }, [preset]);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="section" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <h3 style={{ margin: 0 }}>{t('add.title')}</h3>
      <form
        style={{ display: 'grid', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call(`${API}/endpoints`, json('POST', { name, api, url }));
            setName('');
            setUrl('');
            setCheck(null);
            onAdded();
          });
        }}
      >
        <Field
          label={t('add.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
        />
        <Select
          label={t('add.api')}
          value={api}
          onChange={(v) => {
            setApi(v as Api);
            setCheck(null);
          }}
          options={[
            ['ollama', t('api.ollama')],
            ['openai', t('api.openai')],
          ]}
        />
        <Field
          label={t('add.url')}
          hint={t('add.urlHint')}
          value={url}
          inputMode="url"
          onChange={(e) => {
            setUrl(e.target.value);
            setCheck(null);
          }}
          required
        />
        {check && (
          <div data-testid="local-check" style={{ display: 'grid', gap: 8 }}>
            <p style={muted}>
              {check.reachable ? t('add.reachable', { count: check.models.length }) : t('models.unreachable')}
            </p>
            {check.warning === 'lan' && (
              <p role="note" data-testid="local-lan-warning" style={muted}>
                {t('warning.lan')}
              </p>
            )}
          </div>
        )}
        {err && (
          <p role="alert" className="bk-field__error" style={wrap}>
            {err}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !url.trim()}
            onClick={() =>
              void run(async () => setCheck(await call(`${API}/check`, json('POST', { api, url }))))
            }
          >
            {t('add.check')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim() || !name.trim()}>
            {t('add.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function LocalModelsSettings() {
  const t = useT();
  const [eps, setEps] = useState<Endpoint[] | null>(null);
  const [found, setFound] = useState<{ name: string; api: Api; url: string; models: number }[]>([]);
  const [preset, setPreset] = useState<{ api: Api; url: string; name: string } | null>(null);
  const load = useCallback(() => {
    call<{ endpoints: Endpoint[] }>(`${API}/endpoints`)
      .then((r) => setEps(r.endpoints))
      .catch(() => setEps([]));
    call<{ found: typeof found }>(`${API}/detect`)
      .then((r) => setFound(r.found))
      .catch(() => setFound([]));
  }, []);
  useEffect(load, [load]);
  if (!eps) return null;
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }} data-local-settings>
      <p style={muted}>{t('intro')}</p>
      {found.map((f) => (
        <Card key={f.url} data-testid="local-found" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <p style={{ margin: 0, ...wrap }}>
            {t('found.text', { name: f.name, url: f.url, count: f.models })}
          </p>
          <div>
            <Button variant="secondary" onClick={() => setPreset({ ...f })}>
              {t('found.use')}
            </Button>
          </div>
        </Card>
      ))}
      {eps.length === 0 && <p style={muted}>{t('empty')}</p>}
      {eps.map((ep) => (
        <EndpointCard key={ep.id} ep={ep} onChange={load} />
      ))}
      <AddForm onAdded={load} preset={preset} />
      <p style={muted}>{t('offlineHint')}</p>
    </div>
  );
}

const mod: WebModule = {
  id: NS,
  settingsSections: [
    {
      id: NS,
      labelKey: `${NS}:title`,
      hintKey: 'local:find.settingsHint',
      keywordsKey: 'local:find.settingsKeywords',
      component: LocalModelsSettings,
      order: 125,
      icon: 'brain',
      group: 'agents',
      optional: false,
    },
  ],
};
export default mod;
