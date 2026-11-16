/**
 * W14 web: Settings → Vault. Agents' key requests (fill with a value or a password-manager reference, or decline),
 * the saved secrets (names and who may use them, never values; write-only inputs), Bitwarden / 1Password session
 * keys with a Test button, and the only vault-key rotation in the product.
 */

import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { Badge, Button, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n.js';

type Backend = 'bitwarden' | '1password';
type Source = 'local' | Backend;
interface Secret {
  id: string;
  name: string;
  kind: 'global' | 'agent' | 'brain';
  agentId: string | null;
  agentName: string | null;
  brainName?: string | null;
  backend: string;
  reference: string | null;
}
interface Request {
  id: string;
  agentId: string;
  agentName: string | null;
  name: string;
  reason: string;
  untrusted: boolean;
}
interface Overview {
  available: boolean;
  secrets: Secret[];
  moduleEntries: number;
  requests: Request[];
  agents: { id: string; name: string }[];
  /** brains that take an API key ("Key for <brain>"; agents on that brain can see it) */
  brains?: { id: string; name: string; keys: string[] }[];
  backends: { id: Backend; sessionSet: boolean; disabled?: 'unsafe_bin' | null }[];
  lastRotatedAt: number | null;
}

const base = '/api/m/vault';
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? `HTTP ${r.status}`);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}
const wrap = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const, minWidth: 0 };
const muted = { margin: 0, fontSize: 14, color: 'var(--bk-muted)', ...wrap };
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, alignItems: 'center' };
const box = {
  border: '1px solid var(--bk-line, rgba(127,127,127,.3))',
  borderRadius: 12,
  padding: 12,
  display: 'grid',
  gap: 8,
  minWidth: 0,
};
const tap = { minHeight: 44 };
const EXAMPLE = '{{secret:NAME}}';

