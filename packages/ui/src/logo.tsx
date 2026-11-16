/**
 * The PasaBot logo, direction 1 "Silip": the cream bot peeking up from the forest plate, amber antenna light
 * (sources in `packages/ui/assets/logo/`). Above 24 px it draws the full mark; at 24 px and under the simplified
 * small cut. The idle glance (eyes) and the breathing antenna light are CSS only (`.pb-logo` in styles.css) and
 * stop under prefers-reduced-motion. Presentational: the caller names the link it sits in.
 */
import { useId } from 'react';

export interface LogoMarkProps {
  /** rendered size in px (square) */
  size?: number;
  /** animate the idle glance and the antenna light (the header lockup) */
  animated?: boolean;
  className?: string;
}

export function LogoMark({ size = 32, animated = false, className }: LogoMarkProps) {
  const raw = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (s: string) => `pb${raw}${s}`;
  const small = size <= 24;
  const cls = ['pb-logo', animated ? 'pb-logo--idle' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      viewBox="0 0 128 128"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-testid="logo-mark"
    >
      <defs>
        <clipPath id={id('c')}>
          <rect width="128" height="128" rx="30" />
        </clipPath>
        <linearGradient id={id('p')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1F6346" />
          <stop offset="1" stopColor="#0F3424" />
        </linearGradient>
        <linearGradient id={id('b')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFDF6" />
          <stop offset="1" stopColor="#F3EAD6" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="30" fill={`url(#${id('p')})`} />
      {small ? (
        <g clipPath={`url(#${id('c')})`}>
          <path d="M64 26 V19" stroke="#F3EAD6" strokeWidth="5.5" strokeLinecap="round" />
          <circle className="pb-light" cx="64" cy="13.5" r="9" fill="#F0B23A" />
          <path d="M18 140 V72 A46 46 0 0 1 110 72 V140Z" fill={`url(#${id('b')})`} />
          <g className="pb-eyes">
            <ellipse cx="47" cy="71" rx="12" ry="15.5" fill="#14432F" />
            <ellipse cx="81" cy="71" rx="12" ry="15.5" fill="#14432F" />
          </g>
        </g>
      ) : (
        <g clipPath={`url(#${id('c')})`}>
          <path d="M64 37 V25" stroke="#F3EAD6" strokeWidth="4" strokeLinecap="round" />
          <circle className="pb-light" cx="64" cy="21.4" r="7.2" fill="#F0B23A" />
          <circle cx="61.8" cy="19.2" r="2" fill="#FFE3A3" />
          <path d="M25.2 140 V74.5 A38.8 38.8 0 0 1 102.8 74.5 V140Z" fill={`url(#${id('b')})`} />
          <g className="pb-eyes">
            <ellipse cx="48.5" cy="75.2" rx="9.6" ry="12.7" fill="#14432F" />
            <ellipse cx="83.6" cy="75.2" rx="9.6" ry="12.7" fill="#14432F" />
            <circle cx="52.2" cy="70.5" r="3.1" fill="#FFFDF6" />
            <circle cx="87.3" cy="70.5" r="3.1" fill="#FFFDF6" />
          </g>
          <circle cx="36.3" cy="91" r="4.7" fill="#E26A4C" opacity=".5" />
          <circle cx="91.7" cy="91" r="4.7" fill="#E26A4C" opacity=".5" />
          <path
            d="M56.5 92.9 Q64 99.7 71.5 92.9"
            fill="none"
            stroke="#14432F"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </g>
      )}
      <rect
        x="1"
        y="1"
        width="126"
        height="126"
        rx="29"
        fill="none"
        stroke="#fff"
        strokeOpacity=".14"
        strokeWidth="2"
      />
    </svg>
  );
}

export interface LogoLockupProps {
  /** mark size in px: 32 in the desktop header, 28 on the phone */
  size?: number;
  animated?: boolean;
}

/** Mark + "PasaBot" wordmark. The wordmark is real text, so it keeps the brand link's name for screen readers. */
export function LogoLockup({ size = 32, animated = false }: LogoLockupProps) {
  return (
    <span className="pb-lockup" style={{ ['--pb-size' as string]: `${size}px` }}>
      <LogoMark size={size} animated={animated} />
      <b className="pb-word">PasaBot</b>
    </span>
  );
}
