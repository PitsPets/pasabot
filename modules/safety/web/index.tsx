/**
 * W31 web: the stop button in the top bar on every screen (one click stops everything, then the report), resume with
 * the owner's password, and the Safety page: receipts with a step timeline, export, retention, and the pre-install
 * skill check. All text is plain text (never rendered as HTML); the readable export opens on the sandboxed origin.
 */
import type { DecisionItem, WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field, Icon, Sheet } from '@pasabot/ui';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** the shell re-dispatches module events on window under this name (`LIVE_EVENT` in @pasabot/core/web) */
const LIVE_EVENT = 'pasabot:event';
/**
 * The paused state for the rest of the app (the chat's "Everything is paused" banner and a disabled Send): set on
 * `<html data-paused data-paused-since>` and announced as `pasabot:paused`. `pasabot:resume` asks the stop control
 * that is on screen to open its Start-again sheet (the chat banner's button).
 */
const PAUSED_EVENT = 'pasabot:paused';
const RESUME_EVENT = 'pasabot:resume';
/**
 * `pasabot:stop-all` asks the stop control that is on screen to stop everything (the chat's More menu), so stopping
 * stays one step away while the top-bar button is calm or hidden; Ctrl/⌘ + Shift + . does the same from anywhere.
 */
const STOP_EVENT = 'pasabot:stop-all';
const STOP_KEYS = 'Control+Shift+Period Meta+Shift+Period';
/** Ctrl/⌘ + Shift + . (the period key, whatever the keyboard layout prints with Shift) */
export const isStopKey = (e: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>) =>
  e.code === 'Period' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey;

const translations = moduleTranslator(
  'safety',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}
/** The person's "Technical words" switch (mirrored on `<html data-advanced>`, `pasabot:advanced` on change). */
function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

class ApiErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  if (!r.ok) throw new ApiErr(r.status, j?.error ?? `http_${r.status}`);
  return j as T;
}

interface StoppedItem {
  kind: string;
  id: string;
  label?: string | null;
  /** the queue item's kind (`message`, `routine`, ...), named here in the app language */
  queueKind?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  runId?: string | null;
  outcome: 'cancelled' | 'held' | 'closed';
}
interface StopState {
  stopped: boolean;
  since: number | null;
  actorKind: string | null;
  by: string | null;
  reason: string | null;
  report: { at: number; actorKind: string; items: StoppedItem[] } | null;
  /** `limited` for everyone but the owner: only whether things are stopped (the control stays hidden) */
  view?: 'owner' | 'limited';
}

