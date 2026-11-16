import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Button ----------
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  block?: boolean;
}
export function Button({ variant = 'secondary', size = 'md', block, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'bk-btn',
        `bk-btn--${variant}`,
        size === 'sm' && 'bk-btn--sm',
        block && 'bk-btn--block',
        className,
      )}
      {...rest}
    />
  );
}

// ---------- Card ----------
export function Card({
  as: Tag = 'div',
  className,
  children,
  ...rest
}: { as?: 'div' | 'section' | 'aside' | 'article'; className?: string; children?: ReactNode } & Record<
  string,
  unknown
>) {
  return (
    <Tag className={cx('bk-card', className)} {...rest}>
      {children}
    </Tag>
  );
}

// ---------- Avatar ----------
export type AgentStatus = 'working' | 'waiting' | 'idle';
/** Agent colour from its hue: fixed lightness so dark initials always pass AA on it. */
export const blobColor = (hue: number) => `oklch(0.8 0.13 ${Math.round(hue) % 360})`;
export function Avatar({
  name,
  glyph,
  hue,
  status,
  statusLabel,
  size = 40,
}: {
  name: string;
  glyph?: string;
  hue: number;
  status?: AgentStatus;
  statusLabel?: string;
  size?: number;
}) {
  return (
    <span
      className="bk-blob"
      style={{ background: blobColor(hue), ['--size' as string]: `${size}px` }}
      aria-hidden={statusLabel ? undefined : true}
    >
      <span aria-hidden="true">{(glyph || name.slice(0, 1) || '?').toUpperCase()}</span>
      {status && (
        <span className={`bk-blob__status bk-status--${status}`} data-status={status}>
          {statusLabel && <span className="bk-visually-hidden">{statusLabel}</span>}
        </span>
      )}
    </span>
  );
}

