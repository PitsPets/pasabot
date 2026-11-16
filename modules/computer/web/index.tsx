/**
 * Computer screen: a VNC-style viewer of each agent's display (live frames, owner take-over by click and text),
 * the recent actions, and the setup state (Linux helpers missing; macOS: a setup card per agent, off until the owner
 * says yes with the password, then step cards for PasaBot Screen Helper's permissions and a "Try it").
 * Also the module's chat cards (setup, watch live) and the picture inside each computer approval card.
 * Frames come from a fixed same-origin path built from the agent id; everything here is owner-only REST.
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { ApprovalDTO, MessageBlock } from '@pasabot/protocol';
import { Badge, Button, Card, Field, safeImageSrc } from '@pasabot/ui';
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

interface DisplayDTO {
  agentId: string;
  agentName: string;
  kind: 'xvfb' | 'macos' | 'practice';
  label: string;
  width: number;
  height: number;
  sharesOwnerScreen: boolean;
  /** this session confirmed it is the owner for this display of the owner's own Mac screen */
  watching: boolean;
  startedAt: number;
}
interface StatusDTO {
  driver: 'xvfb' | 'macos' | 'practice' | null;
  reason: 'off' | 'missing_bins' | 'macos_opt_in' | 'unsupported' | 'windows_soon' | null;
  missing: string[];
  platform: 'linux' | 'darwin' | 'other';
  macosAgents: { id: string; name: string; enabled: boolean }[];
  helper: HelperDTO | null;
  displays: DisplayDTO[];
}
interface ActionRow {
  id: string;
  agentId: string;
  agentName: string;
  actor: 'agent' | 'owner';
  kind: string;
  detail: string;
  ok: boolean;
  at: number;
}
type T = (k: string, o?: Record<string, unknown>) => string;

const LIVE_EVENT = 'pasabot:event';
const API = '/api/m/computer';

const translations = moduleTranslator(
  'computer',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): T {
  return useModuleT(translations).t;
}

async function call<R>(path: string, init: { method?: string; body?: unknown } = {}): Promise<R> {
  const r = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = (await r.json().catch(() => ({}))) as R & { error?: string; message?: string };
  if (!r.ok)
    throw Object.assign(new Error(j.message ?? `HTTP ${r.status}`), { code: j.error, status: r.status });
  return j;
}

/** fires `fn` for the module's live events (the shell re-dispatches what it does not keep) */
function useLive(types: string[], fn: (data: unknown) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = types.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: unknown }>).detail;
      if (d && wanted.has(d.type)) ref.current(d.data);
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => window.removeEventListener(LIVE_EVENT, on);
  }, [key]);
}

const wrap = { overflowWrap: 'anywhere' as const, minWidth: 0 };
const muted = { color: 'var(--bk-text-muted, inherit)', margin: 0 };

/**
 * The owner's own Mac screen is shown and driven only after the owner confirms it is them (a stolen session or an
 * unlocked phone sees nothing): a card with the password and one clear button, never a hidden settings page.
 */
function ConfirmView({
  agentId,
  again,
  t,
  onDone,
}: {
  agentId: string;
  again: boolean;
  t: T;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      try {
        await call('/api/v1/auth/reauth', { method: 'POST', body: { password } });
      } catch {
        setErr(t('watch.wrong'));
        return;
      }
      await call(`${API}/displays/${encodeURIComponent(agentId)}/watch`, { method: 'POST' });
      setPassword('');
      onDone();
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-computer-confirm={agentId}
      style={{
        display: 'grid',
        gap: 10,
        padding: 12,
        border: '1px solid var(--bk-border, #8884)',
        borderRadius: 10,
        minWidth: 0,
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (password) void confirm();
      }}
    >
      <strong style={wrap}>{t('watch.title')}</strong>
      <p style={{ ...muted, fontSize: 14, ...wrap }}>{again ? t('watch.again') : t('watch.body')}</p>
      <Field
        label={t('watch.password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger, #c0392b)', ...wrap }}>
          {err}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={busy || !password}>
          {t('watch.button')}
        </Button>
      </div>
    </form>
  );
}

