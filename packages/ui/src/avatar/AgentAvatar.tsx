import { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import type { AgentStatus } from '../components.js';
import { avatarRhythm, avatarSeed, avatarTraits, buildAvatarInner } from './generator.js';

export type AvatarState = 'idle' | 'thinking' | 'speaking' | 'offline';
export type AvatarShape = 'circle' | 'rounded';

export interface AgentAvatarProps {
  agentId: string;
  /** the owner's re-roll salt (seed = agent id + salt); empty = the original look */
  salt?: string | null;
  /** px; default 32 */
  size?: number;
  /** default: circle at 28 px and under (lists), 28 % rounded square above */
  shape?: AvatarShape;
  /** idle (default), thinking (working/typing), speaking (reply streaming), offline (eyes closed, still) */
  state?: AvatarState;
  /** already translated ("Avatar of Tala"); omit when the name is shown next to it (decorative) */
  label?: string;
  status?: AgentStatus;
  statusLabel?: string;
  className?: string;
}

const SMALL = 28;
const LARGE = 80;

/**
 * An agent's generated avatar. The markup is our own (numbers and fixed tables from a hash of the seed; no seed
 * text ever reaches it), so it is injected as-is. Motion is CSS (see avatar.css); only a large avatar on a
 * pointer device runs one pointermove listener so the pupils follow the cursor a little.
 */
export function AgentAvatar({
  agentId,
  salt,
  size = 32,
  shape,
  state = 'idle',
  label,
  status,
  statusLabel,
  className,
}: AgentAvatarProps) {
  const seed = avatarSeed(agentId, salt);
  const svg = useMemo(
    () =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">${buildAvatarInner(seed, true)}</svg>`,
    [seed],
  );
  const traits = useMemo(() => avatarTraits(seed), [seed]);
  const r = useMemo(() => avatarRhythm(seed), [seed]);
  const ref = useRef<HTMLSpanElement>(null);
  const px = Math.max(1, Math.round(size));
  const sizeKey = px <= SMALL ? 'sm' : px >= LARGE ? 'lg' : 'md';
  const follow = sizeKey === 'lg' && traits.pupils && state !== 'offline';

  useEffect(() => {
    const el = ref.current;
    if (!follow || !el || typeof window === 'undefined' || !window.matchMedia) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      if (!last) return;
      const b = el.getBoundingClientRect();
      const dx = last.clientX - (b.left + b.width / 2);
      const dy = last.clientY - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 240) * 1.6; // at most 1.6 viewBox units
      el.style.setProperty('--bk-av-fx', ((dx / d) * k).toFixed(2));
      el.style.setProperty('--bk-av-fy', ((dy / d) * k).toFixed(2));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty('--bk-av-fx');
      el.style.removeProperty('--bk-av-fy');
    };
  }, [follow]);

  const style = {
    '--size': `${px}px`,
    '--bk-av-blink': `${r.blink}s`,
    '--bk-av-blink-delay': `${r.blinkDelay}s`,
    '--bk-av-glance': `${r.glance}s`,
    '--bk-av-glance-delay': `${r.glanceDelay}s`,
    '--bk-av-dir': String(r.dir),
  } as CSSProperties;
  const named = !!label;
  // a named avatar is an image; next to the name it is decorative (hidden), unless it carries a status label
  const a11y = named
    ? { role: 'img' as const, 'aria-label': statusLabel ? `${label}, ${statusLabel}` : label }
    : statusLabel
      ? {}
      : { 'aria-hidden': true as const };
  return (
    <span
      ref={ref}
      className={`bk-blob bk-av${className ? ` ${className}` : ''}`}
      data-shape={shape ?? (px <= SMALL ? 'circle' : 'rounded')}
      data-state={state}
      data-size={sizeKey}
      data-mouth={traits.mouth ? 'yes' : 'none'}
      data-testid="agent-avatar"
      style={style}
      {...a11y}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: generated from numbers/enums only, never from user text (see generator.ts + avatar.test.ts) */}
      <span className="bk-av__clip" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      {status && (
        <span className={`bk-blob__status bk-status--${status}`} data-status={status}>
          {statusLabel && !named && <span className="bk-visually-hidden">{statusLabel}</span>}
        </span>
      )}
    </span>
  );
}
