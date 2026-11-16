/**
 * Marks for the icon tiles (BrandTile). Brand marks are the real ones, from Simple Icons (CC0; Git: CC BY 3.0, "Git
 * Logo by Jason Long"), generated into brand-data.gen.ts by packages/ui/scripts/gen-brands.ts; brands Simple Icons
 * does not ship get a neutral lettermark, never an imitation. The own glyphs below are PasaBot's line style for
 * things that are not a brand (a folder, a clock, your own tool server). Sources and licences: docs/BRANDS.md,
 * packages/ui/assets/icons/ (manifest.json, NOTICE.md). Trademarks belong to their owners; used only to name the
 * service.
 */
import type { ReactNode } from 'react';
import { BRAND_ICONS, type BrandIcon, LETTER_MARKS } from './brand-data.gen.js';

export type MarkKind = 'brand' | 'own' | 'letter';
export type Mark =
  | ({ kind: 'brand' } & BrandIcon)
  | { kind: 'letter'; title: string; letters: string }
  | { kind: 'own'; body: ReactNode };

/** PasaBot's own line glyphs (24 px grid, stroke 1.75, round caps); SVG sources in assets/icons/ */
export const OWN_MARKS: Record<string, { body: ReactNode }> = {
  local: {
    body: (
      <>
        <rect x="4" y="5" width="16" height="11" rx="2" />
        <path d="M2.5 19h19" />
        <path d="M9.5 12.5v-2l2.5-2 2.5 2v2z" />
      </>
    ),
  },
  acp: {
    body: (
      <>
        <rect x="3" y="6" width="8" height="8" rx="2.5" />
        <rect x="13" y="10" width="8" height="8" rx="2.5" />
        <path d="M11 10h2.5M10.5 14H13" />
      </>
    ),
  },
  filesystem: {
    body: (
      <>
        <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        <path d="M3.5 10.5h17" />
      </>
    ),
  },
  time: {
    body: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
  },
  'mcp-server': {
    body: (
      <>
        <rect x="4" y="4" width="16" height="7" rx="2" />
        <rect x="4" y="13" width="16" height="7" rx="2" />
        <path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5" />
      </>
    ),
  },
  'mcp-add': {
    body: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" strokeDasharray="3 2.4" />
        <path d="M12 8.5v7M8.5 12h7" />
      </>
    ),
  },
  'inbox-imap': {
    body: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
        <path d="M4 7l8 6 8-6" />
      </>
    ),
  },
  webhook: {
    body: (
      <>
        <circle cx="7" cy="16.5" r="2.5" />
        <circle cx="17" cy="16.5" r="2.5" />
        <circle cx="12" cy="7" r="2.5" />
        <path d="M11 9.3L8.2 14.3M13 9.3l2.8 5M9.5 16.5h5" />
      </>
    ),
  },
  store: {
    body: (
      <>
        <path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
        <path d="M9 10V7a3 3 0 0 1 6 0v3" />
      </>
    ),
  },
  'store-add': {
    body: (
      <>
        <path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
        <path d="M9 8V7a3 3 0 0 1 6 0v1M12 12v5M9.5 14.5h5" />
      </>
    ),
  },
  memory: {
    body: (
      <>
        <path d="M12 4c-3 0-5.5 1.3-5.5 3s2.5 3 5.5 3 5.5-1.3 5.5-3-2.5-3-5.5-3z" />
        <path d="M6.5 7v5c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3V7M6.5 12v5c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-5" />
      </>
    ),
  },
  bridge: {
    body: (
      <>
        <path d="M4 7h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3 2.5V15H4z" />
        <path d="M16 10h4v6h-1.5v2L16 16" />
      </>
    ),
  },
};

/** every mark BrandTile can draw, by id: real brand marks, lettermarks and own glyphs */
export const BRAND_MARKS: Record<string, Mark> = {
  ...Object.fromEntries(
    Object.entries(OWN_MARKS).map(([id, m]) => [id, { kind: 'own' as const, body: m.body }]),
  ),
  ...Object.fromEntries(
    Object.entries(LETTER_MARKS).map(([id, m]) => [id, { kind: 'letter' as const, ...m }]),
  ),
  ...Object.fromEntries(Object.entries(BRAND_ICONS).map(([id, m]) => [id, { kind: 'brand' as const, ...m }])),
};
