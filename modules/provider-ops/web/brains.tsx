/**
 * The Brains page (SPEC "Simplify" §5): a tile per brain with its real state, one primary action per state, plain
 * steps with copy buttons, and the owner's Test. PasaBot never asks for a brain's password: signing in is the CLI's
 * own command in the owner's terminal; an API key goes into the vault. Test results live only in this page's memory.
 */
import { documentLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, BrandTile, Button, Card, Field, Icon, Sheet } from '@pasabot/ui';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';

const NS = 'provider-ops';
const translations = moduleTranslator(
  NS,
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
  {
    prefix: 'brains.',
  },
);
const useT = () => useModuleT(translations);
const API = '/api/m/provider-ops';
const go = (path: string) => {
  window.location.hash = `#${path}`;
};

export type BrainState = 'ready' | 'needs_sign_in' | 'not_installed' | 'unreachable';
export type BrainProblem = 'not_installed' | 'auth' | 'limit' | 'offline' | 'model' | 'timeout' | 'crash';
export interface Brain {
  id: string;
  name: string;
  description: string;
  stateLabel: string;
  monogram: string;
  state: BrainState;
  unconfirmed: boolean;
  /** the last test or turn failed on sign-in: "Check again" runs the test (only one that works clears it) */
  failedSignIn?: boolean;
  version?: string;
  installCmd?: string[];
  signInCmd?: string[];
  vaultKey?: string;
  installer?: 'starter';
  providers: { id: string; name: string; state: BrainState; version?: string }[];
  usedBy: { id: string; name: string; role: 'main' | 'backup' }[];
}
type TestResult =
  | { ok: true; reply: string; ms: number; model?: string; providerId?: string }
  | { ok: false; problem: BrainProblem | 'busy' | 'failed'; message: string; ms?: number; resetAt?: number };

/** the PasaBot server runs on Windows: the setup steps say PowerShell and Enter, not Terminal and Return */
let serverOnWindows = false;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
    const e = new Error(body.message ?? `HTTP ${r.status}`) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return (await r.json()) as T;
}

/** The brains with live detection (owner only). `null` while loading. */
export function useBrains() {
  const [brains, setBrains] = useState<Brain[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    call<{ brains: Brain[]; serverOs?: 'windows' }>(
      `${API}/brains?lang=${encodeURIComponent(documentLocale())}`,
    )
      .then((r) => {
        serverOnWindows = r.serverOs === 'windows';
        setBrains(r.brains);
      })
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);
  return { brains, error, reload: load };
}

/** An icon from the shared set in @pasabot/ui by name (SPEC §7); decorative, the label beside it carries the meaning. */
export function UiIcon({ name, size = 20 }: { name: string; size?: number }) {
  return <Icon name={name} size={size} />;
}

/** A brain's icon tile (polish B): its mark in our own tone, never letters. Decorative; the name beside it speaks. */
export function BrainIcon({ id, size = 48 }: { id: string; size?: number }) {
  return <BrandTile id={id} size={size} fallback="brain" />;
}

/**
 * The person's "Technical words" switch (Settings, pref `ui.advanced`): the shell mirrors it on `<html
 * data-advanced>` and fires `pasabot:advanced` (a module cannot import the shell). On: versions and model names show.
 */
export function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

