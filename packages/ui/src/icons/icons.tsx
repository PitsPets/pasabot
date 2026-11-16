/**
 * PasaBot's own line icons (Simplify spec 7): 24 x 24 grid, 2 px padding, stroke 1.75, round caps and joins,
 * `currentColor`. Drawn for PasaBot; no third-party icon set. Decorative by default (`aria-hidden`); pass `title`
 * only when the icon is the control's only content (Stop all on a phone, Close, More, Back, Send, Attach, Voice).
 * Module `icon` strings resolve through `iconName` (older names alias to these; unknown names fall back to `dot`).
 */
import type { ReactNode } from 'react';

export const ICONS = {
  chats: (
    <>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M8 10h8M8 13h5" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="7" width="16" height="13" rx="4" />
      <path d="M12 7V4" />
      <circle cx="12" cy="3.2" r=".9" />
      <circle cx="9" cy="13" r="1.2" />
      <circle cx="15" cy="13" r="1.2" />
    </>
  ),
  brain: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z" />
    </>
  ),
  tools: (
    <>
      <rect x="3" y="8" width="18" height="12" rx="2.5" />
      <path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8M3 13.5h18M10 13.5v2h4v-2" />
    </>
  ),
  book: (
    <>
      <path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2z" />
      <path d="M12 6v14" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v4M15 3v4" />
      <path d="M7 7h10v4a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </>
  ),
  blocks: (
    <>
      <rect x="4" y="12" width="7" height="7" rx="1.5" />
      <rect x="13" y="12" width="7" height="7" rx="1.5" />
      <rect x="8.5" y="4" width="7" height="7" rx="1.5" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18" />
      <circle cx="6.5" cy="6.5" r=".6" />
      <circle cx="9" cy="6.5" r=".6" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5h4" />
    </>
  ),
  workflow: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M8.5 18h7" />
    </>
  ),
  handshake: (
    <>
      <path d="M4 9h13l-3-3M20 15H7l3 3" />
    </>
  ),
  'key-token': (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v3M20 12v2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v3M20 12v2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  hand: (
    <>
      <path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7c-2.5 0-4-1.2-5.5-3.5L3 14.5a1.6 1.6 0 0 1 2.6-1.8L8 15" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 7l11-3v3" />
      <circle cx="16" cy="13.5" r="1" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.5A6 6 0 0 1 21 20" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="8" height="16" rx="2" />
      <path d="M14 8h7v9h-7M13 19h9" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21h4" />
    </>
  ),
  'bell-off': (
    <>
      <path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" />
      <path d="M10 21h4M4 4l16 16" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  bolt: <path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z" />,
  channels: (
    <>
      <path d="M4 5h11a1.5 1.5 0 0 1 1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5H9l-3 2.5v-2.5H4A1.5 1.5 0 0 1 2.5 12V6.5A1.5 1.5 0 0 1 4 5z" />
      <path d="M19.5 9h.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5h-1V20l-3-2.5h-4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="2" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
      <circle cx="8" cy="7.5" r=".9" />
      <circle cx="8" cy="16.5" r=".9" />
    </>
  ),
  bag: (
    <>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 10V7a3 3 0 0 1 6 0v3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </>
  ),
  memory: (
    <>
      <path d="M6 3h12v18l-6-4-6 4z" />
      <path d="M9 8h6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  'sun-moon': (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="var(--bg,#fff)" />
      <circle cx="15" cy="12" r="2" fill="var(--bg,#fff)" />
      <circle cx="7" cy="18" r="2" fill="var(--bg,#fff)" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </>
  ),
  wrench: (
    <>
      <path d="M14.5 4.5a4.5 4.5 0 0 0 5 6l-9.4 9.4a2 2 0 0 1-2.8-2.8l9.4-9.4" />
      <path d="M14.5 4.5l-.5 3.5 2 2 3.5-.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 2.8l2 .4.6 2.2 1.9 1.1 2.2-.6 1.4 1.5-.6 2.2 1.1 1.9 2.2.6v2l-2.2.6-1.1 1.9.6 2.2-1.4 1.5-2.2-.6-1.9 1.1-.6 2.2-2 .4-2-.4-.6-2.2-1.9-1.1-2.2.6-1.4-1.5.6-2.2-1.1-1.9-2.2-.6v-2l2.2-.6 1.1-1.9-.6-2.2 1.4-1.5 2.2.6 1.9-1.1.6-2.2z"
        transform="translate(12 12) scale(.82) translate(-12 -12)"
      />
    </>
  ),
  pin: (
    <>
      <path d="M14.5 3.5l6 6-2.5 1-3.5 3.5.5 4-1.5 1.5-4-4-5 5M9.5 13.5l-3-3L8 9l4 .5L15.5 6z" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M4 4l16 16" />
    </>
  ),
  stop: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),
  back: (
    <>
      <path d="M15 5l-7 7 7 7" />
    </>
  ),
  chevron: (
    <>
      <path d="M9 5l7 7-7 7" />
    </>
  ),
  paperclip: (
    <>
      <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4L15 7.3" />
    </>
  ),
  send: (
    <>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
      <circle cx="9" cy="10" r=".6" fill="currentColor" />
      <circle cx="15" cy="10" r=".6" fill="currentColor" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r=".7" fill="currentColor" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z" />
      <path d="M13.5 7l3 3" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.3" r=".7" fill="currentColor" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7 10l5 5 5-5" />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>
  ),
  'cloud-off': (
    <>
      <path d="M7.5 18H17a4 4 0 0 0 1-7.9A6 6 0 0 0 8.2 7.5M6.2 9.4A4.5 4.5 0 0 0 7.5 18" />
      <path d="M4 4l16 16" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l5.5-3.5z" />
    </>
  ),
  'log-out': (
    <>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M15 8l4 4-4 4M19 12H9" />
    </>
  ),
  dot: (
    <>
      <circle cx="12" cy="12" r="3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Names modules used before the icon set existed, mapped to their icon (spec 7). */
const ALIASES: Record<string, IconName> = {
  mail: 'inbox',
  flow: 'workflow',
  chart: 'wallet',
  note: 'pencil',
  gear: 'settings',
};

/** The registry name for a module's `icon` string: itself, an alias, or `dot`. */
export function iconName(name: string | undefined): IconName {
  if (name && Object.hasOwn(ICONS, name)) return name as IconName;
  return (name && ALIASES[name]) || 'dot';
}

export function Icon({
  name,
  size = 20,
  title,
  className,
}: {
  name: string | undefined;
  size?: number;
  /** accessible name; only when the icon stands alone */
  title?: string;
  className?: string;
}) {
  const n = iconName(name);
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative unless `title` is given (then it has one)
    <svg
      className={className ? `bk-icon ${className}` : 'bk-icon'}
      data-icon={n}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={n === 'stop' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {ICONS[n]}
    </svg>
  );
}