function Viewer({
  d,
  t,
  onError,
  reload,
}: {
  d: DisplayDTO;
  t: T;
  onError: (m: string) => void;
  reload: () => void;
}) {
  const [n, setN] = useState(0);
  const [control, setControl] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [again, setAgain] = useState(false);
  const locked = d.sharesOwnerScreen && (again || !(d.watching || confirmed));
  // a fresh frame every second while the page is visible, and right after any action on this display
  useEffect(() => {
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') setN((x) => x + 1);
    }, 1000);
    return () => clearInterval(h);
  }, []);
  useLive(['computer.action'], (data) => {
    if ((data as { agentId?: string })?.agentId === d.agentId) setN((x) => x + 1);
  });
  const act = async (body: unknown) => {
    setBusy(true);
    try {
      await call(`${API}/displays/${encodeURIComponent(d.agentId)}/act`, { method: 'POST', body });
      setN((x) => x + 1);
    } catch (e) {
      // Take over on the owner's own Mac needs a fresh "it is me": the card asks again instead of an error line
      if ((e as { code?: string }).code === 'reauth_required') setAgain(true);
      else onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const click = (e: MouseEvent<HTMLImageElement>) => {
    if (!control) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(d.width - 1, Math.max(0, Math.floor(((e.clientX - r.left) * d.width) / r.width)));
    const y = Math.min(d.height - 1, Math.max(0, Math.floor(((e.clientY - r.top) * d.height) / r.height)));
    void act({ kind: 'click', x, y });
  };
  const stop = async () => {
    try {
      await call(`${API}/displays/${encodeURIComponent(d.agentId)}/stop`, { method: 'POST' });
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const src = locked
    ? undefined
    : safeImageSrc(`${API}/displays/${encodeURIComponent(d.agentId)}/frame?n=${n}`);
  return (
    <Card as="article" data-computer-display={d.agentId} style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18, ...wrap }}>{d.agentName}</h2>
        <Badge>{t('display.live')}</Badge>
        <span style={{ ...muted, fontSize: 14 }}>
          {d.sharesOwnerScreen ? t('display.shared') : t('display.own', { label: d.label })}
        </span>
      </header>
      {src && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: pointer take-over mirrors a mouse; keys go through the text box below
        <img
          data-computer-frame
          src={src}
          alt={t('display.alt', { name: d.agentName })}
          width={d.width}
          height={d.height}
          onClick={click}
          style={{
            width: '100%',
            maxWidth: d.width,
            height: 'auto',
            aspectRatio: `${d.width} / ${d.height}`,
            border: '1px solid var(--bk-border, #8884)',
            borderRadius: 8,
            background: '#111',
            cursor: control ? 'crosshair' : 'default',
            touchAction: 'manipulation',
          }}
        />
      )}
      {locked && (
        <ConfirmView
          agentId={d.agentId}
          again={again}
          t={t}
          onDone={() => {
            setConfirmed(true);
            setAgain(false);
            setN((x) => x + 1);
            reload();
          }}
        />
      )}
      {control && !locked && <p style={{ ...muted, fontSize: 14 }}>{t('display.controlHint')}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!locked && (
          <Button aria-pressed={control} onClick={() => setControl((c) => !c)}>
            {control ? t('display.release') : t('display.control')}
          </Button>
        )}
        <Button variant="danger" onClick={() => void stop()}>
          {t('display.stop')}
        </Button>
      </div>
      {control && !locked && (
        <form
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!text) return;
            void act({ kind: 'type', text }).then(() => setText(''));
          }}
        >
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <Field
              label={t('display.typeLabel')}
              // what the owner types here is often a password for a site on the agent's display: masked, never
              // autofilled or remembered by the browser, and never stored by the server (only its length)
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={busy || !text}>
            {t('display.send')}
          </Button>
        </form>
      )}
    </Card>
  );
}

interface HelperDTO {
  running: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  stopped: boolean;
  controlling: boolean;
  problem: string | null;
}

/** polls the Screen Helper's ticks while a setup card is open (every 2 s, only while the page is visible) */
function useHelper(on: boolean): [HelperDTO | null, () => void] {
  const [h, setH] = useState<HelperDTO | null>(null);
  const load = useCallback(async () => {
    try {
      setH((await call<{ helper: HelperDTO | null }>(`${API}/helper`)).helper);
    } catch {
      setH(null);
    }
  }, []);
  useEffect(() => {
    if (!on) return;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 2000);
    return () => clearInterval(t);
  }, [on, load]);
  useLive(['computer.helper'], () => void load());
  return [h, () => void load()];
}