const CHIP_ICON: Record<BrainState, string> = {
  ready: 'check-circle',
  needs_sign_in: 'key',
  not_installed: 'download',
  unreachable: 'cloud-off',
};
export function StateChip({ state, label }: { state: BrainState; label: string }) {
  const quiet = state === 'not_installed';
  // the green of "Ready" is below 4.5:1 for 12 px text on a light card: the word stays ink, the icon carries the green
  const style: CSSProperties =
    state === 'ready'
      ? { color: 'var(--bk-ink)' }
      : state === 'unreachable'
        ? { color: 'var(--bk-danger)' }
        : state === 'needs_sign_in'
          ? { color: 'var(--bk-signal-ink, var(--bk-ink))', background: 'var(--bk-signal, var(--bk-soft))' }
          : { color: 'var(--bk-muted)' };
  return (
    <Badge
      tone={state === 'needs_sign_in' ? 'signal' : 'outline'}
      data-state={state}
      style={{
        display: 'inline-flex',
        gap: 4,
        alignItems: 'center',
        whiteSpace: 'nowrap',
        fontSize: 12,
        ...(quiet ? { borderColor: 'transparent', paddingInline: 0 } : {}),
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', ...(state === 'ready' ? { color: 'var(--bk-work)' } : {}) }}>
        <UiIcon name={CHIP_ICON[state]} size={16} />
      </span>
      {label}
    </Badge>
  );
}

const muted: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--bk-muted)', overflowWrap: 'anywhere' };
const row: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 };

function IconButton({
  icon,
  children,
  ...rest
}: { icon: string; children: ReactNode } & Parameters<typeof Button>[0]) {
  return (
    <Button {...rest} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', ...(rest.style ?? {}) }}>
      <UiIcon name={icon} size={20} />
      {children}
    </Button>
  );
}

function CopyLine({ cmd }: { cmd: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <span style={{ ...row, flexWrap: 'nowrap' }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          padding: '8px 10px',
          borderRadius: 10,
          background: 'var(--bk-soft)',
          overflowWrap: 'anywhere',
        }}
        data-cmd
      >
        {cmd}
      </code>
      <IconButton
        icon="copy"
        size="sm"
        style={{ minHeight: 44 }}
        aria-label={`${done ? t('copied') : t('copy')}: ${cmd}`}
        onClick={() => {
          navigator.clipboard?.writeText(cmd).then(
            () => setDone(true),
            () => setDone(false),
          );
        }}
      >
        {done ? t('copied') : t('copy')}
      </IconButton>
      <span className="bk-visually-hidden" role="status" aria-live="polite">
        {done ? t('copied') : ''}
      </span>
    </span>
  );
}

type StarterInfo = { what: string; where: string; from: string };
/** what the free starter's installer will fetch (the templates module), or null when it cannot install here */
function useStarterInfo(on: boolean): StarterInfo | null {
  const [info, setInfo] = useState<StarterInfo | null>(null);
  useEffect(() => {
    if (!on) return;
    call<{ providers: ({ id: string } & StarterInfo)[] }>('/api/m/templates/providers/installable')
      .then((r) => setInfo(r.providers.find((p) => p.id === 'opencode') ?? null))
      .catch(() => setInfo(null));
  }, [on]);
  return info;
}

/**
 * the checksum-verified free-starter installer of the templates module (consent first: what, where, from). With
 * Technical words off it says what happens in plain words; the app's name, the folder and the download address
 * show only with Technical words on.
 */
