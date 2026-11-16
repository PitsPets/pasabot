/**
 * What the owner should know about the computer PasaBot runs on (server `GET /api/v1/system/notices`): no helper
 * sandbox on Windows, a Linux sandbox that cannot start, a locked vault, a data folder Windows could not lock, a
 * sign-in setting for Codex and OpenCode. Each one is a HelperCard in plain words, never only a log line. Shown on
 * the first-run screen (`SystemNotices`, "Got it" hides one in this browser) and in Settings > Advanced > This
 * computer (`ThisComputer`, every notice, plus "Check this computer" on Windows: it opens the package's self-check
 * in its own window). Owner only: anyone else gets nothing from the server, so nothing is drawn.
 */
import { HelperCard, type HelperCardAction } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { navigate } from '../app/router.js';

export type NoticeId =
  | 'windows-no-sandbox'
  | 'linux-sandbox-missing'
  | 'linux-sandbox-userns'
  | 'linux-sandbox-other'
  | 'vault-unavailable'
  | 'vault-key-file'
  | 'data-folder-open'
  | 'signin-links';

export interface NoticesView {
  notices: { id: NoticeId }[];
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  canCheck: boolean;
}

/** the technical one-liners behind "Details" (Technical words): commands a helper of the owner can type */
const DETAILS: Partial<Record<NoticeId, string>> = {
  'linux-sandbox-missing': 'sudo apt install bubblewrap',
  'linux-sandbox-userns':
    'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0  (or an AppArmor profile for /usr/bin/bwrap with "userns,")',
  'linux-sandbox-other': 'pasabot doctor',
  'signin-links': 'Settings > System > For developers > Developer Mode',
};
const URGENT: ReadonlySet<NoticeId> = new Set([
  'linux-sandbox-missing',
  'linux-sandbox-userns',
  'linux-sandbox-other',
  'vault-unavailable',
]);
const SEEN_KEY = 'pasabot.notices.seen';
const seen = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const markSeen = (id: string) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...seen(), id])]));
  } catch {
    /* private window: it shows again next time, nothing else */
  }
};

export function useNotices(): NoticesView | null {
  const [v, setV] = useState<NoticesView | null>(null);
  useEffect(() => {
    let live = true;
    api<NoticesView>('/api/v1/system/notices')
      .then((r) => live && setV(r))
      .catch(() => live && setV(null));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

function NoticeCard({ id, onDone }: { id: NoticeId; onDone?: () => void }) {
  const t = useT();
  const technical = usePrefs((s) => s.advanced);
  const [state, setState] = useState<'open' | 'dismissed'>('open');
  const actions: HelperCardAction[] = [];
  if (id === 'windows-no-sandbox')
    actions.push({
      id: 'trust',
      label: t('system.changeTrust'),
      style: 'secondary',
      onAction: () => navigate('/settings/safety/trust'),
    });
  if (onDone)
    actions.unshift({
      id: 'ok',
      label: t('system.gotIt'),
      style: 'primary',
      onAction: () => {
        markSeen(id);
        setState('dismissed');
        onDone();
      },
    });
  const detail = technical ? DETAILS[id] : undefined;
  return (
    <HelperCard
      id={`system-${id}`}
      testId={`notice-${id}`}
      variant={URGENT.has(id) ? 'error' : 'info'}
      kicker={t('system.kicker')}
      title={t(`system.${id}.title`)}
      text={t(`system.${id}.text`)}
      actions={actions}
      state={state}
      settledLabel={t('system.seen')}
      urgent={URGENT.has(id)}
      {...(detail ? { details: { label: t('system.details'), text: detail } } : {})}
    />
  );
}

/** the first-run screen's cards: only the ones this browser has not said "Got it" to */
export function SystemNotices() {
  const v = useNotices();
  const [hidden, setHidden] = useState<string[]>(seen);
  if (!v) return null;
  const list = v.notices.filter((n) => !hidden.includes(n.id));
  if (!list.length) return null;
  return (
    <div className="stack" data-testid="system-notices">
      {list.map((n) => (
        <NoticeCard key={n.id} id={n.id} onDone={() => setHidden(seen())} />
      ))}
    </div>
  );
}

/** Settings > Advanced > This computer: every notice, and the Windows self-check */
export function ThisComputer() {
  const t = useT();
  const v = useNotices();
  const [state, setState] = useState<'open' | 'done' | 'failed'>('open');
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    setBusy(true);
    try {
      await post('/api/v1/system/check');
      setState('done');
    } catch {
      setState('failed');
    } finally {
      setBusy(false);
    }
  }, []);
  if (!v) return null;
  return (
    <div className="stack" data-testid="this-computer">
      {v.notices.length === 0 && (
        <section className="bk-card panel">
          <p className="muted set-empty">{t('system.allGood')}</p>
        </section>
      )}
      {v.notices.map((n) => (
        <NoticeCard key={n.id} id={n.id} />
      ))}
      {v.platform === 'win32' && (
        <HelperCard
          id="system-check"
          testId="system-check"
          variant="suggestion"
          title={t('system.check.title')}
          text={v.canCheck ? t('system.check.text') : t('system.check.notInstalled')}
          actions={
            v.canCheck
              ? [{ id: 'run', label: t('system.check.run'), style: 'primary', onAction: () => void check() }]
              : []
          }
          state={state === 'failed' ? 'open' : state}
          settledLabel={t('system.check.started')}
          busy={busy}
          {...(state === 'failed' ? { error: t('system.check.failed') } : {})}
        />
      )}
    </div>
  );
}
