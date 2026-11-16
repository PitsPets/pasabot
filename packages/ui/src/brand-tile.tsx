/**
 * BrandTile (polish direction B): the icon of a brain, connector, chat app, store or plugin on a neutral tile, in
 * place of a letter monogram. A brand is drawn with its real mark (Simple Icons) in its own colour at 56 % of the
 * tile; where that colour keeps under 3:1 on the tile in a theme, the mark is drawn in ink there (light and dark are
 * worked out per brand, see brand-data.gen.ts). A brand Simple Icons does not ship gets a neutral lettermark, never an
 * imitation. Things that are not brands use PasaBot's own line glyphs; brains that are not drawn in a brand colour
 * get their tone (`--bk-brain-<id>`). Decorative (`aria-hidden`): the visible name beside it carries the meaning.
 */

import { BRAND_MARKS } from './icons/brands.js';
import { Icon, type IconName } from './icons/icons.js';

/** brains with a tone of their own (`--bk-brain-<id>` in styles.css, light and dark) */
export const BRAIN_TONE_IDS: readonly string[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'opencode',
  'local',
  'acp',
];

/** ids that share another id's mark (catalogue slugs, provider ids, store ids) */
const ALIASES: Record<string, string> = {
  'local:ollama': 'ollama',
  'local:lmstudio': 'lmstudio',
  xai: 'grok',
  calendar: 'google-calendar',
  'github-remote': 'github',
  'tiktok-shop': 'tiktok',
  'naver-shopping': 'naver',
  'yahoo-shopping': 'yahoo',
  'mercado-libre': 'mercado',
  'mercado-livre': 'mercado',
  'microsoft-outlook': 'outlook',
  'custom-store': 'store-add',
  inbox: 'inbox-imap',
  imap: 'inbox-imap',
  hindsight: 'memory',
  'agentchat-bridge': 'bridge',
  mcp: 'mcp-server',
};

/** a provider id's family: `claude-code` -> `claude`, `local:ollama` -> `local`, `acp:foo` -> `acp` */
export const markFamily = (id: string) => id.split(/[:._-]/)[0] ?? id;

export type ResolvedMark =
  | { kind: 'brand' | 'own' | 'letter'; id: string }
  | { kind: 'line'; id: string; icon: IconName };

/** Which mark an id draws: itself, an alias, its family (`claude-code` -> claude), or the fallback line icon. */
export function resolveMark(id: string, fallback: IconName = 'sparkle'): ResolvedMark {
  for (const k of [id, markFamily(id)]) {
    const m = ALIASES[k] ?? k;
    const mark = Object.hasOwn(BRAND_MARKS, m) ? BRAND_MARKS[m] : undefined;
    if (mark) return { kind: mark.kind, id: m };
  }
  return { kind: 'line', id, icon: fallback };
}

/** the brain tone an id has (`claude-code` -> `claude`), or null */
export function brainTone(id: string): string | null {
  const fam = markFamily(id);
  return BRAIN_TONE_IDS.includes(id) ? id : BRAIN_TONE_IDS.includes(fam) ? fam : null;
}

export interface BrandTileProps {
  /** a brain / provider id, a connector slug, a chat app, a store id or a plugin id */
  id: string;
  size?: number;
  /** a brain tone to tint a mark that has no brand colour with; default: the id's own brain tone, else ink */
  tone?: string | null;
  /** the line icon for an id without a mark (default `sparkle`) */
  fallback?: IconName;
  className?: string;
}

export function BrandTile({ id, size = 40, tone, fallback, className }: BrandTileProps) {
  const r = resolveMark(id, fallback);
  const mark = r.kind === 'line' ? undefined : BRAND_MARKS[r.id];
  const t = tone === undefined ? brainTone(id) : tone;
  const inner = Math.round(size * (r.kind === 'brand' ? 0.5 : 0.56));
  const style: Record<string, string> = {
    '--tile': `${size}px`,
    '--tile-r': `${Math.round(size * 0.3)}px`,
  };
  if (mark?.kind === 'brand') {
    if (mark.light) style['--tile-brand-light'] = mark.light;
    if (mark.dark) style['--tile-brand-dark'] = mark.dark;
  } else if (t) style['--tile-mark'] = `var(--bk-brain-${t})`;
  if (mark?.kind === 'letter') style['--tile-letter'] = `${Math.max(12, Math.round(size * 0.46))}px`;
  return (
    <span
      className={className ? `bk-brand-tile ${className}` : 'bk-brand-tile'}
      data-mark={r.id}
      data-kind={r.kind}
      style={style}
      aria-hidden="true"
    >
      {mark?.kind === 'letter' ? (
        <span className="bk-brand-tile__letters">{mark.letters}</span>
      ) : mark?.kind === 'brand' ? (
        <svg
          width={inner}
          height={inner}
          viewBox="0 0 24 24"
          focusable="false"
          aria-hidden="true"
          fill="currentColor"
        >
          <path d={mark.path} />
        </svg>
      ) : mark?.kind === 'own' ? (
        <svg
          width={inner}
          height={inner}
          viewBox="0 0 24 24"
          focusable="false"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {mark.body}
        </svg>
      ) : (
        <Icon name={r.kind === 'line' ? r.icon : (fallback ?? 'sparkle')} size={inner} />
      )}
    </span>
  );
}