function StarterInstall({
  info,
  technical,
  onDone,
}: {
  info: StarterInfo;
  technical: boolean;
  onDone(): void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // the raw reason, shown only under "Details"
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="brain-starter-install">
      <p style={{ margin: 0 }}>{technical ? t('step.starter') : t('step.starterPlain')}</p>
      {technical && (
        <ul
          style={{ ...muted, paddingInlineStart: 18, display: 'grid', gap: 2, overflowWrap: 'anywhere' }}
          data-testid="brain-starter-facts"
        >
          <li>{info.what}</li>
          <li>{info.where}</li>
          <li>{info.from}</li>
        </ul>
      )}
      <div>
        <IconButton
          icon="download"
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(false);
            setReason('');
            try {
              await call('/api/m/templates/providers/opencode/install', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ consent: true }),
              });
              onDone();
            } catch (e) {
              setErr(true);
              setReason((e as Error).message ?? '');
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('step.starterCta')}
        </IconButton>
      </div>
      {err && (
        <div style={{ display: 'grid', gap: 4 }} data-testid="brain-starter-error">
          <p role="alert" style={{ ...muted, color: 'var(--bk-danger)' }}>
            {t('step.starterFailed')}
          </p>
          {reason && (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={open}
                style={{ justifySelf: 'start', minHeight: 44 }}
                onClick={() => setOpen((v) => !v)}
              >
                {t('details')}
              </Button>
              {open && (
                <pre
                  style={{ ...muted, margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}
                  data-testid="brain-starter-error-detail"
                >
                  {reason}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Add key" right in the steps: the value goes straight to the vault module's owner-only save, into the brain's own
 * `brain:<id>` scope under the key name the brain declares. It is a password field, kept only in this component
 * until it is sent, cleared after, and never shown, logged or returned (the answer carries only scope and name).
 */
function KeyInline({ brain, onSaved }: { brain: Brain; onSaved(): void }) {
  const { t } = useT();
  // Claude's headless sign-in: the token `claude setup-token` prints (the CLI reads it as CLAUDE_CODE_OAUTH_TOKEN)
  const token = brain.id === 'claude';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'saved' | 'error'>('idle');
  if (!brain.vaultKey) return null;
  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setState('idle');
    try {
      await call('/api/m/vault/secrets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: `brain:${brain.id}`, name: brain.vaultKey, value: value.trim() }),
      });
      setValue('');
      setState('saved');
      onSaved();
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={save}
      style={{ display: 'grid', gap: 8 }}
      data-testid="brain-key-form"
      data-kind={token ? 'setup-token' : 'key'}
    >
      {token ? (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>{t('step.tokenTitle')}</p>
          <p style={muted}>{t('step.tokenWhy')}</p>
          <ol style={{ margin: 0, paddingInlineStart: 22, display: 'grid', gap: 8 }}>
            <li>
              <span style={{ display: 'grid', gap: 6 }}>
                {t('step.tokenRun')}
                <CopyLine cmd="claude setup-token" />
              </span>
            </li>
            <li>{t('step.tokenPaste')}</li>
          </ol>
        </>
      ) : (
        <p style={{ margin: 0 }}>{t('step.vault', { name: brain.vaultKey })}</p>
      )}
      <Field
        label={token ? t('step.tokenLabel') : t('step.keyLabel', { brain: brain.name })}
        hint={token ? t('step.tokenWho') : t('step.keyWho')}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue((e.target as HTMLInputElement).value);
          if (state !== 'idle') setState('idle');
        }}
      />
      <div>
        <IconButton icon="lock" variant="primary" type="submit" disabled={busy || !value.trim()}>
          {token ? t('step.tokenSave') : t('step.keySave')}
        </IconButton>
      </div>
      <p role="status" aria-live="polite" style={muted} data-testid="brain-key-status">
        {state === 'saved' ? (token ? t('step.tokenSaved') : t('step.keySaved')) : ''}
      </p>
      {state === 'error' && (
        <p role="alert" style={{ ...muted, color: 'var(--bk-danger)' }}>
          {token ? t('step.tokenErr') : t('step.keyErr')}
        </p>
      )}
    </form>
  );
}

/** Plain numbered steps to install / sign in / reach a brain (side sheet; a bottom sheet on a phone). */
export function StepsSheet({
  brain,
  onClose,
  onCheck,
}: {
  brain: Brain | null;
  onClose(): void;
  onCheck(): void;
}) {
  const { t } = useT();
  const technical = useTechnical();
  const b = brain;
  const steps: ReactNode[] = [];
  const starterHere = !!b && b.installer === 'starter' && b.state === 'not_installed';
  const starter = useStarterInfo(starterHere);
  // the free starter in plain words: one tap installs it, so the Terminal steps are technical setup
  const plainStarter = starterHere && !!starter && !technical;
  if (b && !plainStarter) {
    const sign = b.state === 'needs_sign_in' || (b.state === 'ready' && b.unconfirmed);
    if (b.id === 'local') steps.push(t('step.local'));
    else if (b.id === 'acp') steps.push(t('step.acp'));
    else if (sign && b.signInCmd) {
      steps.push(t(serverOnWindows ? 'step.terminalWindows' : 'step.terminal'));
      steps.push(
        <span key="s" style={{ display: 'grid', gap: 6 }}>
          {t('step.signIn')}
          <CopyLine cmd={b.signInCmd.join(' ')} />
          {b.id === 'gemini' && <span style={muted}>{t('step.geminiChoose')}</span>}
        </span>,
      );
      steps.push(t('step.back'));
    } else if (b.installCmd) {
      steps.push(t(serverOnWindows ? 'step.terminalWindows' : 'step.terminal'));
      // Windows: npm comes with Node.js, which PasaBot's own copy does not put on the PATH
      if (serverOnWindows && b.installCmd[0] === 'npm') steps.push(t('step.nodeFirstWindows'));
      steps.push(
        <span key="i" style={{ display: 'grid', gap: 6 }}>
          {t(serverOnWindows ? 'step.pasteWindows' : 'step.paste')}
          <CopyLine cmd={b.installCmd.join(' ')} />
        </span>,
      );
      if (b.signInCmd)
        steps.push(
          <span key="s" style={{ display: 'grid', gap: 6 }}>
            {t('step.signIn')}
            <CopyLine cmd={b.signInCmd.join(' ')} />
          </span>,
        );
      steps.push(t('step.back'));
    } else if (b.id === 'grok') {
      steps.push(t('step.grokInstall'));
      if (b.signInCmd)
        steps.push(
          <span key="s" style={{ display: 'grid', gap: 6 }}>
            {t('step.signIn')}
            <CopyLine cmd={b.signInCmd.join(' ')} />
          </span>,
        );
      steps.push(t('step.back'));
    }
  }
  return (
    <Sheet
      open={!!b}
      title={b ? t('stepsTitle', { name: t.has(`name.${b.id}`) ? t(`name.${b.id}`) : b.name }) : ''}
      onClose={onClose}
    >
      {b && (
        <div style={{ display: 'grid', gap: 12 }} data-testid="brain-steps" data-brain={b.id}>
          {steps.length > 0 && (
            <ol style={{ margin: 0, paddingInlineStart: 22, display: 'grid', gap: 10 }}>
              {steps.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed list per brain
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
          {starterHere && starter && (
            <StarterInstall
              info={starter}
              technical={technical}
              onDone={() => {
                onCheck();
                onClose();
              }}
            />
          )}
          {/* Claude's setup token is a way to sign an installed CLI in: not offered before it is installed */}
          {b.vaultKey && (b.id !== 'claude' || b.state !== 'not_installed') && (
            <KeyInline key={b.id} brain={b} onSaved={onCheck} />
          )}
          {(b.id === 'local' || b.id === 'acp') && (
            <div>
              {/* straight to that section of Settings › Agents & brains (its feature id is the section id) */}
              <IconButton
                icon="settings"
                variant="primary"
                data-action="setup"
                onClick={() =>
                  go(b.id === 'local' ? '/settings/agents/local' : '/settings/agents/acp-agents')
                }
              >
                {b.id === 'local' ? t('step.localCta') : t('step.acpCta')}
              </IconButton>
            </div>
          )}
          {b.signInCmd && <p style={muted}>{t('step.noPassword')}</p>}
          <div style={row}>
            <IconButton
              icon="refresh"
              variant="primary"
              onClick={() => {
                onCheck();
                onClose();
              }}
            >
              {t('checkAgain')}
            </IconButton>
            <IconButton icon="close" variant="ghost" onClick={onClose}>
              {t('close')}
            </IconButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ResultLine({ r, version }: { r: TestResult | 'running'; version?: string }) {
  const { t, lang } = useT();
  const technical = useTechnical();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (r === 'running') return null;
  const box: CSSProperties = {
    borderBlockStart: '1px solid var(--bk-line)',
    paddingBlockStart: 10,
    display: 'grid',
    gap: 6,
    minWidth: 0,
  };
  if (r.ok) {
    const secs = (r.ms / 1000).toLocaleString(lang, { maximumFractionDigits: 1 });
    return (
      <div style={box} data-testid="brain-test-result" data-ok="true">
        <span style={{ ...row, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--bk-work)', display: 'inline-flex' }}>
            <UiIcon name="check-circle" />
          </span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--bk-ink)' }}>
            {t('works', { reply: r.reply.length > 60 ? `${r.reply.slice(0, 60)}…` : r.reply, secs })}
            {technical && r.model ? ` · ${r.model}` : ''}
            {technical && version ? ` · v${version}` : ''}
          </span>
        </span>
      </div>
    );
  }
  // a usage limit with a known reset names the time (in the reader's language and clock)
  const text =
    r.problem === 'limit' && r.resetAt
      ? t('err.limitAt', {
          time: new Date(r.resetAt).toLocaleString(lang, {
            hour: 'numeric',
            minute: '2-digit',
            ...(r.resetAt - Date.now() > 20 * 3600_000 ? { weekday: 'short' } : {}),
          }),
        })
      : t(`err.${r.problem === 'not_installed' ? 'notInstalled' : r.problem}`);
  return (
    <div style={box} data-testid="brain-test-result" data-ok="false" data-problem={r.problem} role="alert">
      <span style={{ ...row, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--bk-danger)', display: 'inline-flex' }}>
          <UiIcon name="alert" />
        </span>
        <span style={{ minWidth: 0 }}>{text}</span>
      </span>
      {r.message && (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            style={{ justifySelf: 'start', minHeight: 44 }}
            onClick={() => setOpen((v) => !v)}
          >
            {t('details')}
          </Button>
          {open && (
            <pre
              id={detailsId}
              style={{ ...muted, margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}
              data-testid="brain-test-details"
            >
              {r.message}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function BrainTile({
  b,
  result,
  hero,
  onTest,
  onSteps,
  onCheck,
}: {
  b: Brain;
  result: TestResult | 'running' | undefined;
  /** the brain the agents use: shown first, as the "In use" card (polish B) */
  hero?: boolean;
  onTest(): void;
  onSteps(): void;
  onCheck(): void;
}) {
  const { t } = useT();
  const technical = useTechnical();
  const usable = b.providers.find((p) => p.state === 'ready');
  const openNew = () => usable && go(`/agents/new?brain=${encodeURIComponent(usable.id)}`);
  const running = result === 'running';
  const testBtn = (variant: 'primary' | 'secondary') => (
    <IconButton icon="play" variant={variant} disabled={running} onClick={onTest} data-action="test">
      {running ? t('testing') : t('test')}
    </IconButton>
  );
  const newBtn = (variant: 'primary' | 'secondary') => (
    <IconButton icon="plus" variant={variant} onClick={openNew} data-action="use-new">
      {t('useNew')}
    </IconButton>
  );
  let actions: ReactNode;
  if (b.state === 'not_installed')
    actions = (
      <IconButton
        icon={b.id === 'acp' ? 'search' : 'download'}
        variant="primary"
        onClick={onSteps}
        data-action="install"
      >
        {b.id === 'acp' ? t('browse') : t('install')}
      </IconButton>
    );
  else if (b.state === 'needs_sign_in')
    actions = (
      <>
        <IconButton icon="key" variant="primary" onClick={onSteps} data-action="sign-in">
          {t('signIn')}
        </IconButton>
        <IconButton icon="refresh" onClick={onCheck} data-action="check">
          {t('checkAgain')}
        </IconButton>
      </>
    );
  else if (b.state === 'unreachable')
    actions = (
      <>
        <IconButton icon="refresh" variant="primary" onClick={onCheck} data-action="check">
          {t('checkAgain')}
        </IconButton>
        <Button onClick={onSteps} data-action="steps">
          {t('steps')}
        </Button>
      </>
    );
  else if (b.usedBy.length)
    actions = (
      <>
        {testBtn('secondary')}
        {newBtn('secondary')}
      </>
    );
  else
    actions = (
      <>
        {newBtn('secondary')}
        {testBtn('secondary')}
      </>
    );
  const main = b.usedBy.filter((u) => u.role === 'main').map((u) => u.name);
  const backup = b.usedBy.filter((u) => u.role === 'backup').map((u) => u.name);
  // the server sends the technical name and line; a known brain reads its own strings here, so Settings' plain
  // words (Technical words off) reach them too ("Local model" reads "A brain on this computer")
  const shownName = t.has(`name.${b.id}`) ? t(`name.${b.id}`) : b.name;
  const description = t.has(`desc.${b.id}`) ? t(`desc.${b.id}`) : b.description;
  // which apps a Local / ACP brain found; the version only with "Technical words" on (one plain status otherwise)
  const sub =
    (b.id === 'local' || b.id === 'acp') && b.providers.some((p) => p.state !== 'not_installed')
      ? b.providers
          .filter((p) => p.state !== 'not_installed')
          .map((p) => p.name)
          .join(' · ')
      : technical && b.version
        ? `v${b.version}`
        : '';
  const label = b.state === 'not_installed' ? t('notHere') : b.stateLabel;
  const name = (
    <h2
      id={`brain-${b.id}`}
      style={{
        margin: 0,
        fontSize: hero ? 19 : 17,
        fontWeight: 700,
        overflowWrap: 'anywhere',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {hero ? t('inUse', { name: shownName }) : shownName}
      {hero && b.state === 'ready' && (
        <span style={{ color: 'var(--bk-work)', display: 'inline-flex' }}>
          <UiIcon name="check-circle" size={20} />
        </span>
      )}
    </h2>
  );
  const body = (
    <>
      {!hero && <p style={muted}>{description}</p>}
      {b.state === 'ready' && b.unconfirmed && <p style={{ ...muted, fontSize: 13 }}>{t('unconfirmed')}</p>}
      {main.length > 0 && (
        <p style={{ ...muted, color: 'var(--bk-ink)' }}>{t('usedBy', { names: main.join(', ') })}</p>
      )}
      {backup.length > 0 && <p style={muted}>{t('backupFor', { names: backup.join(', ') })}</p>}
      <div role="status" aria-live="polite" data-testid="brain-test-status">
        {running ? (
          <span className="bk-visually-hidden">{t('testing')}</span>
        ) : (
          result?.ok && <ResultLine r={result} version={b.version} />
        )}
      </div>
      {result && result !== 'running' && !result.ok && <ResultLine r={result} />}
    </>
  );
  if (hero)
    return (
      <Card
        as="article"
        data-testid="brain-tile"
        data-brain={b.id}
        data-state={b.state}
        data-hero="true"
        aria-labelledby={`brain-${b.id}`}
        style={{
          padding: 20,
          borderRadius: 20,
          display: 'flex',
          gap: 16,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          minWidth: 0,
          background: 'var(--bk-soft)',
          borderColor: 'transparent',
        }}
      >
        <BrainIcon id={b.id} size={52} />
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'grid', gap: 4 }}>
          {name}
          {sub && <span style={{ ...muted, fontSize: 13 }}>{sub}</span>}
          {body}
        </div>
        <div style={{ ...row, flex: '0 1 auto', maxInlineSize: '100%' }}>{actions}</div>
      </Card>
    );
  return (
    <Card
      as="article"
      data-testid="brain-tile"
      data-brain={b.id}
      data-state={b.state}
      aria-labelledby={`brain-${b.id}`}
      style={{ padding: 20, borderRadius: 20, display: 'grid', gap: 8, alignContent: 'start', minWidth: 0 }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <BrainIcon id={b.id} size={48} />
        <StateChip state={b.state} label={label} />
      </div>
      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        {name}
        {sub && <span style={{ ...muted, fontSize: 13 }}>{sub}</span>}
      </div>
      {body}
      <div style={{ ...row, marginBlockStart: 4 }}>{actions}</div>
    </Card>
  );
}

/** where the Brains page lives (SPEC "Simplify" 5: Settings › Agents & brains) */
export const BRAINS_PATH = '/settings/agents/brains';

/** `#/brains` from older links: replaced by the page's own address, so Back skips it */
export function BrainsRedirect() {
  useEffect(() => {
    location.replace(`#${BRAINS_PATH}`);
  }, []);
  return null;
}

export function BrainsPage() {
  const { t } = useT();
  const { brains, error, reload } = useBrains();
  const [results, setResults] = useState<Record<string, TestResult | 'running'>>({});
  const [steps, setSteps] = useState<string | null>(null);
  const check = () => {
    setResults({});
    reload();
  };
  /** "Check again" on one brain: a remembered sign-in failure is only cleared by a test that works */
  const checkBrain = (b: Brain | undefined) => {
    if (b?.failedSignIn) void test(b);
    else check();
  };
  const test = async (b: Brain) => {
    const usable = b.providers.find((p) => p.state === 'ready') ?? b.providers[0];
    setResults((r) => ({ ...r, [b.id]: 'running' }));
    let out: TestResult;
    try {
      const r = await call<{ result: TestResult }>(`${API}/brains/${encodeURIComponent(b.id)}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(usable ? { providerId: usable.id } : {}),
      });
      out = r.result;
    } catch (e) {
      out = {
        ok: false,
        problem: (e as { status?: number }).status === 429 ? 'busy' : 'failed',
        message: '',
      };
    }
    setResults((r) => ({ ...r, [b.id]: out }));
    // the tile follows how the test went (a sign-in failure turns it into Needs sign-in, a working one clears it)
    if (out.ok || out.problem === 'auth') reload();
  };
  const none = brains && !brains.some((b) => b.state === 'ready' && b.id !== 'fake');
  const starter = brains?.find((b) => b.id === 'opencode');
  // "In use": the brain most agents think with (polish B), shown first; every other brain follows in the grid
  const mains = (b: Brain) => b.usedBy.filter((u) => u.role === 'main').length;
  const inUse = brains?.reduce<Brain | null>(
    (best, b) => (mains(b) > (best ? mains(best) : 0) ? b : best),
    null,
  );
  const tile = (b: Brain, hero?: boolean) => (
    <BrainTile
      key={b.id}
      b={b}
      hero={hero}
      result={results[b.id]}
      onTest={() => void test(b)}
      onSteps={() => setSteps(b.id)}
      onCheck={() => checkBrain(b)}
    />
  );
  return (
    <section
      style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 1180, minWidth: 0 }}
      data-testid="brains-page"
    >
      <h1 style={{ margin: 0, fontSize: 28 }}>{t('title')}</h1>
      <p style={{ ...muted, maxWidth: 640 }}>{t('intro')}</p>
      {error && (
        <p role="alert" style={muted}>
          {t('err.load')}
        </p>
      )}
      {!brains && !error && (
        <p style={muted} role="status">
          {t('state.checking')}
        </p>
      )}
      {none && starter && (
        <Card style={{ padding: 16, display: 'grid', gap: 8 }} data-testid="brains-none-ready">
          <p style={{ margin: 0 }}>{t('noneReady')}</p>
          <div>
            <IconButton icon="sparkle" variant="primary" onClick={() => setSteps('opencode')}>
              {t('useStarter')}
            </IconButton>
          </div>
        </Card>
      )}
      {inUse && tile(inUse, true)}
      {brains && (
        <div
          style={{
            display: 'grid',
            gap: 16,
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
            minWidth: 0,
          }}
        >
          {brains.filter((b) => b !== inUse).map((b) => tile(b))}
        </div>
      )}
      <StepsSheet
        brain={brains?.find((b) => b.id === steps) ?? null}
        onClose={() => setSteps(null)}
        onCheck={() => checkBrain(brains?.find((b) => b.id === steps))}
      />
    </section>
  );
}