// one shared copy of the stop state for every mounted control (desktop + phone bars)
let shared: StopState | null = null;
const subs = new Set<(s: StopState | null) => void>();
const setShared = (s: StopState | null) => {
  shared = s;
  for (const f of subs) f(s);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (s?.stopped) {
    root.dataset.paused = '1';
    if (s.since) root.dataset.pausedSince = String(s.since);
    else delete root.dataset.pausedSince;
  } else {
    delete root.dataset.paused;
    delete root.dataset.pausedSince;
  }
  window.dispatchEvent(
    new CustomEvent(PAUSED_EVENT, { detail: { stopped: !!s?.stopped, since: s?.since ?? null } }),
  );
};
async function refresh() {
  try {
    setShared(await api<StopState>('/api/m/safety/state'));
  } catch {
    // signed out or a member: the control stays hidden
  }
}
function useStopState() {
  const [s, set] = useState<StopState | null>(shared);
  useEffect(() => {
    subs.add(set);
    if (!shared) void refresh();
    const onLive = (e: Event) => {
      const d = (e as CustomEvent<{ type: string }>).detail;
      if (d?.type === 'safety.changed') void refresh();
    };
    window.addEventListener(LIVE_EVENT, onLive);
    window.addEventListener('focus', refresh);
    return () => {
      subs.delete(set);
      window.removeEventListener(LIVE_EVENT, onLive);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return s;
}

const fmtTime = (t: number) => new Date(t).toLocaleString(displayLocale());
/** a recorded amount as the budget page shows money: at most 4 decimals, local digits, then the currency */
const fmtCost = (n: number) => (Math.round(n * 10000) / 10000).toLocaleString(displayLocale());

function ReportSheet({
  state,
  open,
  onClose,
  onResume,
}: {
  state: StopState;
  open: boolean;
  onClose(): void;
  onResume(): void;
}) {
  const t = useT();
  const items = state.report?.items ?? [];
  const known = ['run', 'queued', 'browser', 'computer', 'voice', 'approval'];
  return (
    <Sheet open={open} title={t('report.title')} onClose={onClose}>
      <div data-testid="stop-report">
        <p className="muted">{t('report.intro')}</p>
        {state.report && (
          <p>
            {t('report.by', {
              who: t(`report.who.${state.report.actorKind}`),
              when: fmtTime(state.report.at),
            })}
          </p>
        )}
        {items.length === 0 ? (
          <p>{t('report.empty')}</p>
        ) : (
          <ul className="plain" style={{ display: 'grid', gap: 8, padding: 0, margin: '12px 0' }}>
            {items.map((i) => (
              <li key={`${i.kind}:${i.id}`} data-stopped={i.kind} style={{ overflowWrap: 'anywhere' }}>
                <b>{t(`report.kind.${known.includes(i.kind) ? i.kind : 'other'}`)}</b>{' '}
                <Badge tone="outline">{t(`report.outcome.${i.outcome}`)}</Badge>
                <div className="muted" style={{ fontSize: 14 }}>
                  {[
                    i.queueKind
                      ? t(`report.queue.${i.queueKind.replace(/\./g, '-')}`, { defaultValue: i.queueKind })
                      : null,
                    i.label,
                    i.runId ? t('report.run', { id: i.runId }) : null,
                    i.chatId ? t('report.chat', { id: i.chatId }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>{t('report.close')}</Button>
          {state.stopped && (
            <Button variant="primary" onClick={onResume}>
              {t('report.resume')}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function ResumeSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/reauth', 'POST', { password });
      setShared(await api<StopState>('/api/m/safety/resume', 'POST'));
      setPassword('');
      onClose();
    } catch (err) {
      const code = err instanceof ApiErr ? err.code : 'error';
      setError(
        code === 'invalid_credentials' || (err instanceof ApiErr && err.status === 401)
          ? t('resume.wrong')
          : code === 'forbidden' || code === 'resume_forbidden'
            ? t('resume.forbidden')
            : t('resume.error', { reason: code }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} title={t('resume.title')} onClose={onClose}>
      <form onSubmit={submit} data-testid="resume-form">
        <p className="muted">{t('resume.intro')}</p>
        <Field
          label={t('resume.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
          error={error}
          required
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="button" onClick={onClose}>
            {t('resume.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            {t('resume.submit')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * The top-bar control: "Stop all" while agents may run. While paused: a "Paused" chip (not a button) and one "Start
 * again" button; on the phone header an icon-only 44 px play button, so the needs-you pill keeps its room.
 * `idle` (nothing is working or waiting): the button is calm (neutral, not red); with `hideIdle` it is not drawn at all
 * (the phone chat header). Either way the control stays mounted, so the More menu's "Stop all" and Ctrl/⌘ + Shift + .
 * still reach it.
 */
function StopControl({ compact, idle, hideIdle }: { compact?: boolean; idle?: boolean; hideIdle?: boolean }) {
  const t = useT();
  const tech = useTechnical();
  // "Stop all helpers now" (plain words) or "Stop all agents now" (Technical words on)
  const stopLabel = t(tech ? 'stop.buttonLabel' : 'plain.stop.buttonLabel');
  const s = useStopState();
  const [sheet, setSheet] = useState<'report' | 'resume' | null>(null);
  const [busy, setBusy] = useState(false);
  const self = useRef<HTMLSpanElement>(null);
  const owner = s?.view === 'owner';
  const stopped = !!s?.stopped;
  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ state: StopState }>('/api/m/safety/stop', 'POST', { reason: 'stop button' });
      setShared(r.state);
      setSheet('report');
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  }, []);
  // the chat's paused banner asks to start again, the More menu (or the keys) to stop: only the control that is on
  // screen (desktop or phone bar) answers
  useEffect(() => {
    const onScreen = () => !!self.current && self.current.getClientRects().length > 0;
    const resume = () => {
      if (onScreen()) setSheet('resume');
    };
    const stopNow = () => {
      if (owner && !stopped && onScreen()) void stop();
    };
    const key = (e: KeyboardEvent) => {
      if (!isStopKey(e) || !owner || stopped || !onScreen()) return;
      e.preventDefault();
      void stop();
    };
    window.addEventListener(RESUME_EVENT, resume);
    window.addEventListener(STOP_EVENT, stopNow);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener(RESUME_EVENT, resume);
      window.removeEventListener(STOP_EVENT, stopNow);
      window.removeEventListener('keydown', key);
    };
  }, [owner, stopped, stop]);
  // members and guests may not stop from the app, so they see no control (the state they get is limited anyway)
  if (!owner || !s) return null;
  const hidden = !!idle && !!hideIdle && !s.stopped;
  return (
    <span
      ref={self}
      className="safety-stop"
      data-compact={compact ? '1' : '0'}
      data-idle={idle ? '1' : '0'}
      style={
        hidden
          ? // out of the header's flow (no gap, no width) but on screen, so the menu and the keys still reach it
            { position: 'absolute', inlineSize: 0, blockSize: 0, overflow: 'hidden' }
          : { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }
      }
    >
      {s.stopped ? (
        compact ? (
          <Button
            variant="primary"
            data-testid="stopped-pill"
            aria-label={t('stop.resumeLabel')}
            title={t('stop.resumeLabel')}
            onClick={() => setSheet('resume')}
            style={{ minBlockSize: 44, minInlineSize: 44, inlineSize: 44, padding: 0, flex: '0 0 auto' }}
          >
            <Icon name="play" size={18} />
          </Button>
        ) : (
          <>
            <span
              className="safety-paused"
              data-testid="stopped-pill"
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minBlockSize: 32,
                padding: '0 12px',
                borderRadius: 16,
                background: 'var(--bk-danger-soft)',
                color: 'var(--bk-danger)',
                fontWeight: 600,
                fontSize: 14,
                whiteSpace: 'nowrap',
              }}
            >
              {t('stop.stopped')}
            </span>
            <Button
              variant="primary"
              data-testid="start-again"
              onClick={() => setSheet('resume')}
              style={{ minBlockSize: 44, whiteSpace: 'nowrap' }}
            >
              {t('stop.resume')}
            </Button>
          </>
        )
      ) : hidden ? null : (
        <Button
          // calm while nothing is working: red only while something runs or waits
          variant={idle ? 'secondary' : 'danger'}
          data-testid="stop-all"
          data-calm={idle ? '1' : '0'}
          aria-keyshortcuts={STOP_KEYS}
          aria-label={stopLabel}
          title={compact ? stopLabel : undefined}
          disabled={busy}
          onClick={() => void stop()}
          // the phone header: icon only, a 44 px square, so the "N need you" pill keeps its room in every language
          style={
            compact
              ? { minBlockSize: 44, minInlineSize: 44, inlineSize: 44, padding: 0, flex: '0 0 auto' }
              : { minBlockSize: 44, minInlineSize: 44, whiteSpace: 'nowrap' }
          }
        >
          {compact ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          ) : (
            t('stop.button')
          )}
        </Button>
      )}
      <ReportSheet
        state={s}
        open={sheet === 'report'}
        // a dialog's close event arrives after the next sheet opened: only close what is still showing
        onClose={() => setSheet((x) => (x === 'report' ? null : x))}
        onResume={() => setSheet('resume')}
      />
      <ResumeSheet open={sheet === 'resume'} onClose={() => setSheet((x) => (x === 'resume' ? null : x))} />
    </span>
  );
}

// ---------- receipts page ----------
interface ReceiptView {
  id: string;
  runId: string;
  agentId: string;
  chatId: string | null;
  kind: string | null;
  state: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  tokens: { input: number; output: number };
  /** W32: the cost the budget booked for the run; null until it is in, or when the model has no price */
  cost?: number | null;
  currency?: string | null;
  steps?: number;
}
interface ReceiptItem {
  n: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

function stepText(i: ReceiptItem): string {
  const d = i.data;
  switch (i.kind) {
    case 'tool.call':
      return `${String(d.name ?? '')} ${JSON.stringify(d.input ?? {})}`;
    case 'tool.result':
      return `${d.ok ? '✓' : '✗'} ${String(d.summary ?? '')}`;
    case 'approval.requested':
      return String(d.summary ?? '');
    case 'approval.decided':
      return `${String(d.decision ?? '')} · ${String(d.summary ?? '')}`;
    case 'usage':
      return `${String(d.inputTokens ?? 0)} / ${String(d.outputTokens ?? 0)}`;
    case 'reply':
      return String(d.preview ?? '');
    case 'refused':
      return String(d.reason ?? '');
    case 'run.finished':
      return String(d.state ?? '');
    case 'run.started':
      return [d.provider, d.model].filter(Boolean).join(' · ');
    default:
      return JSON.stringify(d);
  }
}

/**
 * A receipt's queue kind (`message`, `routine`, `automation.run`, ...) in the app language, the same labels the
 * receipt list and stop report use; a kind the app does not know reads "Other", never the raw code.
 */
const QUEUE_KINDS = ['message', 'task', 'handoff', 'routine', 'workflow', 'automation-run'];
function queueKind(t: (k: string) => string, k: string | null | undefined): string {
  const key = (k ?? 'message').replace(/\./g, '-');
  return QUEUE_KINDS.includes(key) ? t(`report.queue.${key}`) : t('report.kind.other');
}

function ReceiptDetail({ id, onBack }: { id: string; onBack(): void }) {
  const t = useT();
  const [data, setData] = useState<{ receipt: ReceiptView; items: ReceiptItem[] } | null>(null);
  const [pos, setPos] = useState(0);
  const [exp, setExp] = useState<{ htmlUrl: string; jsonUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<{ id: string; displayName: string } | null>(null);
  const load = useCallback(
    (keepPos: boolean) =>
      void api(`/api/m/safety/receipts/${encodeURIComponent(id)}`).then((d) => {
        setData(d);
        if (!keepPos) setPos(Math.max(0, d.items.length - 1));
      }),
    [id],
  );
  useEffect(() => load(false), [load]);
  useEffect(() => {
    void api<{ user: { id: string; displayName: string } }>('/api/v1/me').then(
      (r) => setMe(r.user),
      () => {},
    );
  }, []);
  // W39: the budget books the run's cost after it ends; the open receipt picks it up without a reload
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string; data?: { runId?: string } }>).detail;
      if (d?.type === 'budget.cost' && d.data?.runId === data?.receipt.runId) load(true);
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => window.removeEventListener(LIVE_EVENT, on);
  }, [load, data?.receipt.runId]);
  /** who decided, by name: only the owner's own session decides (7.4), so a known id is the signed-in owner */
  const decider = (by: unknown) =>
    by == null
      ? t('receipts.nobody')
      : me && by === me.id
        ? t('receipts.youNamed', { name: me.displayName })
        : t('receipts.someoneElse');
  if (!data) return <p aria-busy="true">…</p>;
  const { receipt, items } = data;
  const cur = items[pos];
  const kindLabel = (k: string) => {
    const v = t(`receipts.kind.${k}`);
    return v.startsWith('receipts.') ? k : v;
  };
  const doExport = async () => {
    setBusy(true);
    try {
      setExp(await api(`/api/m/safety/receipts/${encodeURIComponent(id)}/export`, 'POST'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-testid="receipt-detail"
      aria-labelledby="receipt-title"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
    >
      <div>
        <Button size="md" onClick={onBack}>
          {t('receipts.back')}
        </Button>
      </div>
      <h2 id="receipt-title" style={{ overflowWrap: 'anywhere', margin: 0 }}>
        {queueKind(t, receipt.kind)} · {receipt.runId}
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        {t(`receipts.state.${receipt.state}`)} ·{' '}
        {t('receipts.tokens', { input: receipt.tokens.input, output: receipt.tokens.output })}
        {receipt.durationMs != null &&
          ` · ${t('receipts.duration', { s: Math.round(receipt.durationMs / 100) / 10 })}`}
        {receipt.cost != null && receipt.currency && (
          <span data-testid="receipt-cost">
            {` · ${t('receipts.cost', { amount: fmtCost(receipt.cost), currency: receipt.currency })}`}
          </span>
        )}
      </p>
      <h3 style={{ margin: 0 }}>{t('receipts.timeline')}</h3>
      {items.length > 0 && (
        <>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>{t('receipts.scrub')}</span>
            <input
              type="range"
              min={0}
              max={items.length - 1}
              value={pos}
              data-testid="timeline-scrubber"
              aria-valuetext={t('receipts.step', { n: pos + 1, total: items.length })}
              onChange={(e) => setPos(Number(e.target.value))}
              style={{ inlineSize: '100%', minBlockSize: 44 }}
            />
          </label>
          {cur && (
            <Card>
              <div data-testid="timeline-current" style={{ overflowWrap: 'anywhere' }}>
                <p className="muted" style={{ margin: 0 }}>
                  {t('receipts.step', { n: pos + 1, total: items.length })} · {fmtTime(cur.at)}
                </p>
                <p style={{ margin: '4px 0' }}>
                  <b>{kindLabel(cur.kind)}</b>
                </p>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{stepText(cur)}</p>
                {cur.kind === 'approval.decided' && (
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {t('receipts.decidedBy', { who: decider(cur.data.decidedBy) })}
                  </p>
                )}
                {cur.kind === 'screenshot' && typeof cur.data.file === 'string' && (
                  <img
                    alt={kindLabel('screenshot')}
                    src={`/api/m/safety/receipts/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(cur.data.file)}`}
                    style={{ maxInlineSize: '100%' }}
                  />
                )}
              </div>
            </Card>
          )}
          <ol className="plain" style={{ display: 'grid', gap: 4, padding: 0, margin: 0 }}>
            {items.map((i) => (
              <li key={i.n}>
                <button
                  type="button"
                  className="bk-btn bk-btn--ghost"
                  aria-current={i.n === pos ? 'step' : undefined}
                  onClick={() => setPos(i.n)}
                  style={{
                    inlineSize: '100%',
                    textAlign: 'start',
                    minBlockSize: 44,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {i.n + 1}. {kindLabel(i.kind)}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => void doExport()} disabled={busy}>
          {busy ? t('receipts.exporting') : t('receipts.export')}
        </Button>
        {exp && (
          <>
            <a className="bk-btn bk-btn--secondary" href={exp.jsonUrl} download style={{ minBlockSize: 44 }}>
              {t('receipts.exportJson')}
            </a>
            <a
              className="bk-btn bk-btn--secondary"
              href={exp.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ minBlockSize: 44 }}
            >
              {t('receipts.exportHtml')}
            </a>
          </>
        )}
      </div>
    </section>
  );
}

function Retention() {
  const t = useT();
  const [days, setDays] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void api('/api/m/safety/settings').then((s) => setDays(String(s.retentionDays)));
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api('/api/m/safety/settings', 'PUT', { retentionDays: Number(days) });
    setMsg(t('retention.saved', { count: r.deleted }));
  };
  return (
    <form onSubmit={save} data-testid="retention-form" style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{t('retention.title')}</h3>
      <Field
        label={t('retention.days')}
        hint={t('retention.hint')}
        type="number"
        min={1}
        max={3650}
        value={days}
        onChange={(e) => setDays((e.target as HTMLInputElement).value)}
      />
      <div>
        <Button type="submit">{t('retention.save')}</Button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}

function SkillCheck() {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{
    status: string;
    findings: { kind: string; file: string; line: number; excerpt: string }[];
    error?: string;
  } | null>(null);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setRes(await api('/api/m/safety/scan', 'POST', { files: [{ name: 'SKILL.md', text }] }));
    } catch (err) {
      setRes({ status: 'error', findings: [], error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const kinds = res ? [...new Set(res.findings.map((f) => f.kind))] : [];
  return (
    <form onSubmit={run} data-testid="skill-check" style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{t('scan.title')}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {t('scan.intro')}
      </p>
      <Field
        label={t('scan.label')}
        multiline
        rows={6}
        value={text}
        onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <div>
        <Button type="submit" disabled={busy || !text.trim()}>
          {busy ? t('scan.running') : t('scan.run')}
        </Button>
      </div>
      {res && (
        <div role="status" data-testid="scan-result">
          {res.status === 'timeout' ? (
            <p>{t('scan.timeout')}</p>
          ) : res.status === 'error' ? (
            <p>{t('scan.error', { reason: res.error ?? '' })}</p>
          ) : kinds.length === 0 ? (
            <p>{t('scan.clean')}</p>
          ) : (
            <>
              <p>{t('scan.noticed')}</p>
              <ul>
                {kinds.map((k) => (
                  <li key={k} data-finding={k}>
                    {t(`scan.kind.${k}`)} (
                    {res.findings
                      .filter((f) => f.kind === k)
                      .map((f) => t('scan.line', { line: f.line }))
                      .join(', ')}
                    )
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </form>
  );
}

/** a card's inner padding, as on the other Settings pages (a bare card has none) */
const cardPad = { padding: 16, minWidth: 0 } as const;

function SafetyPage() {
  const t = useT();
  const queueKindName = (k: string | null | undefined) => queueKind(t, k);
  const [list, setList] = useState<ReceiptView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<{ receipts: ReceiptView[] }>('/api/m/safety/receipts').then((r) => setList(r.receipts));
  }, []);
  useEffect(load, [load]);
  return (
    <section
      data-testid="safety-page"
      aria-labelledby="safety-title"
      style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 860, minWidth: 0 }}
    >
      {/* the same page gutter and card padding as the other Settings pages */}
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 id="safety-title" style={{ margin: 0 }}>
          {t('page.title')}
        </h1>
        <p className="muted" style={{ margin: 0 }}>
          {t('page.intro')}
        </p>
      </header>
      <Card style={cardPad}>
        {open ? (
          <ReceiptDetail
            id={open}
            onBack={() => {
              setOpen(null);
              load();
            }}
          />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <h2 style={{ margin: 0 }}>{t('receipts.title')}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {t('receipts.intro')}
            </p>
            {list && list.length === 0 && <p>{t('receipts.empty')}</p>}
            <ul
              className="plain"
              style={{ display: 'grid', gap: 6, padding: 0, margin: 0 }}
              data-testid="receipt-list"
            >
              {(list ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="bk-btn bk-btn--ghost"
                    aria-label={`${t('receipts.open')}: ${queueKindName(r.kind)} ${fmtTime(r.startedAt)}`}
                    onClick={() => setOpen(r.id)}
                    style={{
                      inlineSize: '100%',
                      textAlign: 'start',
                      minBlockSize: 44,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {fmtTime(r.startedAt)} · {queueKindName(r.kind)} · {t(`receipts.state.${r.state}`)} ·{' '}
                    {t('receipts.steps', { count: r.steps ?? 0 })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <Card style={cardPad}>
        <Retention />
      </Card>
      <Card style={cardPad}>
        <SkillCheck />
      </Card>
    </section>
  );
}

// ---------- the pinned decision bar (W39): skill-permission proposals ----------
interface ProposalView {
  skillId: string;
  /** true: the skill already has an approved manifest and this asks for a change */
  approved: boolean;
  at: number | null;
  version: string;
}
/**
 * Imported or agent-written skill manifests waiting for the owner. The bar only names the skill and links to the
 * Skills page, which shows every tool, host, path and the messaging flag against what is approved now; a decision
 * never happens from a card that does not show what it grants.
 */
function useProposalDecisions(): DecisionItem[] {
  const t = useT();
  const [list, setList] = useState<ProposalView[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    void api<{ proposals: ProposalView[] }>('/api/m/safety/skills/proposals').then(
      (r) => {
        setList(r.proposals);
        if (!r.proposals.length) return;
        // the skill's name, not its id (no skills module: the id stays)
        void api<{ skills: { id: string; name: string }[] }>('/api/m/skills/skills').then(
          (x) => setNames(Object.fromEntries(x.skills.map((k) => [k.id, k.name]))),
          () => {},
        );
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    const on = (e: Event) => {
      const type = (e as CustomEvent<{ type?: string }>).detail?.type;
      if (type === 'safety.proposals') load();
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => {
      clearInterval(timer);
      window.removeEventListener(LIVE_EVENT, on);
    };
  }, [load]);
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'en';
  // biome-ignore lint/correctness/useExhaustiveDependencies: t follows the language, which `lang` stands for
  return useMemo(
    () =>
      list.map((p) => ({
        id: `safety:proposal:${p.skillId}`,
        title: t('decision.proposal', { skill: names[p.skillId] ?? p.skillId }),
        text: p.approved ? t('decision.proposalWiden') : t('decision.proposalText'),
        href: '#/skills',
        ...(p.at ? { at: p.at } : {}),
      })),
    [list, names, lang],
  );
}

const mod: WebModule = {
  id: 'safety',
  routes: [{ path: '/safety', component: SafetyPage, titleKey: 'safety:page.title' }],
  navItems: [
    {
      id: 'safety',
      labelKey: 'safety:nav',
      hintKey: 'safety:find.navHint',
      keywordsKey: 'safety:find.navKeywords',
      to: '/safety',
      icon: 'shield',
      group: 'safety',
      optional: false,
      order: 80,
    },
  ],
  topBarItems: [{ id: 'safety-stop', order: 10, component: StopControl }],
  decisionSources: [{ id: 'safety-proposals', useItems: useProposalDecisions }],
};
export default mod;
