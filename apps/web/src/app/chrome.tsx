/** Shared chrome: brand mark, language toggle, connection pill, and the frame of the sign-in screens. */
import { TRANSLATION_HELP_URL } from '@pasabot/i18n';
import { ConnectionPill, LogoMark } from '@pasabot/ui';
import type { ReactNode } from 'react';
import { type Lang, useI18n } from './i18n.js';
import { useStore } from './store.js';

/** Brand mark: the "Silip" bot (packages/ui logo). The header lockup animates it; other places keep it still. */
export function Mark({ size = 32, animated = false }: { size?: number; animated?: boolean }) {
  return <LogoMark size={size} animated={animated} />;
}

/**
 * The language picker: each language by its own name; a machine-written one is marked "unreviewed".
 * With `detail` (Settings, onboarding) an unreviewed choice also says so and links to how to help improve it.
 */
export function LangToggle({ detail }: { detail?: boolean }) {
  const { lang, setLang, t, languages, meta } = useI18n();
  return (
    <span className={detail ? 'lang-pick lang-pick--detail' : 'lang-pick'}>
      <select
        className="bk-input lang-select"
        aria-label={t('lang.label')}
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        data-testid="lang-select"
      >
        {languages.map((l) => (
          <option key={l.code} value={l.code} lang={l.code} dir={l.dir}>
            {l.reviewed ? l.name : `${l.name} · ${t('lang.unreviewed')}`}
          </option>
        ))}
      </select>
      {detail && !meta.reviewed && (
        <span className="lang-note muted" data-testid="lang-unreviewed">
          {t('lang.unreviewedNote', { language: meta.name })}{' '}
          <a href={TRANSLATION_HELP_URL} target="_blank" rel="noopener noreferrer">
            {t('lang.helpImprove')}
          </a>
        </span>
      )}
    </span>
  );
}

export function Conn({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const conn = useStore((s) => s.conn);
  return (
    // the phone header shows "Online" as its dot only (named for screen readers and in a tooltip); any other state
    // keeps its words, since it is the one the owner must notice
    <ConnectionPill state={conn} label={t(`conn.${conn}`)} dotOnly={compact && conn === 'live'} />
  );
}

/**
 * The tagline. The original Filipino line stays in every language; a language other than Filipino adds its own
 * translation under it (a locale whose translation is the original line shows it once).
 */
export function Tagline() {
  const { t } = useI18n();
  const line = t('app.tagline');
  const translation = t('app.taglineTranslation');
  return (
    <p className="auth-tagline" data-testid="tagline">
      <span lang="fil">{line}</span>
      {translation && translation !== line && <span className="auth-tagline-tr">{translation}</span>}
    </p>
  );
}

/** Shared frame for setup / sign-in / pairing. */
export function AuthFrame({
  title,
  intro,
  tagline,
  children,
}: {
  title: string;
  intro?: string;
  /** show the tagline above the card (first-run setup and sign-in) */
  tagline?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-top">
        <span className="brand">
          <Mark size={28} />
          <b>PasaBot</b>
        </span>
        <LangToggle />
      </div>
      {tagline && <Tagline />}
      <section className="auth-card bk-card" aria-labelledby="auth-title">
        <h1 id="auth-title">{title}</h1>
        {intro && <p className="auth-intro">{intro}</p>}
        {children}
      </section>
    </main>
  );
}
