/**
 * The guided email setup (ws/email), one flow in three places: the main helper's checklist card in its chat (posted
 * right after the team setup), the page the done screen opens (`#/inbox/connect`), and Settings > Your mailbox. The
 * steps live on the server (GET /guide), so a reload or another tab carries on where the owner was; the card's own
 * fixed text carries every step, so nothing waits on a brain.
 *
 * Connect: pick the service (brand tiles), type the address, a plain guide to the service's app password (its own
 * pages open in the owner's own browser, through safeHref), paste the code in a masked box (the server checks the
 * sign-in on the service's own servers and keeps the code in the vault; it never comes back), choose what helpers may
 * do (read and draft is the default), and a tiny test. New: address ideas (only ideas), the owner signs up at Gmail
 * in their own browser (only they do that part), then the same connect steps. "Other" is the manual form.
 */
import type { MessageBlock } from '@pasabot/protocol';
import { AgentAvatar, BrandTile, Button, Card, Field, HelperCard, safeHref } from '@pasabot/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CODE_LETTERS,
  isNamedService,
  type NamedService,
  SERVICES,
  type ServiceId,
  serviceForAddress,
} from '../src/providers.js';
import { CallError, call, type Settings, Setup, type T, useT } from './shared.js';

type Step =
  | 'service'
  | 'ideas'
  | 'signup'
  | 'address'
  | 'guide'
  | 'code'
  | 'manual'
  | 'access'
  | 'test'
  | 'done';
type Access = 'read' | 'draft' | 'send';
export interface GuideView {
  id: string;
  mode: 'new' | 'connect';
  step: Step;
  service: ServiceId | null;
  address: string | null;
  ideas: string[];
  chatId: string | null;
  agentId: string | null;
  access: Access | null;
  testWord?: string | null;
  /** W43 "Do it with me": the helper's own browser has the sign-up open (`yours`) or the owner drives it (`taken`) */
  withMe?: { profileId: string; state: 'yours' | 'taken'; idea: string } | null;
  connected: boolean;
  helper: { agentId: string; name: string } | null;
}

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SERVICE_TILES: { id: ServiceId; tile: string; name?: string }[] = [
  { id: 'gmail', tile: 'gmail', name: 'Gmail' },
  { id: 'outlook', tile: 'outlook', name: 'Outlook / Hotmail' },
  { id: 'yahoo', tile: 'yahoo', name: 'Yahoo Mail' },
  { id: 'icloud', tile: 'icloud', name: 'iCloud Mail' },
  { id: 'other', tile: 'inbox-imap' },
];
/** the company whose pages the owner opens (a name, never translated) */
const COMPANY: Record<NamedService, string> = {
  gmail: 'Google',
  outlook: 'Microsoft',
  yahoo: 'Yahoo',
  icloud: 'Apple',
};
/** the tile names, for "that looks like a Yahoo address" */
const SERVICE_NAME: Record<NamedService, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook / Hotmail',
  yahoo: 'Yahoo Mail',
  icloud: 'iCloud Mail',
};
/** a failed check whose code is useless afterwards (the box is emptied); every other reason keeps the typed code */
const CLEARS_CODE = new Set(['wrong_code', 'two_step_off', 'code_shape']);
/** a reason's text key (the server's `too_many` is `tooMany`: a key ending in `_many` would read as a plural form) */
const reasonKey = (r: string) => `guide.reason.${r === 'too_many' ? 'tooMany' : r}`;
const REASONS = [
  'wrong_code',
  'two_step_off',
  'imap_off',
  'no_internet',
  'server_trouble',
  'code_shape',
  'stopped',
  'too_many',
  'busy',
];
const PATH: Record<string, Step[]> = {
  new: ['ideas', 'signup', 'address', 'guide', 'code', 'access', 'test', 'done'],
  connect: ['service', 'address', 'guide', 'code', 'access', 'test', 'done'],
  other: ['service', 'manual', 'access', 'test', 'done'],
};

/** "Technical words" (mirrored on `<html data-advanced>`, `pasabot:advanced` on change) */
function useAdvanced(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
  );
}

const col: React.CSSProperties = { display: 'grid', gap: 12, minWidth: 0 };
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const tap: React.CSSProperties = { minHeight: 44 };
const muted: React.CSSProperties = { margin: 0, color: 'var(--bk-ink-2)', fontSize: 14 };

