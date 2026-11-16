/**
 * W4b web: Settings → Channels. Add/remove a binding (secret fields are write-only), link the owner's account by a
 * one-time code, see each binding's status, allowed senders, routed agent and chats. W5: several secret fields
 * (Slack), the Events URL for push platforms, settings such as WhatsApp's own-number mode, and the WhatsApp QR link
 * flow, which starts only after the owner accepts the terms-of-service / ban-risk notice.
 */

import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { Badge, BrandTile, Button, Card, Field, safeImageSrc } from '@pasabot/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { useW as useT } from './i18n.js';

interface Binding {
  id: string;
  kind: string;
  label: string;
  agentId: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastEventAt: number | null;
  dropped: number;
  allowedSenders: string[];
  secretsSet: string[];
  options?: Record<string, string | boolean>;
  owner: { externalUserId: string; name: string; linkedAt: number } | null;
  places: { id: string; title: string; kind: string; chatId: string | null }[];
  available: boolean;
}
interface Kind {
  kind: string;
  secretFields: string[];
  options?: Record<string, 'boolean' | 'string'>;
  pairing?: boolean;
  inboundHttp?: boolean;
}
interface Pairing {
  state: 'idle' | 'waiting' | 'linked' | 'error';
  qrSvg: string | null;
  error: string | null;
}
interface Agent {
  id: string;
  name: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
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
const base = '/api/m/channels';
const wrap = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const, minWidth: 0 };
const muted = { margin: 0, fontSize: 14, color: 'var(--bk-muted)', ...wrap };
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, alignItems: 'center' };
const parseIds = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  options: [string, string][];
}) {
  return (
    <label className="bk-field">
      <span className="bk-field__label">{label}</span>
      <select
        className="bk-input"
        value={value}
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

function AddForm({
  kinds,
  agents,
  onDone,
  onCancel,
}: {
  kinds: Kind[];
  agents: Agent[];
  onDone(): void;
  onCancel(): void;
}) {
  const t = useT();
  const group = useId();
  const [kind, setKind] = useState(kinds[0]?.kind ?? '');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState<Record<string, boolean>>({});
  const [allowed, setAllowed] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const k = kinds.find((x) => x.kind === kind);
  const fields = k?.secretFields ?? [];
  const boolOptions = Object.entries(k?.options ?? {})
    .filter(([, type]) => type === 'boolean')
    .map(([name]) => name);
  const missing = fields.some((f) => !(secrets[f] ?? '').trim());
  if (!kinds.length) return <p style={muted}>{t('add.noKinds')}</p>;
  if (!agents.length) return <p style={muted}>{t('add.noAgents')}</p>;
  return (
    <form
      data-testid="channel-add-form"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await call('POST', `${base}/bindings`, {
            kind,
            agentId,
            label: label.trim() || undefined,
            secrets: Object.fromEntries(fields.map((f) => [f, (secrets[f] ?? '').trim()])),
            options: Object.fromEntries(boolOptions.map((o) => [o, !!opts[o]])),
            allowedSenders: parseIds(allowed),
          });
          setSecrets({});
          onDone();
        } catch (x) {
          setErr(x instanceof Error ? x.message : String(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>{t('add.title')}</strong>
      {/* the chat apps as their own marks to tap (a radio each), not a list to open */}
      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'grid', gap: 8 }}>
        <legend className="bk-field__label" style={{ padding: 0, marginBlockEnd: 8 }}>
          {t('add.kind')}
        </legend>
        <div
          data-testid="channel-kinds"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(136px, 1fr))',
            gap: 8,
            minWidth: 0,
          }}
        >
          {kinds.map((x) => {
            const on = x.kind === kind;
            return (
              <label
                key={x.kind}
                className="bk-choice-tile"
                data-on={on || undefined}
                data-testid={`channel-kind-${x.kind}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minBlockSize: 56,
                  padding: '8px 12px',
                  borderRadius: 14,
                  cursor: 'pointer',
                  background: on
                    ? 'color-mix(in srgb, var(--bk-primary) 12%, var(--bk-panel))'
                    : 'var(--bk-panel)',
                  boxShadow: on ? 'inset 0 0 0 2px var(--bk-primary)' : 'inset 0 0 0 1px var(--bk-line)',
                  minWidth: 0,
                }}
              >
                <input
                  type="radio"
                  className="bk-visually-hidden"
                  name={group}
                  value={x.kind}
                  checked={on}
                  onChange={() => setKind(x.kind)}
                />
                <BrandTile id={x.kind} size={36} fallback="channels" />
                <span style={{ fontWeight: 600, ...wrap }}>
                  {t(`kind.${x.kind}`, { defaultValue: x.kind })}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <Select
        label={t('add.agent')}
        value={agentId}
        onChange={setAgentId}
        options={agents.map((a) => [a.id, a.name])}
      />
      <Field
        label={t('add.label')}
        hint={t('add.labelHint')}
        value={label}
        maxLength={80}
        onChange={(e) => setLabel(e.currentTarget.value)}
      />
      {fields.map((f) => (
        <Field
          key={f}
          label={t(`field.${f}`, { defaultValue: t('add.token') })}
          hint={t('add.tokenHint')}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={secrets[f] ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setSecrets((x) => ({ ...x, [f]: v }));
          }}
        />
      ))}
      {boolOptions.map((o) => (
        <Select
          key={o}
          label={t(`option.${o}.label`, { defaultValue: o })}
          value={opts[o] ? 'on' : 'off'}
          onChange={(v) => setOpts((x) => ({ ...x, [o]: v === 'on' }))}
          options={[
            ['off', t(`option.${o}.off`, { defaultValue: 'off' })],
            ['on', t(`option.${o}.on`, { defaultValue: 'on' })],
          ]}
        />
      ))}
      {k?.pairing && <p style={muted}>{t('add.pairingNext')}</p>}
      <Field
        multiline
        label={t('add.allowed')}
        hint={t('add.allowedHint')}
        rows={2}
        value={allowed}
        onChange={(e) => setAllowed(e.currentTarget.value)}
      />
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button variant="primary" type="submit" disabled={busy || missing}>
          {t('add.submit')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('add.cancel')}
        </Button>
      </div>
    </form>
  );
}

function LinkCode({ bindingId }: { bindingId: string }) {
  const t = useT();
  const [code, setCode] = useState<{ command: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const make = async () => {
    try {
      setCopied(false);
      setCode(
        await call<{ command: string; expiresAt: number }>('POST', `${base}/bindings/${bindingId}/link`),
      );
      setErr(null);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      {code && (
        <div role="status" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
          <span style={muted}>{t('link.how')}</span>
          <div style={row}>
            <code data-testid="channel-link-code" style={{ fontSize: 16, ...wrap }}>
              {code.command}
            </code>
            <Button
              size="sm"
              style={{ minHeight: 44 }}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(code.command)
                  .then(() => setCopied(true))
                  .catch(() => {})
              }
            >
              {copied ? t('link.copied') : t('link.copy')}
            </Button>
          </div>
          <span style={muted}>{t('link.warn')}</span>
        </div>
      )}
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {err}
        </p>
      )}
      <div>
        <Button onClick={() => void make()}>{code ? t('link.again') : t('link.start')}</Button>
      </div>
    </div>
  );
}

/** Copyable one-line value (link command, Events URL). */
function CopyLine({ value, testId }: { value: string; testId: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div style={row}>
      <code data-testid={testId} style={{ fontSize: 14, ...wrap }}>
        {value}
      </code>
      <Button
        size="sm"
        style={{ minHeight: 44 }}
        onClick={() =>
          navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? t('link.copied') : t('link.copy')}
      </Button>
    </div>
  );
}

/**
 * QR link as a linked device (WhatsApp). The notice about the platform's terms and the ban risk comes first; the
 * QR code is requested only when the owner accepts it, and the server refuses a pairing without that acceptance.
 */
function PairingFlow({ b, onLinked }: { b: Binding; onLinked(): void }) {
  const t = useT();
  const kindName = t(`kind.${b.kind}`, { defaultValue: b.kind });
  const [p, setP] = useState<Pairing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const active = p?.state === 'waiting';
  useEffect(() => {
    if (!active) return;
    // the QR code rotates every ~20 s on the platform side: follow it while it is shown
    const timer = setInterval(() => {
      call<{ pairing: Pairing }>('GET', `${base}/bindings/${b.id}/pairing`)
        .then((r) => {
          setP(r.pairing);
          if (r.pairing.state === 'linked') onLinked();
        })
        .catch((x) => setErr(x instanceof Error ? x.message : String(x)));
    }, 1000);
    return () => clearInterval(timer);
  }, [active, b.id, onLinked]);
  const start = async () => {
    try {
      setErr(null);
      const r = await call<{ pairing: Pairing }>('POST', `${base}/bindings/${b.id}/pairing`, {
        acknowledgeRisk: true,
      });
      setP(r.pairing);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };
  const cancel = async () => {
    await call('DELETE', `${base}/bindings/${b.id}/pairing`).catch(() => {});
    setP(null);
  };
  return (
    <section
      style={{ display: 'grid', gap: 8, minWidth: 0 }}
      aria-label={t('pairing.title', { app: kindName })}
      data-testid="channel-pairing"
    >
      <strong>{t('pairing.title', { app: kindName })}</strong>
      {!active && p?.state !== 'linked' && (
        <>
          <div role="note" data-testid="pairing-risk" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <p style={{ margin: 0, ...wrap }}>{t('pairing.riskTitle')}</p>
            <p style={muted}>{t('pairing.riskBody', { app: kindName })}</p>
            <p style={muted}>{t('pairing.riskAdvice')}</p>
          </div>
          {p?.state === 'error' && (
            <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
              {t('pairing.failed', { reason: p.error ?? '' })}
            </p>
          )}
          <div>
            <Button variant="primary" onClick={() => void start()}>
              {t('pairing.accept')}
            </Button>
          </div>
        </>
      )}
      {active && (
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <p style={muted}>{t('pairing.scan', { app: kindName })}</p>
          {safeImageSrc(p?.qrSvg) ? (
            <img
              src={safeImageSrc(p?.qrSvg)}
              alt={t('pairing.qrAlt')}
              data-testid="pairing-qr"
              style={{ width: 'min(240px, 100%)', height: 'auto', background: '#fff', borderRadius: 8 }}
            />
          ) : (
            <p style={muted} role="status">
              {t('pairing.waiting')}
            </p>
          )}
          <div>
            <Button variant="ghost" onClick={() => void cancel()}>
              {t('add.cancel')}
            </Button>
          </div>
        </div>
      )}
      {p?.state === 'linked' && (
        <p role="status" data-testid="pairing-linked" style={{ margin: 0, ...wrap }}>
          {t('pairing.linked')}
        </p>
      )}
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {err}
        </p>
      )}
    </section>
  );
}

function BindingCard({
  b,
  agents,
  kinds,
  reload,
}: {
  b: Binding;
  agents: Agent[];
  kinds: Kind[];
  reload(): void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [editToken, setEditToken] = useState(false);
  const [token, setToken] = useState('');
  const [field, setField] = useState('');
  const [allowed, setAllowed] = useState(b.allowedSenders.join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setErr(null);
      reload();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };
  const k = kinds.find((x) => x.kind === b.kind);
  const fields = k?.secretFields.length ? k.secretFields : b.secretsSet;
  const raw = !b.available ? 'unavailable' : !b.enabled ? 'disabled' : b.status;
  // a pairing channel without a stored session is not "token rejected" but not linked yet
  const status = k?.pairing && raw === 'auth_failed' ? 'not_linked' : raw;
  const ownNumber = b.options?.ownNumber === true;
  const reloadCb = useCallback(() => reload(), [reload]);
  const tone =
    status === 'connected'
      ? 'primary'
      : status === 'auth_failed' || status === 'error'
        ? 'signal'
        : 'neutral';
  const tokenField = field || fields[0] || 'botToken';
  const agentName = agents.find((a) => a.id === b.agentId)?.name ?? '—';
  const title = b.label || t(`kind.${b.kind}`, { defaultValue: b.kind });
  return (
    <Card as="article" data-testid="channel-binding" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <div style={{ ...row, minWidth: 0 }}>
          <BrandTile id={b.kind} size={32} fallback="channels" />
          <h3 style={{ margin: 0, fontSize: 17, ...wrap }}>{title}</h3>
        </div>
        <Badge tone={tone} data-testid="channel-status">
          {t(`status.${status}`, { defaultValue: status })}
        </Badge>
      </div>
      <dl style={{ display: 'grid', gap: 6, margin: 0, minWidth: 0 }}>
        <div style={row}>
          <dt style={muted}>{t('binding.agent')}</dt>
          <dd style={{ margin: 0, ...wrap }}>
            <select
              aria-label={t('binding.agent')}
              className="bk-input"
              value={b.agentId}
              style={{ minHeight: 44, maxWidth: '100%' }}
              onChange={(e) => {
                const agentId = e.target.value;
                void act(() => call('PATCH', `${base}/bindings/${b.id}`, { agentId }));
              }}
            >
              {!agents.some((a) => a.id === b.agentId) && <option value={b.agentId}>{agentName}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div style={row}>
          <dt style={muted}>{t('binding.lastEvent')}</dt>
          <dd style={{ margin: 0, ...wrap }}>
            {b.lastEventAt ? new Date(b.lastEventAt).toLocaleString(displayLocale()) : t('binding.never')}
          </dd>
        </div>
        {b.dropped > 0 && <p style={muted}>{t('binding.dropped', { count: b.dropped })}</p>}
        {b.lastError && status !== 'connected' && status !== 'not_linked' && (
          <p style={{ ...muted, color: 'var(--bk-danger)' }}>{t('binding.error', { error: b.lastError })}</p>
        )}
      </dl>

      {Object.entries(k?.options ?? {})
        .filter(([, type]) => type === 'boolean')
        .map(([o]) => (
          <Select
            key={o}
            label={t(`option.${o}.label`, { defaultValue: o })}
            value={b.options?.[o] === true ? 'on' : 'off'}
            onChange={(v) =>
              void act(() => call('PATCH', `${base}/bindings/${b.id}`, { options: { [o]: v === 'on' } }))
            }
            options={[
              ['off', t(`option.${o}.off`, { defaultValue: 'off' })],
              ['on', t(`option.${o}.on`, { defaultValue: 'on' })],
            ]}
          />
        ))}

      {k?.inboundHttp && (
        <section style={{ display: 'grid', gap: 8, minWidth: 0 }} aria-label={t('events.title')}>
          <strong>{t('events.title')}</strong>
          <p style={muted}>{t('events.how', { app: t(`kind.${b.kind}`, { defaultValue: b.kind }) })}</p>
          <CopyLine
            testId="channel-events-url"
            value={`${typeof location !== 'undefined' ? location.origin : ''}/hooks/channels/${b.id}/events`}
          />
        </section>
      )}

      {/* only an unlinked binding offers linking: a linked one that is reconnecting or failing keeps its session */}
      {k?.pairing && status === 'not_linked' && <PairingFlow b={b} onLinked={reloadCb} />}

      <section style={{ display: 'grid', gap: 8, minWidth: 0 }} aria-label={t('binding.owner')}>
        <strong>{t('binding.owner')}</strong>
        {b.owner ? (
          <div style={row}>
            <span style={wrap} data-testid="channel-owner">
              {t('binding.ownerLinked', { name: b.owner.name, id: b.owner.externalUserId })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              style={{ minHeight: 44 }}
              onClick={() => void act(() => call('DELETE', `${base}/bindings/${b.id}/owner`))}
            >
              {t('binding.unlink')}
            </Button>
          </div>
        ) : (
          <p style={muted}>{t('binding.ownerNone')}</p>
        )}
        {k?.pairing && ownNumber && <p style={muted}>{t('link.ownNumber')}</p>}
        <LinkCode bindingId={b.id} />
      </section>

      <section style={{ display: 'grid', gap: 8, minWidth: 0 }} aria-label={t('binding.places')}>
        <strong>{t('binding.places')}</strong>
        {b.places.length === 0 ? (
          <p style={muted}>{t('binding.placesNone')}</p>
        ) : (
          <ul style={{ display: 'grid', gap: 4, padding: 0, margin: 0, listStyle: 'none' }}>
            {b.places.map((p) => (
              <li key={p.id} style={{ ...row, minHeight: 44 }}>
                <span style={wrap}>{p.title || p.id}</span>
                {p.chatId && (
                  <a
                    href={`#/chats/${p.chatId}`}
                    style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                  >
                    {t('binding.openChat')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        style={{ display: 'grid', gap: 8, minWidth: 0 }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await call('PATCH', `${base}/bindings/${b.id}`, { allowedSenders: parseIds(allowed) });
            setSaved(true);
          });
        }}
      >
        <Field
          multiline
          rows={2}
          label={t('binding.allowed')}
          hint={b.allowedSenders.length ? t('add.allowedHint') : t('binding.allowedNone')}
          value={allowed}
          onChange={(e) => {
            setAllowed(e.currentTarget.value);
            setSaved(false);
          }}
        />
        <div style={row}>
          <Button type="submit">{t('binding.save')}</Button>
          {saved && <span style={muted}>{t('binding.saved')}</span>}
        </div>
      </form>

      {fields.length > 0 && (
        <section style={{ display: 'grid', gap: 8, minWidth: 0 }} aria-label={t('binding.token')}>
          <strong>{t('binding.token')}</strong>
          <p style={muted}>{t('binding.tokenSet')}</p>
          {editToken ? (
            <form
              style={{ display: 'grid', gap: 8, minWidth: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await call('PATCH', `${base}/bindings/${b.id}`, {
                    secrets: { [tokenField]: token.trim() },
                  });
                  setToken('');
                  setEditToken(false);
                });
              }}
            >
              {fields.length > 1 && (
                <Select
                  label={t('binding.which')}
                  value={tokenField}
                  onChange={setField}
                  options={fields.map((f) => [f, t(`field.${f}`, { defaultValue: f })])}
                />
              )}
              <Field
                label={t('binding.tokenNew')}
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={token}
                onChange={(e) => setToken(e.currentTarget.value)}
              />
              <div style={row}>
                <Button type="submit" variant="primary" disabled={!token.trim()}>
                  {t('binding.save')}
                </Button>
                <Button variant="ghost" onClick={() => setEditToken(false)}>
                  {t('add.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button onClick={() => setEditToken(true)}>{t('binding.tokenReplace')}</Button>
            </div>
          )}
        </section>
      )}

      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button onClick={() => void act(() => call('POST', `${base}/bindings/${b.id}/restart`))}>
          {t('binding.restart')}
        </Button>
        <Button
          onClick={() => void act(() => call('PATCH', `${base}/bindings/${b.id}`, { enabled: !b.enabled }))}
        >
          {b.enabled ? t('binding.turnOff') : t('binding.turnOn')}
        </Button>
        {confirming ? (
          <>
            <span style={muted}>{t('binding.removeConfirm')}</span>
            <Button
              variant="danger"
              onClick={() => void act(() => call('DELETE', `${base}/bindings/${b.id}`))}
            >
              {t('binding.confirm')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('add.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('binding.remove')}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ChannelsSettings() {
  const t = useT();
  const [data, setData] = useState<{ bindings: Binding[]; kinds: Kind[] } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    try {
      const [d, ag] = await Promise.all([
        call<{ bindings: Binding[]; kinds: Kind[] }>('GET', `${base}/bindings`),
        call<{ agents: Agent[] } | Agent[]>('GET', '/api/v1/agents'),
      ]);
      setData(d);
      setAgents(Array.isArray(ag) ? ag : ag.agents);
      setErr(null);
    } catch (x) {
      const msg = x instanceof Error ? x.message : String(x);
      // the server runs without the channels module: nothing to manage, show nothing
      if (msg === 'HTTP 404') setMissing(true);
      else setErr(msg);
    }
  }, []);
  useEffect(() => {
    void load();
    // status, last event and the owner link change on the server side: refresh while the screen is open
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  if (missing) return null;
  return (
    <section
      data-testid="channels-settings"
      aria-labelledby="channels-title"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
    >
      {/* the feature page's own heading already says "Chat apps": this one is for the section's label only */}
      <h3 id="channels-title" className="bk-visually-hidden">
        {t('settings.title')}
      </h3>
      <p style={muted}>{t('settings.intro')}</p>
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {t('settings.error', { reason: err })}
        </p>
      )}
      {!data ? (
        !err && <p style={muted}>{t('settings.loading')}</p>
      ) : (
        <>
          {data.bindings.length === 0 && <p style={muted}>{t('settings.empty')}</p>}
          {data.bindings.map((b) => (
            <BindingCard key={b.id} b={b} agents={agents} kinds={data.kinds} reload={() => void load()} />
          ))}
          {adding ? (
            <Card style={{ minWidth: 0 }}>
              <AddForm
                kinds={data.kinds}
                agents={agents}
                onCancel={() => setAdding(false)}
                onDone={() => {
                  setAdding(false);
                  void load();
                }}
              />
            </Card>
          ) : (
            <div>
              <Button variant="primary" onClick={() => setAdding(true)}>
                {t('add.open')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const mod: WebModule = {
  id: 'channels',
  settingsSections: [
    {
      id: 'channels',
      labelKey: 'channels:settings.title',
      hintKey: 'channels:find.settingsHint',
      keywordsKey: 'channels:find.settingsKeywords',
      component: ChannelsSettings,
      order: 200,
      icon: 'channels',
      group: 'people',
    },
  ],
};
export default mod;
