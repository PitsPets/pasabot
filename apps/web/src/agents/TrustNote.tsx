/**
 * The note under an "asks only before dangerous things" (Trusted) choice: one short line, and the full explanation
 * one tap away ("How it asks you"), so the form never carries a five-line paragraph.
 */
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';

export function TrustNote({ testId = 'trust-warning' }: { testId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const fullId = useId();
  return (
    <div className="setup-trust" role="note" data-testid={testId}>
      <p className="muted">{t('agents.trustShort')}</p>
      <button
        type="button"
        className="setup-trust-how"
        aria-expanded={open}
        aria-controls={fullId}
        onClick={() => setOpen((v) => !v)}
        data-testid="trust-how"
      >
        {t('setup.trustHow')}
      </button>
      {open && (
        <p className="muted" id={fullId}>
          {t('agents.trustWarning')}
        </p>
      )}
    </div>
  );
}