/** an outside page in the owner's own browser (new tab, no opener); nothing when the URL is not plain https */
function Outside({ href, children, testid }: { href: string; children: ReactNode; testid?: string }) {
  const h = safeHref(href);
  if (!h) return null;
  return (
    <a
      className="bk-btn bk-btn--secondary"
      href={h}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ...tap, display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'normal' }}
      data-testid={testid}
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/** the current guide from the server, and a way to move it on */
export function useGuide() {
  const [guide, setGuide] = useState<GuideView | null | undefined>(undefined);
  const reload = useCallback(async () => {
    try {
      setGuide((await call<{ guide: GuideView | null }>('/guide')).guide);
    } catch {
      setGuide(null);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { guide, setGuide, reload };
}

function stepOf(g: GuideView): { n: number; total: number } {
  const p = PATH[g.mode === 'new' ? 'new' : g.service === 'other' ? 'other' : 'connect']!;
  // "done" is not a step to count
  return { n: Math.max(1, p.indexOf(g.step) + 1), total: p.length - 1 };
}

/**
 * One guide's current step. `onChange` gets the guide the server answered with. `embedded`: inside the helper's
 * chat card (the helper's line is drawn by the card).
 */
export function GuideFlow({ t, guide, onChange }: { t: T; guide: GuideView; onChange(g: GuideView): void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [address, setAddress] = useState(guide.address ?? '');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [access, setAccess] = useState<Access>(guide.access ?? 'draft');
  const [arrived, setArrived] = useState<{ from: string; subject: string } | null | undefined>(undefined);
  const [checkErr, setCheckErr] = useState('');
  const [teamName, setTeamName] = useState('');
  const [copied, setCopied] = useState('');
  // W43: the owner chose "I'll do it in my own browser" (or the helper's browser could not start)
  const [mine, setMine] = useState(false);
  const [noBrowser, setNoBrowser] = useState(false);
  const advanced = useAdvanced();
  const service = isNamedService(guide.service) ? guide.service : null;
  const company = service ? COMPANY[service] : '';
  // the step's own heading (or its "Step n of total" line): focus moves there on every step change, so a keyboard or
  // screen-reader user hears where they are instead of landing at the top of the page
  const top = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const firstStep = useRef(true);
  // a new step (from this tab or another): start its fields fresh
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a step change resets the fields
  useEffect(() => {
    setErr('');
    setResult(null);
    setCode('');
    setArrived(undefined);
    setCheckErr('');
    if (firstStep.current) firstStep.current = false;
    else {
      // only when the owner was in this flow (the button they pressed is gone): another tab moving the step on never
      // pulls focus away from what they are typing elsewhere
      const a = document.activeElement;
      if (!a || a === document.body || root.current?.contains(a)) top.current?.focus();
    }
  }, [guide.step, guide.id]);

  const step = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr('');
    try {
      const r = await call<{ guide: GuideView }>('/guide/step', {
        method: 'POST',
        body: JSON.stringify({ id: guide.id, ...body }),
      });
      onChange(r.guide);
    } catch (e) {
      const c = e instanceof CallError ? e.code : 'other';
      setErr(t(c === 'bad_address' ? 'guide.badAddress' : c === 'moved' ? 'guide.moved' : 'error.other'));
    } finally {
      setBusy(false);
    }
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!service || !guide.address) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await call<{ ok: boolean; reason?: string; guide?: GuideView | null }>('/connect', {
        method: 'POST',
        body: JSON.stringify({ guideId: guide.id, service, address: guide.address, code }),
      });
      // the code stays in the box when the fix is elsewhere (mail apps blocked, no internet, a busy server): the
      // service shows an app password only once, so emptying it would send the owner off to make a new one
      if (r.ok || CLEARS_CODE.has(r.reason ?? '')) setCode('');
      setResult({ ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
      if (r.ok && r.guide) onChange(r.guide);
    } catch (err) {
      const reason = err instanceof CallError ? err.code : 'other';
      if (CLEARS_CODE.has(reason)) setCode('');
      setResult({ ok: false, reason });
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    setCheckErr('');
    try {
      const r = await call<{ arrived: { from: string; subject: string } | null; word?: string }>(
        '/guide/check',
        { method: 'POST' },
      );
      if (r.word && r.word !== guide.testWord) onChange({ ...guide, testWord: r.word });
      setArrived(r.arrived);
    } catch (e) {
      const c = e instanceof CallError ? e.code : 'other';
      setArrived(undefined);
      setCheckErr(t(c === 'too_many' || c === 'busy' ? reasonKey(c) : 'error.other', { company }));
    } finally {
      setBusy(false);
    }
  };

  const { n, total } = stepOf(guide);
  const setTop = (el: HTMLElement | null) => {
    top.current = el;
  };
  const h3 = (text: string) => <h3 style={{ margin: 0, fontSize: 17 }}>{text}</h3>;
  const copy = async (idea: string) => {
    try {
      await navigator.clipboard.writeText(idea);
      setCopied(idea);
    } catch {
      setCopied('');
    }
  };
  // the address's own service, when it is a named one other than the tile picked ("that looks like Yahoo")
  const typed = address.trim();
  const typedService = typed.includes('@') ? serviceForAddress(typed) : null;
  const mismatch =
    guide.mode === 'connect' && service && typedService && typedService !== service ? typedService : null;
  // a company's own domain (it may be Google Workspace or Microsoft 365, where an admin decides about app passwords)
  const workAddress = (a: string) => /@[^@]+\.[^@]+$/.test(a.trim()) && serviceForAddress(a) === null;
  const back =
    guide.step !== 'service' && guide.step !== 'ideas' && guide.step !== 'access' && guide.step !== 'done' ? (
      <Button onClick={() => void step({ do: 'back' })} disabled={busy} style={tap} data-testid="guide-back">
        {t('guide.back')}
      </Button>
    ) : null;
  const done = (label = t('guide.done')) => (
    <Button
      variant="primary"
      onClick={() => void step({ do: 'next' })}
      disabled={busy}
      style={tap}
      data-testid="guide-done"
    >
      {label}
    </Button>
  );

  let body: ReactNode = null;
  switch (guide.step) {
    case 'service':
      body = (
        <>
          {h3(t('guide.service.title'))}
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 8,
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            }}
          >
            {SERVICE_TILES.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="bk-btn bk-btn--secondary"
                  onClick={() => void step({ do: 'service', service: s.id })}
                  disabled={busy}
                  style={{ width: '100%', minHeight: 56, justifyContent: 'flex-start', gap: 10 }}
                  data-testid={`guide-service-${s.id}`}
                >
                  <BrandTile id={s.tile} size={32} fallback="inbox" />
                  <span>{s.name ?? t('guide.service.other')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      );
      break;
    case 'ideas':
      body = (
        <>
          {h3(t('guide.ideas.title'))}
          <form
            style={col}
            onSubmit={(e) => {
              e.preventDefault();
              if (teamName.trim()) void step({ do: 'name', name: teamName });
            }}
          >
            <Field
              label={t('guide.ideas.nameLabel')}
              hint={t('guide.ideas.nameHint')}
              value={teamName}
              onChange={(e: { target: { value: string } }) => setTeamName(e.target.value)}
              autoComplete="organization"
              maxLength={60}
              data-testid="guide-team-name"
            />
            <div style={row}>
              <Button
                type="submit"
                disabled={busy || !teamName.trim()}
                style={tap}
                data-testid="guide-ideas-show"
              >
                {t('guide.ideas.show')}
              </Button>
            </div>
          </form>
          {guide.ideas.length > 0 && (
            <ul
              style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}
              data-testid="guide-ideas"
            >
              {guide.ideas.map((i) => (
                <li key={i} style={{ ...row, flexWrap: 'nowrap', justifyContent: 'space-between' }}>
                  <span
                    dir="ltr"
                    style={{ overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}
                    data-testid="guide-idea"
                  >
                    {/* a narrow screen breaks the line before "@gmail.com", not inside it */}
                    {i.split('@')[0]}
                    <wbr />@{i.split('@')[1]}
                  </span>
                  <Button
                    onClick={() => void copy(i)}
                    aria-label={t('guide.ideas.copyOne', { address: i })}
                    style={{ ...tap, flexShrink: 0 }}
                    data-testid="guide-idea-copy"
                  >
                    {copied === i ? t('guide.ideas.copied') : t('guide.ideas.copy')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p style={muted}>{t('guide.ideas.note')}</p>
          <div style={row}>{done(t('guide.next'))}</div>
        </>
      );
      break;
    case 'signup':
      body = guide.withMe ? (
        <WithMeLive t={t} guide={guide} onChange={onChange} />
      ) : !mine ? (
        <>
          {h3(t('guide.signup.title'))}
          <WithMeStart
            t={t}
            guide={guide}
            onChange={onChange}
            onMine={(why) => {
              setMine(true);
              setNoBrowser(why === 'no_browser');
            }}
          />
          <div style={row}>{back}</div>
        </>
      ) : (
        <>
          {h3(t('guide.signup.title'))}
          {noBrowser && (
            <p role="status" style={{ margin: 0 }} data-testid="guide-withme-nobrowser">
              {t('guide.withMe.noBrowser', { name: guide.helper?.name ?? '' })}
            </p>
          )}
          <div style={row}>
            <Outside href={SERVICES.gmail.signupUrl!} testid="guide-signup-open">
              {t('guide.signup.open')}
            </Outside>
          </div>
          <p style={{ margin: 0 }}>{t('guide.signup.asks')}</p>
          <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 4 }}>
            <li>{t('guide.signup.ask1')}</li>
            <li>{t('guide.signup.ask2')}</li>
            <li>{t('guide.signup.ask3')}</li>
            <li>{t('guide.signup.ask4')}</li>
          </ul>
          <p style={{ margin: 0, fontWeight: 600 }} data-testid="guide-only-you">
            {t('guide.signup.onlyYou')}
          </p>
          <div style={row}>
            {back}
            {done(t('guide.signup.done'))}
          </div>
        </>
      );
      break;
    case 'address':
      body = (
        <form
          style={col}
          onSubmit={(e) => {
            e.preventDefault();
            void step({ do: 'address', address });
          }}
        >
          <Field
            label={t(guide.mode === 'new' ? 'guide.address.newLabel' : 'guide.address.label')}
            hint={t('guide.address.hint', {
              example: service === 'gmail' ? 'name@gmail.com' : 'name@example.com',
            })}
            value={address}
            onChange={(e: { target: { value: string } }) => setAddress(e.target.value)}
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            data-testid="guide-address"
          />
          {mismatch ? (
            <div role="status" style={col} data-testid="guide-address-mismatch">
              <p style={{ margin: 0 }}>{t('guide.address.looksLike', { name: SERVICE_NAME[mismatch] })}</p>
              <div style={row}>
                <Button
                  onClick={() => void step({ do: 'service', service: mismatch })}
                  disabled={busy}
                  style={tap}
                  data-testid="guide-address-switch"
                >
                  {t('guide.address.switch', { name: SERVICE_NAME[mismatch] })}
                </Button>
              </div>
            </div>
          ) : guide.mode === 'connect' && workAddress(typed) ? (
            <p style={muted} role="status" data-testid="guide-address-work">
              {t('guide.address.work')}
            </p>
          ) : null}
          <div style={row}>
            {back}
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              style={tap}
              data-testid="guide-address-next"
            >
              {t('guide.next')}
            </Button>
          </div>
        </form>
      );
      break;
    case 'guide':
      if (!service) break;
      body = (
        <>
          {h3(t('guide.apppw.title'))}
          <p style={{ margin: 0 }}>{t('guide.apppw.why', { company })}</p>
          {/* each item stays a list item (its own number); the layout lives in an inner block */}
          <ol style={{ margin: 0, paddingInlineStart: 24 }} data-testid="guide-apppw">
            <li style={{ marginBottom: 12 }}>
              <div style={col}>
                <span>{t('guide.apppw.s1', { company })}</span>
                <div style={row}>
                  <Outside href={SERVICES[service].twoStepUrl} testid="guide-open-2sv">
                    {t('guide.apppw.s1Open', { company })}
                  </Outside>
                </div>
              </div>
            </li>
            <li style={{ marginBottom: 12 }}>
              <div style={col}>
                <span>{t(`guide.apppw.s2.${service}`)}</span>
                <div style={row}>
                  <Outside href={SERVICES[service].appPasswordUrl} testid="guide-open-apppw">
                    {t('guide.apppw.s2Open', { company })}
                  </Outside>
                </div>
              </div>
            </li>
            <li>{t('guide.apppw.s3', { letters: CODE_LETTERS })}</li>
          </ol>
          <div style={row}>
            {back}
            {done(t('guide.apppw.haveCode'))}
          </div>
        </>
      );
      break;
    case 'code':
      if (!service) break;
      body = (
        <form style={col} onSubmit={connect} data-testid="guide-code-form">
          {h3(t('guide.code.title'))}
          <p style={{ ...muted, overflowWrap: 'anywhere' }} dir="auto">
            {guide.address}
          </p>
          <Field
            label={t('guide.code.label', { letters: CODE_LETTERS })}
            hint={t('guide.code.hint')}
            value={code}
            onChange={(e: { target: { value: string } }) => setCode(e.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            data-testid="guide-code"
          />
          {advanced && (
            <p style={muted} dir="ltr" data-testid="guide-tech">
              {t('guide.code.tech', {
                imap: `${SERVICES[service].hosts.imapHost}:${SERVICES[service].hosts.imapPort}`,
                smtp: `${SERVICES[service].hosts.smtpHost}:${SERVICES[service].hosts.smtpPort}`,
              })}
            </p>
          )}
          <div style={row}>
            {back}
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !code.trim()}
              style={tap}
              data-testid="guide-connect"
            >
              {busy ? t('guide.code.checking', { company }) : t('guide.code.connect')}
            </Button>
          </div>
          {result && !result.ok && (
            <div role="alert" style={col} data-testid="guide-reason" data-reason={result.reason}>
              <p className="bk-field__error" style={{ margin: 0 }}>
                {t(reasonKey(REASONS.includes(result.reason ?? '') ? result.reason! : 'server_trouble'), {
                  company,
                  letters: CODE_LETTERS,
                })}
              </p>
              {(result.reason === 'wrong_code' || result.reason === 'imap_off') &&
                workAddress(guide.address ?? '') && (
                  <p style={muted} data-testid="guide-reason-work">
                    {t('guide.address.work')}
                  </p>
                )}
              {result.reason === 'two_step_off' && (
                <div style={row}>
                  <Outside href={SERVICES[service].twoStepUrl}>
                    {t('guide.apppw.s1Open', { company })}
                  </Outside>
                </div>
              )}
              {result.reason === 'wrong_code' && (
                <div style={row}>
                  <Outside href={SERVICES[service].appPasswordUrl}>
                    {t('guide.apppw.s2Open', { company })}
                  </Outside>
                </div>
              )}
            </div>
          )}
        </form>
      );
      break;
    case 'manual':
      body = (
        <>
          {h3(t('guide.service.other'))}
          {advanced ? (
            <>
              <p style={{ margin: 0 }}>{t('guide.manual.intro')}</p>
              <Setup
                t={t}
                settings={null}
                onSaved={() => void call<{ guide: GuideView }>('/guide').then((r) => onChange(r.guide))}
              />
            </>
          ) : (
            // plain words: no server names or ports; the helper finds the settings with the owner in the chat
            <p style={{ margin: 0 }} data-testid="guide-manual-plain">
              {guide.helper?.name
                ? t('guide.manual.plain', { name: guide.helper.name })
                : t('guide.manual.plainNoName')}
            </p>
          )}
          <div style={row}>{back}</div>
        </>
      );
      break;
    case 'access':
      body = (
        <form
          style={col}
          onSubmit={(e) => {
            e.preventDefault();
            void step({ do: 'access', access });
          }}
        >
          <p style={{ margin: 0, fontWeight: 700 }} role="status" data-testid="guide-connected">
            {t('guide.code.ok')}
          </p>
          <AccessPicker t={t} value={access} onChange={setAccess} />
          <div style={row}>
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              style={tap}
              data-testid="guide-access-save"
            >
              {t('guide.next')}
            </Button>
          </div>
        </form>
      );
      break;
    case 'test':
      body = (
        <>
          {h3(t('guide.test.title'))}
          <p style={{ margin: 0, overflowWrap: 'anywhere' }} data-testid="guide-test-body">
            {t('guide.test.body', { address: guide.address ?? '', word: guide.testWord ?? '' })}
          </p>
          {guide.testWord && (
            <p style={{ margin: 0, fontSize: 20, fontWeight: 700 }} dir="ltr" data-testid="guide-test-word">
              {guide.testWord}
            </p>
          )}
          <div style={row}>
            <Button onClick={() => void check()} disabled={busy} style={tap} data-testid="guide-check">
              {t('guide.test.check')}
            </Button>
            {done(t('guide.test.finish'))}
          </div>
          {arrived !== undefined && (
            <p
              role="status"
              style={{ margin: 0, overflowWrap: 'anywhere' }}
              data-testid="guide-arrived"
              dir="auto"
            >
              {arrived
                ? `${t('guide.test.arrived', { subject: arrived.subject || '-', from: arrived.from })} ${t('guide.test.proves')}`
                : t('guide.test.none', { word: guide.testWord ?? '' })}
            </p>
          )}
          {checkErr && (
            <p className="bk-field__error" role="alert" style={{ margin: 0 }}>
              {checkErr}
            </p>
          )}
        </>
      );
      break;
    case 'done':
      body = (
        <>
          <h3
            ref={setTop}
            tabIndex={-1}
            style={{ margin: 0, fontSize: 17, outline: 'none' }}
            data-testid="guide-finished"
          >
            {t('guide.finished.title')}
          </h3>
          <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {t('guide.finished.body', { address: guide.address ?? '' })}{' '}
            {t(`guide.finished.${guide.access ?? 'draft'}`)}
          </p>
          <p style={muted}>{t('guide.finished.change')}</p>
        </>
      );
      break;
  }
  return (
    <div ref={root} style={col} data-testid="guide" data-step={guide.step} data-mode={guide.mode}>
      {guide.step !== 'done' && (
        <p
          ref={setTop}
          tabIndex={-1}
          style={{ ...muted, fontSize: 13, outline: 'none' }}
          data-testid="guide-count"
        >
          {t('guide.count', { n, total })}
        </p>
      )}
      {body}
      {err && (
        <p className="bk-field__error" role="alert" style={{ margin: 0 }}>
          {err}
        </p>
      )}
    </div>
  );
}

/** read only / read and draft (the default) / send after I approve (every send still asks, every time) */
export function AccessPicker({ t, value, onChange }: { t: T; value: Access; onChange(a: Access): void }) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 8, minWidth: 0 }}>
      <legend style={{ fontWeight: 700, marginBottom: 6 }}>{t('guide.access.title')}</legend>
      {(['read', 'draft', 'send'] as const).map((a) => (
        <label
          key={a}
          className="bk-btn bk-btn--secondary"
          style={{
            minHeight: 56,
            justifyContent: 'flex-start',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            whiteSpace: 'normal',
            textAlign: 'start',
            cursor: 'pointer',
          }}
          data-testid={`guide-access-${a}`}
        >
          <input
            type="radio"
            name="mail-access"
            value={a}
            checked={value === a}
            onChange={() => onChange(a)}
            style={{ marginTop: 4, inlineSize: 18, blockSize: 18 }}
          />
          <span style={{ display: 'grid', gap: 2 }}>
            <b>{t(`guide.access.${a}`)}</b>
            <span style={{ fontWeight: 400, fontSize: 14 }}>{t(`guide.access.${a}Hint`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** the helper's line for the step it is on (fixed text: the card never waits on a brain) */
const LIVE_EVENT = 'pasabot:event';
const PROFILE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * W43 "Do it with me", the sign-up step's first choice: the owner confirms their first and last name and picks one
 * of the address ideas; the main helper then opens the service's sign-up page in its own browser and fills just
 * those (a server flow, never the brain). "I'll do it in my own browser" keeps the old way.
 */
function WithMeStart({
  t,
  guide,
  onChange,
  onMine,
}: {
  t: T;
  guide: GuideView;
  onChange(g: GuideView): void;
  onMine(why?: string): void;
}) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [idea, setIdea] = useState(guide.ideas[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = guide.helper?.name ?? '';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!first.trim() || !last.trim() || !idea) return setErr(t('guide.withMe.badName'));
    setBusy(true);
    setErr('');
    try {
      const r = await call<{ guide: GuideView }>('/guide/withme', {
        method: 'POST',
        body: JSON.stringify({ id: guide.id, first, last, idea }),
      });
      onChange(r.guide);
    } catch (x) {
      const c = x instanceof CallError ? x.code : 'other';
      if (c === 'no_browser') onMine('no_browser');
      else
        setErr(t(c === 'bad_name' ? 'guide.withMe.badName' : c === 'moved' ? 'guide.moved' : 'error.other'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{ display: 'grid', gap: 12 }}
      data-testid="guide-withme-form"
    >
      <p style={{ margin: 0 }}>{t('guide.withMe.intro', { name })}</p>
      <Field
        label={t('guide.withMe.first')}
        value={first}
        onChange={(e: { target: { value: string } }) => setFirst(e.target.value)}
        autoComplete="given-name"
        maxLength={40}
        data-testid="guide-withme-first"
      />
      <Field
        label={t('guide.withMe.last')}
        value={last}
        onChange={(e: { target: { value: string } }) => setLast(e.target.value)}
        autoComplete="family-name"
        maxLength={40}
        data-testid="guide-withme-last"
      />
      {guide.ideas.length > 0 && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 6, minWidth: 0 }}>
          <legend style={{ padding: 0, marginBottom: 4, fontWeight: 600 }}>{t('guide.withMe.pick')}</legend>
          {guide.ideas.map((i) => (
            <label key={i} style={{ ...row, flexWrap: 'nowrap', minHeight: 44, minWidth: 0 }}>
              <input
                type="radio"
                name={`withme-idea-${guide.id}`}
                value={i}
                checked={idea === i}
                onChange={() => setIdea(i)}
                data-testid="guide-withme-idea"
              />
              <span dir="ltr" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                {i}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {err && (
        <p role="alert" className="bk-field__error" style={{ margin: 0 }}>
          {err}
        </p>
      )}
      {busy && (
        <p role="status" style={muted}>
          {t('guide.withMe.working')}
        </p>
      )}
      <div style={row}>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !guide.ideas.length}
          style={tap}
          data-testid="guide-withme-go"
        >
          {t('guide.withMe.do')}
        </Button>
        <Button
          type="button"
          onClick={() => onMine()}
          disabled={busy}
          style={tap}
          data-testid="guide-withme-mine"
        >
          {t('guide.withMe.mine')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The helper's browser, live inside the checklist, with the owner's turn: the password and the phone check are the
 * owner's (the browser refuses them to anyone else). Take over opens the browser to drive; Done moves on.
 */
function WithMeLive({ t, guide, onChange }: { t: T; guide: GuideView; onChange(g: GuideView): void }) {
  const w = guide.withMe!;
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = guide.helper?.name ?? '';
  useEffect(() => {
    if (!PROFILE_ID.test(w.profileId)) return;
    let gone = false;
    fetch(`/api/m/browser/profiles/${w.profileId}/frame`, { credentials: 'same-origin' })
      .then((r) => (r.status === 200 ? r.json() : null))
      .then((j: { frame?: { data?: string } } | null) => {
        if (!gone && j?.frame?.data) setSrc(`data:image/jpeg;base64,${j.frame.data}`);
      })
      .catch(() => {});
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: { profileId?: string; data?: string } }>).detail;
      if (d?.type === 'browser.frame' && d.data?.profileId === w.profileId && d.data.data)
        setSrc(`data:image/jpeg;base64,${d.data.data}`);
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => {
      gone = true;
      window.removeEventListener(LIVE_EVENT, on);
    };
  }, [w.profileId]);
  const act = async (what: 'take' | 'done') => {
    setBusy(true);
    setErr('');
    try {
      const r = await call<{ guide: GuideView }>(`/guide/withme/${what}`, {
        method: 'POST',
        body: JSON.stringify({ id: guide.id }),
      });
      onChange(r.guide);
      if (what === 'take' && PROFILE_ID.test(w.profileId))
        window.location.hash = `#/browser?profile=${w.profileId}`;
    } catch (x) {
      setErr(t(x instanceof CallError && x.code === 'moved' ? 'guide.moved' : 'error.other'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
      data-testid="guide-withme-live"
      data-state={w.state}
    >
      <h3 style={{ margin: 0, fontSize: 17 }}>{t('guide.withMe.yourTurn')}</h3>
      {src ? (
        <img
          src={src}
          alt={t('guide.withMe.liveAlt', { name })}
          style={{
            width: '100%',
            height: 'auto',
            borderRadius: 8,
            border: '1px solid var(--bk-border, #8884)',
          }}
          data-testid="guide-withme-frame"
        />
      ) : (
        <p style={muted} data-testid="guide-withme-wait">
          {t('guide.withMe.wait')}
        </p>
      )}
      <p style={{ margin: 0 }}>
        {w.state === 'taken' ? t('guide.withMe.taken', { name }) : t('guide.withMe.yourTurnText')}
      </p>
      <p style={{ ...muted, overflowWrap: 'anywhere' }} dir="auto">
        {t('guide.withMe.address', { address: w.idea })}
      </p>
      {err && (
        <p role="alert" className="bk-field__error" style={{ margin: 0 }}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button
          variant="primary"
          onClick={() => void act('take')}
          disabled={busy}
          style={tap}
          data-testid="guide-withme-take"
        >
          {t('guide.withMe.take')}
        </Button>
        <Button onClick={() => void act('done')} disabled={busy} style={tap} data-testid="guide-withme-done">
          {t('guide.withMe.done')}
        </Button>
      </div>
    </div>
  );
}

function Say({ t, guide }: { t: T; guide: GuideView }) {
  const advanced = useAdvanced();
  const key =
    guide.step === 'address'
      ? `address_${guide.mode}`
      : guide.step === 'manual' && !advanced
        ? 'manualPlain'
        : guide.step;
  const company = isNamedService(guide.service) ? COMPANY[guide.service] : '';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }} data-testid="guide-say">
      {guide.helper && ID.test(guide.helper.agentId) && (
        <AgentAvatar agentId={guide.helper.agentId} size={32} shape="circle" />
      )}
      <p style={{ margin: 0, fontWeight: 600 }} dir="auto" aria-live="polite">
        {t(`guide.say.${key}`, { company, name: guide.helper?.name ?? '' })}
      </p>
    </div>
  );
}

/** The main helper's checklist card in its chat. */
export function GuideCard({ block }: { block: MessageBlock }) {
  const t = useT();
  const d = block.data as { guideId: string; mode: string; step: string };
  const { guide, setGuide, reload } = useGuide();
  // the block follows the server's step (another tab, a restart): fetch the state again when it moves
  // biome-ignore lint/correctness/useExhaustiveDependencies: the block's step is the signal
  useEffect(() => {
    void reload();
  }, [d.step, reload]);
  const mine = guide && guide.id === d.guideId;
  // a new mailbox is a Gmail one; connecting starts from any service
  const tile = d.mode === 'new' ? 'gmail' : 'inbox-imap';
  const title = t(d.mode === 'new' ? 'guide.cardNew' : 'guide.cardConnect');
  // W40: the shared helper card (connect); the checklist itself is the card's content, its steps carry the buttons
  return (
    <div style={{ minWidth: 0, maxWidth: 560 }}>
      <HelperCard
        id={`guide-${d.guideId}`}
        testId="guide-card"
        variant="connect"
        badge={<BrandTile id={tile} size={28} fallback="inbox" />}
        title={title}
        visual={
          // a little room inside, so focus rings on the checklist's fields and buttons are never cut off
          <div style={{ display: 'grid', gap: 12, minWidth: 0, padding: 4 }}>
            {guide === undefined ? null : !mine || d.step === 'moved' ? (
              <p style={muted} data-testid="guide-moved">
                {t('guide.moved')}
              </p>
            ) : (
              <>
                <Say t={t} guide={guide} />
                <GuideFlow t={t} guide={guide} onChange={setGuide} />
              </>
            )}
          </div>
        }
        actions={[]}
        state="open"
        settledLabel=""
      />
    </div>
  );
}

/** `#/inbox/connect`: the done screen's next step (and the team card's step link) opens the guide here. */
export function ConnectPage() {
  const t = useT();
  const { guide, setGuide } = useGuide();
  const [err, setErr] = useState('');
  const first = useRef(true);
  useEffect(() => {
    if (guide === undefined || !first.current) return;
    first.current = false;
    // on arrival: no guide yet, or the last one finished -> start connecting (an open one carries on, any mode)
    if (guide === null || guide.step === 'done')
      call<{ guide: GuideView }>('/guide/start', {
        method: 'POST',
        body: JSON.stringify({ mode: 'connect' }),
      })
        .then((r) => setGuide(r.guide))
        .catch(() => setErr(t('error.other')));
  }, [guide, setGuide, t]);
  return (
    <section
      data-slot="route"
      data-testid="connect-page"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 720,
        paddingInline: 16,
        marginInline: 'auto',
        paddingBottom: 32,
        minWidth: 0,
      }}
    >
      <h1>{t('guide.pageTitle')}</h1>
      <Card style={{ display: 'grid', gap: 12, minWidth: 0, padding: 16 }}>
        {guide && guide.step !== 'done' ? <Say t={t} guide={guide} /> : null}
        {guide && <GuideFlow t={t} guide={guide} onChange={setGuide} />}
        {err && (
          <p className="bk-field__error" role="alert" style={{ margin: 0 }}>
            {err}
          </p>
        )}
      </Card>
      {guide?.chatId && ID.test(guide.chatId) && guide.step !== 'done' && (
        <a
          className="bk-btn bk-btn--secondary"
          style={{ ...tap, justifySelf: 'start' }}
          href={`#/chats/${guide.chatId}`}
        >
          {t('guide.openChat', { name: guide.helper?.name ?? '' })}
        </a>
      )}
    </section>
  );
}

/** Settings > Your mailbox: what is connected, what helpers may do, and the guided flow to connect or make one. */
export function MailboxSection() {
  const t = useT();
  const [settings, setSettings] = useState<
    (Settings & { access?: Access | null; helper?: { name: string } | null }) | null
  >(null);
  const { guide, setGuide, reload } = useGuide();
  const [access, setAccess] = useState<Access>('draft');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const s = await call<Settings & { access?: Access | null; helper?: { name: string } | null }>(
        '/settings',
      );
      setSettings(s);
      setAccess(s.access ?? 'draft');
    } catch {
      setSettings({ configured: false, hasPassword: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const start = async (mode: 'new' | 'connect') => {
    try {
      setGuide(
        (await call<{ guide: GuideView }>('/guide/start', { method: 'POST', body: JSON.stringify({ mode }) }))
          .guide,
      );
    } catch {
      setMsg(t('error.other'));
    }
  };
  const saveAccess = async (a: Access) => {
    setAccess(a);
    try {
      await call('/access', { method: 'PUT', body: JSON.stringify({ access: a }) });
      setMsg(t('guide.settings.saved'));
    } catch {
      setMsg(t('error.other'));
    }
  };
  const open = guide && guide.step !== 'done';
  return (
    <section style={{ display: 'grid', gap: 12, minWidth: 0 }} data-testid="mailbox-settings">
      {settings?.configured ? (
        <p style={{ margin: 0, overflowWrap: 'anywhere' }} data-testid="mailbox-connected">
          {t('guide.settings.connected', { address: settings.address ?? '' })}
          {settings.helper?.name ? ` ${t('guide.settings.helper', { name: settings.helper.name })}` : ''}
        </p>
      ) : (
        <p style={{ margin: 0 }}>{t('guide.settings.none')}</p>
      )}
      {settings?.configured && !open && (
        <AccessPicker t={t} value={access} onChange={(a) => void saveAccess(a)} />
      )}
      {open && guide ? (
        <Card style={{ display: 'grid', gap: 12, minWidth: 0, padding: 16 }}>
          <Say t={t} guide={guide} />
          <GuideFlow
            t={t}
            guide={guide}
            onChange={(g) => {
              setGuide(g);
              if (g.step === 'done') {
                void load();
                void reload();
              }
            }}
          />
        </Card>
      ) : (
        <div style={row}>
          <Button
            variant="primary"
            style={tap}
            onClick={() => void start('connect')}
            data-testid="mailbox-connect"
          >
            {settings?.configured ? t('guide.settings.change') : t('guide.settings.connect')}
          </Button>
          {!settings?.configured && (
            <Button style={tap} onClick={() => void start('new')} data-testid="mailbox-new">
              {t('guide.settings.makeNew')}
            </Button>
          )}
        </div>
      )}
      {msg && (
        <p role="status" style={{ margin: 0 }}>
          {msg}
        </p>
      )}
    </section>
  );
}