// ---------- Badge ----------
export function Badge({
  tone = 'neutral',
  children,
  className,
  ...rest
}: { tone?: 'neutral' | 'signal' | 'primary' | 'outline'; children: ReactNode; className?: string } & Record<
  string,
  unknown
>) {
  return (
    <span className={cx('bk-badge', tone !== 'neutral' && `bk-badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

// ---------- Connection pill ----------
export function ConnectionPill({
  state,
  label,
  dotOnly,
}: {
  state: 'connecting' | 'live' | 'reconnecting' | 'offline';
  label: string;
  /** just the coloured dot (the phone header): the label stays its accessible name and its tooltip */
  dotOnly?: boolean;
}) {
  if (dotOnly)
    return (
      <output
        className="bk-conn bk-conn--dot"
        data-state={state}
        aria-live="polite"
        aria-label={label}
        title={label}
        data-testid="conn"
      >
        <i aria-hidden="true" />
        <span className="bk-visually-hidden">{label}</span>
      </output>
    );
  return (
    <output className="bk-conn" data-state={state} aria-live="polite" data-testid="conn">
      <i aria-hidden="true" />
      {label}
    </output>
  );
}

// ---------- Segmented control ----------
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string; lang?: string }[];
  onChange(v: V): void;
}) {
  return (
    <fieldset className="bk-seg" aria-label={label} style={{ border: 0, margin: 0 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.lang}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

// ---------- Field ----------
type FieldProps = {
  label: string;
  hint?: string;
  error?: string | null;
} & (
  | ({ multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  | ({ multiline?: false } & InputHTMLAttributes<HTMLInputElement>)
);
export function Field(props: FieldProps) {
  const id = useId();
  const { label, hint, error, multiline, className, ...rest } = props as FieldProps & {
    className?: string;
  };
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('bk-field', className)}>
      <label className="bk-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className="bk-input"
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        />
      ) : (
        <input
          id={id}
          className="bk-input"
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          {...(rest as InputHTMLAttributes<HTMLInputElement>)}
        />
      )}
      {hint && (
        <span id={`${id}-hint`} className="bk-field__hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="bk-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------- Approval card ----------
export interface ApprovalCardProps {
  id: string;
  /** who is asking, already phrased ("Tala is asking first") */
  asking: string;
  title: string;
  detail?: string;
  tierLabel: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  /** shown once decided ("Approved", "Denied", "Expired") */
  stateLabel?: string;
  approveLabel: string;
  denyLabel: string;
  /** e.g. "You will be asked to confirm it's you" for tier 3 */
  note?: string;
  /**
   * The facts of what will happen (an always-ask card: amount, recipient, full text), shown above the buttons;
   * `missing` values read as the given "not stated" text rather than being hidden.
   */
  facts?: { label: string; value: string | null }[];
  /** the label shown for a fact the call did not give */
  missingLabel?: string;
  /** a warning line above the facts (e.g. the agent did not declare this as a payment) */
  warning?: string;
  /** W16: a module's small picture of what the call will do (where it clicks, what it types) */
  preview?: ReactNode;
  busy?: boolean;
  onApprove(): void;
  onDeny(): void;
}
export function ApprovalCard(p: ApprovalCardProps) {
  const titleId = useId();
  return (
    <section
      className="bk-ask"
      data-state={p.state}
      data-approval={p.id}
      aria-labelledby={titleId}
      tabIndex={-1}
      id={`approval-${p.id}`}
    >
      <div className="bk-ask__row">
        <span>{p.asking}</span>
        <span className="bk-ask__tier">{p.tierLabel}</span>
      </div>
      <h3 className="bk-ask__title" id={titleId}>
        {p.title}
      </h3>
      {p.detail && <p className="bk-ask__detail">{p.detail}</p>}
      {p.preview && (
        <div className="bk-ask__preview" data-testid="approval-preview">
          {p.preview}
        </div>
      )}
      {p.warning && (
        <p className="bk-ask__warn" role="alert">
          {p.warning}
        </p>
      )}
      {p.facts && p.facts.length > 0 && (
        <dl className="bk-ask__facts" data-testid="approval-facts">
          {p.facts.map((f) => (
            <div key={f.label} className="bk-ask__fact" data-missing={f.value === null || undefined}>
              <dt>{f.label}</dt>
              <dd>{f.value ?? p.missingLabel ?? '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.state === 'pending' ? (
        <>
          <div className="bk-ask__btns">
            <Button variant="primary" disabled={p.busy} onClick={p.onApprove}>
              {p.approveLabel}
            </Button>
            <Button variant="secondary" disabled={p.busy} onClick={p.onDeny}>
              {p.denyLabel}
            </Button>
          </div>
          {p.note && <p className="bk-ask__note">{p.note}</p>}
        </>
      ) : (
        <p className="bk-ask__note" data-testid="approval-state">
          {p.stateLabel ?? p.state}
        </p>
      )}
    </section>
  );
}

// ---------- Decision bar ----------
export function DecisionBar({
  title,
  text,
  actionLabel,
  onAction,
  secondary,
  busy,
}: {
  title: string;
  text: string;
  actionLabel: string;
  onAction(): void;
  /** a second answer next to the main one (e.g. Deny beside Approve) */
  secondary?: { label: string; onAction(): void };
  busy?: boolean;
}) {
  const main = (
    <Button size="sm" variant="primary" onClick={onAction} disabled={busy}>
      {actionLabel}
    </Button>
  );
  return (
    <div className="bk-decide" role="status" data-testid="decision-bar">
      <b>{title}</b>
      <span className="bk-decide__text">{text}</span>
      {secondary ? (
        <span className="bk-decide__acts">
          <Button size="sm" variant="ghost" onClick={secondary.onAction} disabled={busy}>
            {secondary.label}
          </Button>
          {main}
        </span>
      ) : (
        main
      )}
    </div>
  );
}

// ---------- Helper card (W40: ONE card family) ----------
export type HelperCardVariant = 'ok' | 'info' | 'connect' | 'result' | 'error' | 'suggestion';
export type HelperCardState = 'open' | 'done' | 'later' | 'dismissed' | 'failed';
export interface HelperCardAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'ghost';
  onAction(): void;
}
export interface HelperCardProps {
  /** `card-<id>` on the section, so the decision bar's "Show in the chat" can scroll to it and focus it */
  id: string;
  variant: HelperCardVariant;
  /** a small line above the title (who it is from, "Needs your OK") */
  kicker?: string;
  /** the helper's face or an icon, beside the kicker */
  badge?: ReactNode;
  title: string;
  text?: string;
  /** a preview inside the card (live browser picture, file chip); capped to the card's width */
  visual?: ReactNode;
  actions: HelperCardAction[];
  state: HelperCardState;
  /** the one line a settled card collapses to ("Done", "Later", "Signed in again"), in the reader's language */
  settledLabel: string;
  /** technical words (shown only when the caller passes them: "Technical words" on) */
  details?: { label: string; text: string };
  busy?: boolean;
  /** a plain error line after a tap that did not work */
  error?: string;
  /** an urgent card (something is blocked) is announced once (a live region around the title; it stays a heading) */
  urgent?: boolean;
  testId?: string;
}
/**
 * The one card for everything a helper needs from, or shows, the owner: needs-your-OK, needs-info, connect, result,
 * something-went-wrong-with-a-way-out, suggestion. A section labelled by its title; one primary button first, then up
 * to two others; buttons stack full width on a phone; a settled card is one line of text (never colour alone).
 */
export function HelperCard(p: HelperCardProps) {
  const titleId = useId();
  const open = p.state === 'open';
  return (
    <section
      className={cx('bk-hcard', !open && 'bk-hcard--settled')}
      data-variant={p.variant}
      data-state={p.state}
      data-testid={p.testId ?? 'helper-card'}
      data-card-id={p.id}
      id={`card-${p.id}`}
      tabIndex={-1}
      aria-labelledby={titleId}
    >
      {open ? (
        <>
          {(p.kicker || p.badge) && (
            <div className="bk-hcard__kicker">
              {p.badge}
              {p.kicker && <span>{p.kicker}</span>}
            </div>
          )}
          {p.urgent ? (
            <div role="alert">
              <h3 className="bk-hcard__title" id={titleId}>
                {p.title}
              </h3>
            </div>
          ) : (
            <h3 className="bk-hcard__title" id={titleId}>
              {p.title}
            </h3>
          )}
          {p.text && (
            <p className="bk-hcard__text" dir="auto">
              {p.text}
            </p>
          )}
          {p.visual && <div className="bk-hcard__visual">{p.visual}</div>}
          {p.actions.length > 0 && (
            <div className="bk-hcard__btns">
              {p.actions.map((a) => (
                <Button
                  key={a.id}
                  variant={a.style ?? 'secondary'}
                  disabled={p.busy}
                  onClick={a.onAction}
                  data-card-action={a.id}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          {p.error && (
            <p className="bk-hcard__error" role="alert">
              {p.error}
            </p>
          )}
          {p.details && (
            <details className="bk-hcard__details">
              <summary>{p.details.label}</summary>
              <pre>{p.details.text}</pre>
            </details>
          )}
        </>
      ) : (
        <p className="bk-hcard__line" data-testid="card-settled">
          <span aria-hidden="true" className="bk-hcard__tick">
            {p.state === 'done' ? '✓' : '–'}
          </span>
          <b id={titleId}>{p.title}</b>
          <span className="bk-hcard__settled">{p.settledLabel}</span>
        </p>
      )}
    </section>
  );
}

// ---------- Sheet (modal dialog) ----------
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="bk-sheet" onClose={onClose} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