function Select(p: { label: string; value: string; onChange(v: string): void; options: [string, string][] }) {
  return (
    <label className="bk-field">
      <span className="bk-field__label">{p.label}</span>
      <select
        className="bk-input"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        style={{ minHeight: 44, maxWidth: '100%' }}
      >
        {p.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A value, or a Bitwarden / 1Password reference: what fills a request or a new secret. */
function SourceInputs(p: {
  source: Source;
  setSource(s: Source): void;
  text: string;
  setText(s: string): void;
}) {
  const t = useT();
  return (
    <>
      <Select
        label={t('add.source')}
        value={p.source}
        onChange={(v) => p.setSource(v as Source)}
        options={(['local', 'bitwarden', '1password'] as const).map((s) => [s, t(`add.source_${s}`)])}
      />
      {p.source === 'local' ? (
        <Field
          label={t('add.value')}
          hint={t('add.valueHint')}
          type="password"
          autoComplete="off"
          value={p.text}
          onChange={(e: { target: { value: string } }) => p.setText(e.target.value)}
        />
      ) : (
        <Field
          label={t(`add.ref_${p.source}`)}
          hint={t(`add.refHint_${p.source}`)}
          autoComplete="off"
          spellCheck={false}
          value={p.text}
          onChange={(e: { target: { value: string } }) => p.setText(e.target.value)}
        />
      )}
    </>
  );
}
const sourceBody = (source: Source, text: string) =>
  source === 'local' ? { value: text } : { backend: source, ref: text.trim() };

function RequestCard({ r, onDone }: { r: Request; onDone(msg: string): void }) {
  const t = useT();
  const [source, setSource] = useState<Source>('local');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const agent = r.agentName ?? r.agentId;
  const fill = async () => {
    setErr(null);
    try {
      const res = await call<{ reference: string }>(
        'POST',
        `/requests/${r.id}/fill`,
        sourceBody(source, text),
      );
      onDone(t('requests.filled', { agent, reference: res.reference }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div style={box} data-testid="vault-request">
      <strong style={wrap}>{t('requests.asks', { agent, name: r.name })}</strong>
      {r.reason && <p style={muted}>“{r.reason}”</p>}
      {r.untrusted && (
        <p role="note" style={{ ...muted, color: 'var(--bk-danger, #b42318)' }}>
          {t('requests.untrusted')}
        </p>
      )}
      <SourceInputs source={source} setSource={setSource} text={text} setText={setText} />
      {err && (
        <p role="alert" style={muted}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button variant="primary" style={tap} disabled={!text.trim()} onClick={fill}>
          {t('requests.fill')}
        </Button>
        <Button
          variant="ghost"
          style={tap}
          onClick={async () => {
            await call('POST', `/requests/${r.id}/decline`).catch(() => {});
            onDone(t('requests.declined'));
          }}
        >
          {t('requests.decline')}
        </Button>
      </div>
    </div>
  );
}

function AddSecret({
  agents,
  brains = [],
  onDone,
}: {
  agents: Overview['agents'];
  brains?: Overview['brains'];
  onDone(msg: string): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState(agents[0]?.id ?? 'global');
  const [source, setSource] = useState<Source>('local');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!open)
    return (
      <Button style={tap} onClick={() => setOpen(true)}>
        {t('add.open')}
      </Button>
    );
  const save = async () => {
    setErr(null);
    try {
      await call('POST', '/secrets', { target, name: name.trim(), ...sourceBody(source, text) });
      setOpen(false);
      setName('');
      setText('');
      onDone(t('add.saved', { name: name.trim() }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form
      style={box}
      aria-label={t('add.title')}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <strong>{t('add.title')}</strong>
      <Field
        label={t('add.name')}
        hint={t('add.nameHint', { example: EXAMPLE })}
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(e: { target: { value: string } }) => setName(e.target.value)}
      />
      <Select
        label={t('add.who')}
        value={target}
        onChange={setTarget}
        options={[
          ...agents.map((a) => [a.id, a.name] as [string, string]),
          ['global', t('add.shared')],
          ...(brains ?? []).map(
            (b) => [`brain:${b.id}`, t('add.brainOption', { brain: b.name })] as [string, string],
          ),
        ]}
      />
      {target.startsWith('brain:') && (
        <p style={muted}>
          {t('secrets.forBrain', { brain: brains?.find((b) => `brain:${b.id}` === target)?.name ?? '' })}
        </p>
      )}
      <SourceInputs source={source} setSource={setSource} text={text} setText={setText} />
      {err && (
        <p role="alert" style={muted}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button type="submit" variant="primary" style={tap} disabled={!name.trim() || !text.trim()}>
          {t('add.save')}
        </Button>
        <Button variant="ghost" style={tap} onClick={() => setOpen(false)}>
          {t('add.cancel')}
        </Button>
      </div>
    </form>
  );
}

function BackendRow({ b, onDone }: { b: Overview['backends'][number]; onDone(msg: string): void }) {
  const t = useT();
  const [token, setToken] = useState('');
  // a backend turned off at boot (its CLI could be swapped by the server's user) says so before any Test
  const [state, setState] = useState<string | null>(b.disabled ?? null);
  return (
    <div style={box} data-testid={`vault-backend-${b.id}`}>
      <div style={row}>
        <strong>{t(`backends.${b.id}`)}</strong>
        <Badge tone={b.sessionSet ? 'primary' : 'outline'}>
          {t(b.sessionSet ? 'backends.set' : 'backends.notSet')}
        </Badge>
        {state && (
          <Badge tone={state === 'ready' ? 'primary' : 'signal'}>{t(`backends.state_${state}`)}</Badge>
        )}
      </div>
      {state === 'unsafe_bin' && (
        <p role="note" style={muted}>
          {t('backends.unsafeHint')}
        </p>
      )}
      <Field
        label={t(`backends.token_${b.id}`)}
        hint={t('backends.tokenHint')}
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e: { target: { value: string } }) => setToken(e.target.value)}
      />
      <div style={row}>
        <Button
          style={tap}
          onClick={async () => {
            await call('PUT', `/backends/${b.id}/session`, { token });
            setToken('');
            onDone(t(token ? 'backends.set' : 'backends.notSet'));
          }}
        >
          {t('backends.save')}
        </Button>
        <Button
          variant="ghost"
          style={tap}
          onClick={async () =>
            setState(
              (
                await call<{ state: string }>('POST', `/backends/${b.id}/test`).catch(() => ({
                  state: 'error',
                }))
              ).state,
            )
          }
        >
          {t('backends.test')}
        </Button>
      </div>
    </div>
  );
}

function Rotate({ last, onDone }: { last: number | null; onDone(msg: string): void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div style={box}>
      <strong>{t('rotate.title')}</strong>
      <p style={muted}>{t('rotate.intro')}</p>
      {last && (
        <p style={muted}>{t('rotate.last', { when: new Date(last).toLocaleString(displayLocale()) })}</p>
      )}
      {asking ? (
        <fieldset style={{ display: 'grid', gap: 8, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend style={{ ...muted, color: 'inherit', padding: 0 }}>{t('rotate.confirm')}</legend>
          <div style={row}>
            <Button
              variant="danger"
              style={tap}
              onClick={async () => {
                setErr(null);
                try {
                  const r = await call<{ rotated: number }>('POST', '/rotate', { confirm: true });
                  setAsking(false);
                  onDone(t('rotate.done', { count: r.rotated }));
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              {t('rotate.yes')}
            </Button>
            <Button variant="ghost" style={tap} onClick={() => setAsking(false)}>
              {t('rotate.cancel')}
            </Button>
          </div>
        </fieldset>
      ) : (
        <div style={row}>
          <Button variant="danger" style={tap} onClick={() => setAsking(true)}>
            {t('rotate.button')}
          </Button>
        </div>
      )}
      {err && (
        <p role="alert" style={muted}>
          {err}
        </p>
      )}
    </div>
  );
}

export function VaultSettings() {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await call<Overview>('GET', '/overview'));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const done = (m: string) => {
    setMsg(m);
    void load();
  };
  if (err) return <p style={muted}>{t('error', { reason: err })}</p>;
  if (!data) return <p style={muted}>{t('loading')}</p>;
  return (
    <section
      aria-labelledby="vault-title"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
      data-testid="vault"
    >
      {/* the Settings page above already names it in its own heading: this one only labels the section (W40) */}
      <h3 id="vault-title" className="bk-visually-hidden">
        {t('title')}
      </h3>
      <p style={muted}>{t('intro', { example: EXAMPLE })}</p>
      {!data.available && (
        <p role="alert" style={muted}>
          {t('unavailable')}
        </p>
      )}
      {msg && (
        <p role="status" style={{ ...muted, color: 'inherit' }}>
          {msg}
        </p>
      )}
      {data.requests.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <h4 style={{ margin: 0 }}>{t('requests.title')}</h4>
          {data.requests.map((r) => (
            <RequestCard key={r.id} r={r} onDone={done} />
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 8 }}>
        <h4 style={{ margin: 0 }}>{t('secrets.title')}</h4>
        {data.secrets.length === 0 && <p style={muted}>{t('secrets.empty')}</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {data.secrets.map((s) => (
            <li key={s.id} style={box} data-testid="vault-secret">
              <div style={row}>
                <strong style={wrap}>{s.name}</strong>
                <Badge tone="outline">{t(`secrets.backend_${s.backend}`)}</Badge>
              </div>
              <p style={muted}>
                {s.kind === 'global'
                  ? t('secrets.shared')
                  : s.kind === 'brain'
                    ? t('secrets.forBrain', { brain: s.brainName ?? '' })
                    : t('secrets.for', { agent: s.agentName ?? s.agentId })}
                {s.reference ? ` · ${s.reference}` : ''}
              </p>
              <div style={row}>
                <Button
                  variant="ghost"
                  style={tap}
                  aria-label={`${t('secrets.remove')} ${s.name}`}
                  onClick={async () => {
                    if (!window.confirm(t('secrets.confirmRemove', { name: s.name }))) return;
                    await call('DELETE', `/secrets/${s.id}`).catch(() => {});
                    void load();
                  }}
                >
                  {t('secrets.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {data.moduleEntries > 0 && <p style={muted}>{t('secrets.module', { count: data.moduleEntries })}</p>}
        <AddSecret agents={data.agents} brains={data.brains} onDone={done} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <h4 style={{ margin: 0 }}>{t('backends.title')}</h4>
        <p style={muted}>{t('backends.intro')}</p>
        {data.backends.map((b) => (
          <BackendRow key={b.id} b={b} onDone={done} />
        ))}
      </div>
      <Rotate last={data.lastRotatedAt} onDone={done} />
    </section>
  );
}

export default {
  id: 'vault',
  settingsSections: [
    {
      id: 'vault',
      labelKey: 'vault:title',
      hintKey: 'vault:find.settingsHint',
      keywordsKey: 'vault:find.settingsKeywords',
      component: VaultSettings,
      order: 20,
      icon: 'lock',
      group: 'safety',
      optional: false,
    },
  ],
} satisfies WebModule;
