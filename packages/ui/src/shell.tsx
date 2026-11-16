/**
 * Shell building blocks for the simplified screens (Simplify spec 11): Switch, Menu, ListRow, IconTile and
 * StatusChip. Presentational only: callers pass translated labels.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Icon } from './icons/icons.js';

// ---------- Switch ----------
/** An on/off switch (`role="switch"`): 36 x 22 track on desktop, 44 x 28 on touch; optional visible label. */
export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  icon,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  /** visible label (hidden on phones when `ariaLabel` names it) */
  label?: string;
  /** accessible name, when it says more than the visible label */
  ariaLabel?: string;
  icon?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      className="bk-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
    >
      {label && (
        <span className="bk-switch__label">
          {icon && <Icon name={icon} size={16} />}
          <span>{label}</span>
        </span>
      )}
      <span className="bk-switch__track" aria-hidden="true">
        <span className="bk-switch__thumb" />
      </span>
    </button>
  );
}

// ---------- IconTile + StatusChip ----------
/** An icon in a soft rounded square (rows, page headers). */
export function IconTile({ name, size = 32 }: { name: string | undefined; size?: number }) {
  return (
    <span className="bk-icon-tile" style={{ ['--tile' as string]: `${size}px` }} aria-hidden="true">
      <Icon name={name} size={Math.round(size * 0.6)} />
    </span>
  );
}

export type ChipTone = 'neutral' | 'work' | 'ask' | 'danger';
export function StatusChip({
  tone = 'neutral',
  icon,
  label,
}: {
  tone?: ChipTone;
  icon?: string;
  label: string;
}) {
  return (
    <span className={`bk-chip bk-chip--${tone}`}>
      {icon && <Icon name={icon} size={16} />}
      <span>{label}</span>
    </span>
  );
}

// ---------- ListRow ----------
/**
 * A row: icon tile + label + hint, opened by its main link; `trailing` (a switch, a button) sits outside the link
 * so no control is nested in another. 48 px on desktop, 56 px on phones.
 */
export function ListRow({
  icon,
  label,
  hint,
  href,
  onOpen,
  current,
  trailing,
  chevron = true,
  testId,
  meta,
}: {
  icon?: string;
  label: string;
  hint?: string;
  href?: string;
  onOpen?(): void;
  current?: boolean;
  trailing?: ReactNode;
  chevron?: boolean;
  testId?: string;
  /** extra line content after the hint (a status chip, a breadcrumb) */
  meta?: ReactNode;
}) {
  const body = (
    <>
      <IconTile name={icon} />
      <span className="bk-row__t">
        <span className="bk-row__label">{label}</span>
        {hint && <span className="bk-row__hint">{hint}</span>}
        {meta}
      </span>
      {chevron && <Icon name="chevron" size={16} className="bk-row__chev bk-icon--flip" />}
    </>
  );
  return (
    <div className="bk-row" data-testid={testId} data-current={current ? 'true' : undefined}>
      {href ? (
        <a className="bk-row__main" href={href} aria-current={current ? 'page' : undefined}>
          {body}
        </a>
      ) : (
        <button type="button" className="bk-row__main" onClick={onOpen}>
          {body}
        </button>
      )}
      {trailing && <span className="bk-row__end">{trailing}</span>}
    </div>
  );
}

// ---------- Menu ----------
export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  /** a link item (`#/...`) */
  href?: string;
  onSelect?(): void;
  /** a checked choice (language) */
  checked?: boolean;
  /** rendered as `lang` / `dir` of the item (a language list) */
  lang?: string;
  testId?: string;
  /** keep the menu open after selecting (an item that opens a panel inside the menu) */
  keepOpen?: boolean;
}

/** True when a key press comes from inside an open dialog (a Sheet a menu panel opened): that Escape is the dialog's. */
const inDialog = (t: EventTarget | null) => t instanceof Element && !!t.closest('dialog[open]');

/** Close a popover on Escape and on a press outside of it. */
function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      close();
    };
    // Escape closes it wherever focus is (the popover may have lost focus to a resize or a scroll)
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !inDialog(e.target)) close();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, close, refs]);
}