function Tick({ done, t }: { done: boolean; t: T }) {
  return (
    <span
      data-done={done}
      role="img"
      aria-label={done ? t('card.steps.done') : t('card.steps.waiting')}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: 24,
        height: 24,
        borderRadius: 12,
        fontSize: 14,
        fontWeight: 700,
        background: done ? 'var(--bk-ok, #2e9e5b)' : 'transparent',
        color: done ? '#fff' : 'var(--bk-text-muted, inherit)',
        border: done ? 'none' : '2px solid var(--bk-border, #8886)',
        boxSizing: 'border-box',
      }}
    >
      {done ? '✓' : ''}
    </span>
  );
}

function Step({
  n,
  done,
  title,
  hint,
  t,
  children,
}: {
  n: string;
  done: boolean;
  title: string;
  hint?: string;
  t: T;
  children?: ReactNode;
}) {
  return (
    <li
      data-computer-step={n}
      data-done={done}
      style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        gap: 10,
        alignItems: 'start',
        padding: 12,
        border: '1px solid var(--bk-border, #8884)',
        borderRadius: 10,
      }}
    >
      <Tick done={done} t={t} />
      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <strong style={wrap}>{title}</strong>
        {hint && !done && <p style={{ ...muted, fontSize: 14, ...wrap }}>{hint}</p>}
        {children}
      </div>
    </li>
  );
}

/**
 * The setup card for one agent (owner's rule: everything a helper needs from the owner is a card with clear
 * buttons): "Let <name> use this computer?" → the password → step cards that tick as macOS reports each permission
 * → "Try it". The app only OPENS each System Settings pane; the owner flips the switch there.
 */
export function SetupFlow({
  agentId,
  agentName,
  enabled,
  t,
  reload,
  onDismiss,
}: {
  agentId: string;
  agentName: string;
  enabled: boolean;
  t: T;
  reload: () => void;
  onDismiss?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(0);
  const [h, reloadHelper] = useHelper(enabled);
  const set = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      if (on) {
        try {
          await call('/api/v1/auth/reauth', { method: 'POST', body: { password } });
        } catch {
          setErr(t('mac.wrong'));
          return;
        }
      }
      await call(`${API}/macos/${encodeURIComponent(agentId)}`, { method: 'PUT', body: { enabled: on } });
      if (on) setPassword('');
      setTried(0);
      reload();
      reloadHelper();
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const open = async (pane: 'screen' | 'accessibility') => {
    setErr(null);
    try {
      await call(`${API}/helper/open`, { method: 'POST', body: { pane } });
      reloadHelper();
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    }
  };
  const tryIt = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call(`${API}/try/${encodeURIComponent(agentId)}`, { method: 'POST' });
      setTried((n) => n + 1);
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const id = encodeURIComponent(agentId);

  if (!enabled)
    return (
      <Card
        as="section"
        data-computer-setup-card={agentId}
        data-state="ask"
        style={{ display: 'grid', gap: 12, minWidth: 0 }}
      >
        <h2 style={{ margin: 0, fontSize: 18, ...wrap }}>{t('card.ask.title', { name: agentName })}</h2>
        <p style={{ margin: 0, ...wrap }}>{t('card.ask.body', { name: agentName })}</p>
        <form
          style={{ display: 'grid', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void set(true);
          }}
        >
          <Field
            label={t('card.ask.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            error={err}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {t('card.ask.yes')}
            </Button>
            {onDismiss && (
              <Button type="button" onClick={onDismiss}>
                {t('card.ask.no')}
              </Button>
            )}
          </div>
        </form>
      </Card>
    );

  const running = h?.running === true;
  const screen = running && h.screenRecording;
  const access = running && h.accessibility;
  const ready = screen && access;
  return (
    <Card
      as="section"
      data-computer-setup-card={agentId}
      data-state={ready ? 'ready' : 'steps'}
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
    >
      <h2 style={{ margin: 0, fontSize: 18, ...wrap }}>{t('card.steps.title', { name: agentName })}</h2>
      {h?.stopped && (
        <p role="note" style={{ margin: 0, ...wrap }}>
          {t('card.steps.stopped')}
        </p>
      )}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        <Step
          n="helper"
          done={running}
          title={t('card.steps.helper')}
          hint={t('card.steps.helperHint')}
          t={t}
        />
        <Step n="screen" done={screen} title={t('card.steps.screen')} hint={t('card.steps.screenHint')} t={t}>
          {running && !screen && (
            <div>
              <Button variant="primary" onClick={() => void open('screen')}>
                {t('card.steps.openScreen')}
              </Button>
            </div>
          )}
        </Step>
        <Step n="access" done={access} title={t('card.steps.access')} hint={t('card.steps.accessHint')} t={t}>
          {screen && !access && (
            <div>
              <Button variant="primary" onClick={() => void open('accessibility')}>
                {t('card.steps.openAccess')}
              </Button>
            </div>
          )}
        </Step>
        <Step n="try" done={tried > 0} title={t('card.steps.try')} hint={t('card.steps.tryHint')} t={t}>
          {ready && (
            <div>
              <Button
                variant={tried > 0 ? 'secondary' : 'primary'}
                disabled={busy}
                onClick={() => void tryIt()}
              >
                {t('card.steps.tryButton')}
              </Button>
            </div>
          )}
          {tried > 0 && (
            <>
              <p style={{ margin: 0, ...wrap }}>{t('card.steps.tryDone', { name: agentName })}</p>
              <img
                data-computer-try
                src={safeImageSrc(`${API}/displays/${id}/preview?n=${tried}`)}
                alt={t('card.live.alt', { name: agentName })}
                style={{
                  width: '100%',
                  maxWidth: 360,
                  height: 'auto',
                  borderRadius: 8,
                  border: '1px solid var(--bk-border, #8884)',
                }}
              />
            </>
          )}
        </Step>
      </ol>
      {ready && tried > 0 && (
        <p style={{ margin: 0, ...wrap }}>{t('card.steps.ready', { name: agentName })}</p>
      )}
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
      <div>
        <Button onClick={() => void set(false)} disabled={busy}>
          {t('card.steps.off', { name: agentName })}
        </Button>
      </div>
    </Card>
  );
}

/** `#/computer?agent=<id>`: the setup card a link opened (the first-run "needs your OK" card for the main helper) */
const focusedAgent = (): string | null =>
  typeof location === 'undefined'
    ? null
    : new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent');

/**
 * macOS: one setup card per agent (off for every agent until the owner says yes for that one, with the password). A
 * link that names an agent (`?agent=`) puts that agent's card first and scrolls to it; opening it grants nothing.
 */
function MacSetup({ s, t, reload }: { s: StatusDTO; t: T; reload: () => void }) {
  const anyOn = s.macosAgents.some((a) => a.enabled);
  const focus = focusedAgent();
  const agents = [...s.macosAgents].sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0));
  const focused = focus ? agents.find((a) => a.id === focus) : undefined;
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  return (
    <section data-computer-mac={anyOn ? 'on' : 'off'} style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <p role="note" style={{ margin: 0, ...wrap }}>
        {t('mac.warning')}
      </p>
      {s.macosAgents.length === 0 && <p style={{ ...muted, margin: 0 }}>{t('mac.noAgents')}</p>}
      {agents.map((a) => (
        <div
          key={a.id}
          ref={a === focused ? ref : undefined}
          data-computer-setup-focus={a === focused ? '' : undefined}
          style={{ minWidth: 0 }}
        >
          <SetupFlow agentId={a.id} agentName={a.name} enabled={a.enabled} t={t} reload={reload} />
        </div>
      ))}
    </section>
  );
}

/** the setup card in an agent's chat (posted when it asked to use this Mac before it was set up) */
function SetupBlock({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as { agentId: string; agentName: string };
  const [s, setS] = useState<StatusDTO | null>(null);
  const [hidden, setHidden] = useState(false);
  const load = useCallback(async () => {
    try {
      setS(await call<StatusDTO>(`${API}/status`));
    } catch {
      setS(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (hidden || !s) return null;
  const a = s.macosAgents.find((x) => x.id === d.agentId);
  if (!a) return null;
  return (
    <div data-computer-chat-card="setup" style={{ minWidth: 0 }}>
      <SetupFlow
        agentId={a.id}
        agentName={a.name}
        enabled={a.enabled}
        t={t}
        reload={() => void load()}
        onDismiss={() => setHidden(true)}
      />
    </div>
  );
}

/** "watch live" in the agent's chat: the live picture with Take over and Stop */
function LiveBlock({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as { agentId: string; agentName: string };
  const [running, setRunning] = useState<boolean | null>(null);
  // the owner's own Mac screen: shown here only once this session confirmed it is the owner
  const [locked, setLocked] = useState(false);
  const [n, setN] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const check = useCallback(async () => {
    try {
      const st = await call<StatusDTO>(`${API}/status`);
      const disp = st.displays.find((x) => x.agentId === d.agentId);
      setRunning(!!disp);
      setLocked(!!disp && disp.sharesOwnerScreen && !disp.watching);
    } catch {
      setRunning(false);
    }
  }, [d.agentId]);
  useEffect(() => {
    void check();
  }, [check]);
  useLive(['computer.display', 'computer.action'], (data) => {
    if ((data as { agentId?: string })?.agentId === d.agentId) {
      void check();
      setN((x) => x + 1);
    }
  });
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') setN((x) => x + 1);
    }, 1500);
    return () => clearInterval(h);
  }, [running]);
  const stop = async () => {
    try {
      await call(`${API}/displays/${encodeURIComponent(d.agentId)}/stop`, { method: 'POST' });
      setRunning(false);
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    }
  };
  return (
    <Card
      as="section"
      data-computer-chat-card="live"
      data-running={running === true}
      style={{ display: 'grid', gap: 10, minWidth: 0 }}
    >
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong style={wrap}>
          {running ? t('card.live.title', { name: d.agentName }) : t('card.live.idle', { name: d.agentName })}
        </strong>
        {running && <Badge>{t('display.live')}</Badge>}
      </header>
      {running && locked && (
        <ConfirmView agentId={d.agentId} again={false} t={t} onDone={() => void check()} />
      )}
      {running && !locked && (
        <img
          data-computer-live
          src={safeImageSrc(`${API}/displays/${encodeURIComponent(d.agentId)}/frame?n=${n}`)}
          alt={t('card.live.alt', { name: d.agentName })}
          style={{
            width: '100%',
            maxWidth: 480,
            height: 'auto',
            borderRadius: 8,
            border: '1px solid var(--bk-border, #8884)',
            background: '#111',
          }}
        />
      )}
      {running && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button
            variant="primary"
            onClick={() => {
              window.location.hash = '#/computer';
            }}
          >
            {t('card.live.takeOver')}
          </Button>
          <Button variant="danger" onClick={() => void stop()}>
            {t('card.live.stop')}
          </Button>
          <span style={{ ...muted, fontSize: 14 }}>{t('card.live.stopHint')}</span>
        </div>
      )}
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
    </Card>
  );
}

/**
 * Inside a computer tool's approval card: the newest picture of the screen with a red ring where it will click or
 * move, or what it will type or press. Never a new capture (that would need the yes this card is asking for).
 */
function ActionPreview({ approval }: { approval: ApprovalDTO }) {
  const t = useT();
  const act = approval.action as { tool?: string; input?: Record<string, unknown> } | null;
  const tool = act?.tool ?? '';
  const i = act?.input ?? {};
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [missing, setMissing] = useState(false);
  // an action on this display (another approved card, the owner's take over) makes the picture out of date: ask
  // again, and the server answers "no current picture" until a new screenshot
  const [v, setV] = useState(0);
  useLive(['computer.action'], (data) => {
    if (approval.agentId && (data as { agentId?: string })?.agentId === approval.agentId) {
      setMissing(false);
      setV((x) => x + 1);
    }
  });
  const x = typeof i.x === 'number' ? i.x : null;
  const y = typeof i.y === 'number' ? i.y : null;
  const pointer = (tool === 'computer_click' || tool === 'computer_move') && x !== null && y !== null;
  const text =
    tool === 'computer_click'
      ? t(i.button === 'right' ? 'preview.rightClick' : 'preview.click')
      : tool === 'computer_move'
        ? t('preview.move')
        : tool === 'computer_type'
          ? t('preview.type', { count: typeof i.text === 'string' ? i.text.length : 0 })
          : tool === 'computer_key'
            ? t('preview.key', { keys: String(i.keys ?? '') })
            : t('preview.screenshot');
  const showPicture = tool !== 'computer_type' && tool !== 'computer_key';
  const src = approval.agentId
    ? safeImageSrc(`${API}/displays/${encodeURIComponent(approval.agentId)}/preview?a=${approval.id}&v=${v}`)
    : undefined;
  return (
    <div data-computer-preview={tool} style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <p style={{ margin: 0, ...wrap }}>{text}</p>
      {tool === 'computer_type' && typeof i.text === 'string' && (
        // the text as the server stored it for this card (vault secrets are already blanked out)
        <code data-computer-preview-text style={{ ...wrap, whiteSpace: 'pre-wrap', fontSize: 14 }}>
          {i.text}
        </code>
      )}
      {showPicture && src && !missing && (
        <div style={{ position: 'relative', width: '100%', maxWidth: 280, lineHeight: 0 }}>
          <img
            data-computer-preview-img
            src={src}
            alt={t('preview.alt')}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setMissing(true)}
            style={{
              width: '100%',
              height: 'auto',
              borderRadius: 6,
              border: '1px solid var(--bk-border, #8884)',
            }}
          />
          {pointer && size && (
            <span
              data-computer-preview-mark
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${((x ?? 0) / size.w) * 100}%`,
                top: `${((y ?? 0) / size.h) * 100}%`,
                width: 18,
                height: 18,
                marginLeft: -9,
                marginTop: -9,
                borderRadius: 9,
                border: '3px solid #e5383b',
                boxShadow: '0 0 0 2px #fff',
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      )}
      {showPicture && missing && (
        <p data-computer-preview-none style={{ ...muted, fontSize: 14 }}>
          {t('preview.noCurrent')}
        </p>
      )}
    </div>
  );
}

function ComputerPage() {
  const t = useT();
  const [s, setS] = useState<StatusDTO | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [st, a] = await Promise.all([
        call<StatusDTO>(`${API}/status`),
        call<{ actions: ActionRow[] }>(`${API}/actions`),
      ]);
      setS(st);
      setActions(a.actions);
    } catch (e) {
      setErr(t('error', { msg: (e as Error).message }));
    }
  }, [t]);
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [load]);
  useLive(['computer.action', 'computer.display'], () => void load());
  const onError = useCallback((m: string) => setErr(t('error', { msg: m })), [t]);

  return (
    <section
      data-slot="route"
      data-testid="computer-page"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 1040,
        paddingInline: 16,
        marginInline: 'auto',
        minWidth: 0,
      }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ ...muted, fontSize: 15 }}>{t('page.intro')}</p>
      </header>
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
      {s && !s.driver && s.reason !== 'macos_opt_in' && (
        <Card as="section" data-computer-setup={s.reason ?? ''} style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('setup.title')}</h2>
          <p style={{ margin: 0, ...wrap }}>
            {s.reason === 'missing_bins'
              ? t('setup.missing_bins', { list: s.missing.join(', ') })
              : t(`setup.${s.reason ?? 'off'}`)}
          </p>
        </Card>
      )}
      {s && (s.reason === 'macos_opt_in' || s.driver === 'macos') && (
        <MacSetup s={s} t={t} reload={() => void load()} />
      )}
      {s?.driver === 'practice' && <p style={{ ...muted, fontSize: 14 }}>{t('setup.practice')}</p>}
      {s && s.displays.length === 0 && <p data-computer-empty>{t('page.empty')}</p>}
      {s?.displays.map((d) => (
        <Viewer key={d.agentId} d={d} t={t} onError={onError} reload={() => void load()} />
      ))}
      <section aria-labelledby="computer-activity" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <h2 id="computer-activity" style={{ margin: 0, fontSize: 18 }}>
          {t('activity.title')}
        </h2>
        {actions.length === 0 && <p style={muted}>{t('activity.empty')}</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {actions.slice(0, 20).map((a) => (
            <li
              key={a.id}
              data-computer-action={a.kind}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', fontSize: 15 }}
            >
              <strong>{a.actor === 'owner' ? t('activity.you') : a.agentName}</strong>
              <code style={wrap}>{a.detail}</code>
              {!a.ok && <Badge>{t('activity.failed')}</Badge>}
              <time dateTime={new Date(a.at).toISOString()} style={{ ...muted, fontSize: 13 }}>
                {new Date(a.at).toLocaleTimeString(displayLocale())}
              </time>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

const mod: WebModule = {
  id: 'computer',
  messageBlockRenderers: { 'computer.setup': SetupBlock, 'computer.live': LiveBlock },
  approvalPreviews: {
    computer_screenshot: ActionPreview,
    computer_click: ActionPreview,
    computer_move: ActionPreview,
    computer_type: ActionPreview,
    computer_key: ActionPreview,
  },
  routes: [{ path: '/computer', component: ComputerPage, titleKey: 'computer:page.title' }],
  navItems: [
    {
      id: 'computer',
      labelKey: 'computer:nav',
      hintKey: 'computer:find.navHint',
      keywordsKey: 'computer:find.navKeywords',
      to: '/computer',
      icon: 'monitor',
      group: 'tools',
      order: 330,
    },
  ],
};
export default mod;