/**
 * A popover menu from a trigger button (a bottom sheet under 600 px). Arrow keys move between items, Home/End jump,
 * Escape closes and returns focus to the trigger. `children` adds free content under the items (a language list,
 * a look switch, a module panel); it gets `close`.
 */
export function Menu({
  label,
  trigger,
  triggerClass = 'bk-menu__btn',
  triggerTitle,
  triggerTestId,
  triggerAttrs,
  items = [],
  header,
  children,
  testId,
  align = 'end',
  onOpenChange,
}: {
  /** accessible name of the trigger and of the menu */
  label: string;
  trigger: ReactNode;
  triggerClass?: string;
  triggerTitle?: string;
  triggerTestId?: string;
  triggerAttrs?: Record<string, string | undefined>;
  items?: MenuItem[];
  header?: ReactNode;
  children?: (close: () => void) => ReactNode;
  testId?: string;
  align?: 'start' | 'end';
  onOpenChange?(open: boolean): void;
}) {
  const [open, setOpenRaw] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const setOpen = useCallback(
    (v: boolean) => {
      setOpenRaw(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, [setOpen]);
  const refs = useRef([btn, pop]).current;
  useDismiss(open, () => setOpen(false), refs);
  useEffect(() => {
    if (!open) return;
    const first = pop.current?.querySelector<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], button, a',
    );
    first?.focus();
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // keys inside a Sheet opened from the menu are the Sheet's: Escape closes only that Sheet, arrows stay its own
    if (inDialog(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = [
      ...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []),
    ];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? list.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % list.length
            : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  };
  return (
    <span className="bk-menu" data-open={open ? 'true' : undefined}>
      <button
        ref={btn}
        type="button"
        className={triggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={triggerTitle}
        onClick={() => setOpen(!open)}
        data-testid={triggerTestId}
        {...triggerAttrs}
      >
        {trigger}
      </button>
      {open && (
        <>
          <span className="bk-menu__scrim" aria-hidden="true" />
          {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: role is menu or dialog */}
          <div
            ref={pop}
            id={id}
            className={`bk-menu__pop bk-menu__pop--${align}`}
            data-layer="popover"
            role={children ? 'group' : 'menu'}
            aria-label={label}
            onKeyDown={onKey}
            onBlur={(e) => {
              // Tab (or a click) taking focus out of the popover closes it, so the sheet never stays open over a
              // page that focus has moved into; a focused item that unmounts (a panel swap) has no target and stays
              const to = e.relatedTarget as Node | null;
              if (to && !pop.current?.contains(to) && to !== btn.current) setOpen(false);
            }}
            data-testid={testId}
          >
            {header}
            {items.length > 0 && (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a menu inside the dialog variant
              <div role={children ? 'menu' : undefined} aria-label={children ? label : undefined}>
                {items.map((it) => {
                  const inner = (
                    <>
                      <Icon name={it.icon ?? (it.checked ? 'check-circle' : 'dot')} />
                      <span className="bk-menu__label">{it.label}</span>
                    </>
                  );
                  const role = it.checked === undefined ? 'menuitem' : 'menuitemradio';
                  return it.href ? (
                    <a
                      key={it.id}
                      role={role}
                      className="bk-menu__item"
                      href={it.href}
                      onClick={close}
                      data-testid={it.testId}
                    >
                      {inner}
                    </a>
                  ) : (
                    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is menuitemradio when checked is set
                    <button
                      key={it.id}
                      type="button"
                      role={role}
                      aria-checked={it.checked}
                      className="bk-menu__item"
                      lang={it.lang}
                      onClick={() => {
                        // closing gives focus back to the trigger; onSelect may still move it on (a panel, a page)
                        if (!it.keepOpen) close();
                        it.onSelect?.();
                      }}
                      data-testid={it.testId}
                    >
                      {inner}
                    </button>
                  );
                })}
              </div>
            )}
            {children?.(close)}
          </div>
        </>
      )}
    </span>
  );
}
