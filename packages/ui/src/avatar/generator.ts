/**
 * Agent avatars, direction "Silip" (the peeker): a shy buddy peeking up from the bottom edge, tone-on-tone on the
 * agent colour, big white eyes that glance around. A faithful port of the owner-approved generator
 * (`.design/avatars/direction-3.html`, function `pasabotAvatar`); the static output is byte-identical to it.
 *
 * Pure and deterministic: the seed only feeds an FNV-1a hash → mulberry32 PRNG, and every piece of markup is
 * built from numbers and fixed tables. No seed text ever reaches the SVG, there are no element ids (many avatars
 * share a page), no DOM, no network, no Math.random.
 *
 * Parts: body 4 × eyes 18 (4 pupil eyes × 4 glances + 2 pupil-less) × mouth 5 × top 6 × extra 4 × colour 8
 * = 69,120 combinations.
 */

export interface AvatarColor {
  readonly name: string;
  readonly hex: `#${string}`;
}

/** The 8 agent colours (avatar backdrop = the agent's accent colour). */
export const AVATAR_PALETTE: readonly AvatarColor[] = Object.freeze([
  // The first four are the agent colours from the chosen mockup (direction C).
  { name: 'tala', hex: '#F0B23A' }, // amber
  { name: 'kidlat', hex: '#4E79EC' }, // blue
  { name: 'amihan', hex: '#22A088' }, // teal
  { name: 'bayani', hex: '#E26A4C' }, // coral
  { name: 'ube', hex: '#9B82E8' }, // lavender
  { name: 'dahon', hex: '#7CB342' }, // leaf
  { name: 'rosas', hex: '#EC8FAA' }, // pink
  { name: 'langit', hex: '#45B0DC' }, // sky
]);

/** Deep body colour per agent colour (cool, dark hues, so no body ever reads as a skin tone). */
const SILIP_DEEP: Readonly<Record<string, string>> = {
  '#F0B23A': '#14432F', // amber  -> forest (the app's primary)
  '#4E79EC': '#16245A', // blue   -> navy
  '#22A088': '#0D3A33', // teal   -> deep teal
  '#E26A4C': '#1F2A4A', // coral  -> ink navy
  '#9B82E8': '#2A1F58', // ube    -> indigo
  '#7CB342': '#173B24', // leaf   -> pine
  '#EC8FAA': '#3A1E4D', // pink   -> plum
  '#45B0DC': '#103A50', // sky    -> deep sea
};

const WHITE = '#FFFDF6';

/** FNV-1a 32-bit hash of the seed string. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG seeded from the hash: returns () => float in [0, 1). */
function makeRng(seed: string): () => number {
  let a = hashSeed(String(seed));
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickIndex = (rng: () => number, n: number) => Math.floor(rng() * n);

/** Rounded-rectangle path with per-corner radii [tl, tr, br, bl]. */
function roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number]): string {
  const [tl, tr, br, bl] = r;
  return (
    `M${x + tl} ${y}H${x + w - tr}A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}` +
    `V${y + h - br}A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` +
    `H${x + bl}A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}V${y + tl}A${tl} ${tl} 0 0 1 ${x + tl} ${y}Z`
  );
}

const stroke = (d: string, color: string, w: number) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

interface Body {
  name: string;
  top: number;
  eyeY: number;
  mouthY: number;
  dx: number;
  half: number;
  d: string;
  bumps?: boolean;
}

// Bodies run off the bottom edge (y = 64). eyeY / mouthY / dx are tuned per body.
const SILIP_BODIES: readonly Body[] = [
  { name: 'dome', top: 18, eyeY: 37, mouthY: 50, dx: 10, half: 24, d: 'M8 64V42A24 24 0 0 1 56 42V64Z' },
  { name: 'bullet', top: 14, eyeY: 34, mouthY: 47, dx: 8.5, half: 19, d: 'M13 64V33A19 19 0 0 1 51 33V64Z' },
  {
    name: 'loaf',
    top: 22,
    eyeY: 39,
    mouthY: 51,
    dx: 11,
    half: 27,
    d: roundRect(5, 22, 54, 48, [17, 17, 0, 0]),
  },
  {
    name: 'bumps',
    top: 25,
    eyeY: 41,
    mouthY: 52,
    dx: 10,
    half: 24,
    d: roundRect(8, 25, 48, 45, [16, 16, 0, 0]),
    bumps: true,
  },
];

type Glance = readonly [number, number];
const GLANCES: readonly Glance[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, 1],
]; // centre, left, right, down at the chat

/**
 * An eye style, split into the white and the pupil of one eye so the animated renderer can group the pupils
 * (glance / blink) while the static renderer keeps the generator's original order (white, pupil, white, pupil).
 */
interface Eyes {
  pupils: boolean;
  /** x positions of the eyes for left/right x */
  xs(l: number, r: number): number[];
  white(x: number, y: number): string;
  pupil(x: number, y: number, deep: string, g: Glance): string;
}

const two = (l: number, r: number) => [l, r];
const SILIP_EYES: readonly Eyes[] = [
  {
    // round
    pupils: true,
    xs: two,
    white: (x, y) => `<circle cx="${x}" cy="${y}" r="7" fill="${WHITE}"/>`,
    pupil: (x, y, deep, [gx, gy]) =>
      `<circle cx="${x + gx * 2.2}" cy="${y + gy * 2.2}" r="3.6" fill="${deep}"/>`,
  },
  {
    // tall
    pupils: true,
    xs: two,
    white: (x, y) => `<ellipse cx="${x}" cy="${y}" rx="5.6" ry="8" fill="${WHITE}"/>`,
    pupil: (x, y, deep, [gx, gy]) =>
      `<circle cx="${x + gx * 1.6}" cy="${y + 1 + gy * 3}" r="3.3" fill="${deep}"/>`,
  },
  {
    // one big eye
    pupils: true,
    xs: () => [32],
    white: (x, y) => `<circle cx="${x}" cy="${y}" r="10" fill="${WHITE}"/>`,
    pupil: (x, y, deep, [gx, gy]) =>
      `<circle cx="${x + gx * 3.2}" cy="${y + gy * 3.2}" r="4.8" fill="${deep}"/>`,
  },
  {
    // big pupils
    pupils: true,
    xs: two,
    white: (x, y) => `<circle cx="${x}" cy="${y}" r="7.4" fill="${WHITE}"/>`,
    pupil: (x, y, deep, [gx, gy]) =>
      `<circle cx="${x + gx * 1.6}" cy="${y + gy * 1.6}" r="4.8" fill="${deep}"/>` +
      `<circle cx="${x + gx * 1.6 + 1.6}" cy="${y + gy * 1.6 - 1.6}" r="1.5" fill="${WHITE}"/>`,
  },
  {
    // beady
    pupils: false,
    xs: two,
    white: (x, y) => `<circle cx="${x}" cy="${y}" r="4" fill="${WHITE}"/>`,
    pupil: () => '',
  },
  {
    // happy
    pupils: false,
    xs: two,
    white: (x, y) => stroke(`M${x - 5} ${y + 2}Q${x} ${y - 5} ${x + 5} ${y + 2}`, WHITE, 3.8),
    pupil: () => '',
  },
];

const SILIP_MOUTHS: readonly ((y: number) => string)[] = [
  () => '', // none
  (y) => stroke(`M27 ${y - 1}Q32 ${y + 4} 37 ${y - 1}`, WHITE, 3), // smile
  (y) => `<circle cx="32" cy="${y}" r="2.8" fill="${WHITE}"/>`, // o
  (y) => stroke(`M24.5 ${y - 2}Q32 ${y + 5} 39.5 ${y - 2}`, WHITE, 3), // wide smile
  (y) => `<path d="M26.5 ${y - 2}H37.5A5.5 5.5 0 0 1 26.5 ${y - 2}Z" fill="${WHITE}"/>`, // open
];

// Tops sit behind the body. t = body top y.
const SILIP_TOPS: readonly ((t: number, deep: string) => string)[] = [
  () => '',
  (t, deep) =>
    `<rect x="30.5" y="${t - 8}" width="3" height="11" fill="${deep}"/><circle cx="32" cy="${t - 9}" r="4.4" fill="${WHITE}"/>`, // antenna
  (t, deep) =>
    stroke(`M26 ${t + 3}L22 ${t - 5}M38 ${t + 3}L42 ${t - 5}`, deep, 3) +
    `<circle cx="22" cy="${t - 6}" r="3.8" fill="${deep}"/><circle cx="42" cy="${t - 6}" r="3.8" fill="${deep}"/>`, // twin
  (t, deep) =>
    stroke(`M32 ${t + 2}V${t - 5}`, deep, 3) +
    `<ellipse cx="27" cy="${t - 7}" rx="5.6" ry="3.3" transform="rotate(-28 27 ${t - 7})" fill="${deep}"/>` +
    `<ellipse cx="37" cy="${t - 7}" rx="5.6" ry="3.3" transform="rotate(28 37 ${t - 7})" fill="${deep}"/>`, // sprout
  (t, deep) =>
    `<circle cx="25" cy="${t + 2}" r="4.8" fill="${deep}"/><circle cx="32" cy="${t - 1}" r="4.8" fill="${deep}"/><circle cx="39" cy="${t + 2}" r="4.8" fill="${deep}"/>`, // tuft
  (t, deep) =>
    stroke(`M32 ${t + 2}l-3 -3l6 -3l-6 -3l3 -2`, deep, 2.8) +
    `<circle cx="32" cy="${t - 12}" r="3.8" fill="${WHITE}"/>`, // spring
];

// Extras return markup on top of the body.
const SILIP_EXTRAS: readonly ((b: Body, color: string) => string)[] = [
  () => '',
  (b, color) =>
    `<circle cx="${32 - b.dx - 4.5}" cy="${b.mouthY - 3}" r="3.4" fill="${color}"/><circle cx="${32 + b.dx + 4.5}" cy="${b.mouthY - 3}" r="3.4" fill="${color}"/>`, // cheeks
  (b, color) => `<rect x="${32 - b.half}" y="59" width="${b.half * 2}" height="5" fill="${color}"/>`, // collar
  (b) => `<circle cx="32" cy="${b.mouthY + 7.5}" r="2.6" fill="${WHITE}"/>`, // chest light
];

/**
 * The seed for an agent: its id plus the owner's re-roll salt (empty = the original look). A salt that starts with
 * `=` is a whole seed of its own (`=<face>`): a face picked before the agent existed (a team plan's helper), so the
 * plan, the done screen and the app afterwards draw the same face.
 */
export const avatarSeed = (agentId: string, salt?: string | null) =>
  !salt ? agentId : salt.startsWith('=') && salt.length > 1 ? salt.slice(1) : `${agentId}:${salt}`;

interface Picked {
  color: AvatarColor;
  body: Body;
  eyes: Eyes;
  glance: Glance;
  mouthIndex: number;
  top: (t: number, deep: string) => string;
  extra: (b: Body, color: string) => string;
}

function pick(seed: string): Picked {
  const rng = makeRng(seed);
  // The draw order is the generator's: colour, body, eyes, glance (always drawn), mouth, top, extra.
  const color = AVATAR_PALETTE[pickIndex(rng, AVATAR_PALETTE.length)]!;
  const body = SILIP_BODIES[pickIndex(rng, SILIP_BODIES.length)]!;
  const eyes = SILIP_EYES[pickIndex(rng, SILIP_EYES.length)]!;
  const glance = GLANCES[pickIndex(rng, GLANCES.length)]!;
  const mouthIndex = pickIndex(rng, SILIP_MOUTHS.length);
  const top = SILIP_TOPS[pickIndex(rng, SILIP_TOPS.length)]!;
  const extra = SILIP_EXTRAS[pickIndex(rng, SILIP_EXTRAS.length)]!;
  return { color, body, eyes, glance, mouthIndex, top, extra };
}

/** The agent's accent colour (the avatar backdrop) for a seed: one of {@link AVATAR_PALETTE}. */
export function agentAccentColor(seed: string): AvatarColor {
  return pick(seed).color;
}

/** Facts about an avatar the animated renderer needs (does it have pupils to glance with, a mouth to move). */
export function avatarTraits(seed: string): { pupils: boolean; mouth: boolean } {
  const p = pick(seed);
  return { pupils: p.eyes.pupils, mouth: p.mouthIndex !== 0 };
}

const sizeNum = (n: number | undefined, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : fallback;

export interface AgentAvatarSvgOptions {
  /** width/height attribute in px (default 64) */
  size?: number;
}

/**
 * Inner SVG markup. `hooks` wraps parts in fixed class names for CSS animation (the React component); without it
 * the output is the static, animation-free original.
 */
export function buildAvatarInner(seed: string, hooks: boolean): string {
  const { color, body, eyes, glance, mouthIndex, top, extra } = pick(String(seed));
  const deep = SILIP_DEEP[color.hex]!;
  const bumps = body.bumps
    ? `<circle cx="16" cy="27" r="7.5" fill="${deep}"/><circle cx="48" cy="27" r="7.5" fill="${deep}"/>`
    : '';
  const xs = eyes.xs(32 - body.dx, 32 + body.dx);
  const y = body.eyeY;
  const mouth = SILIP_MOUTHS[mouthIndex]!(body.mouthY);
  const back = `<rect width="64" height="64" fill="${color.hex}"/>`;
  const figure = `${top(body.top, deep)}${bumps}<path d="${body.d}" fill="${deep}"/>${extra(body, color.hex)}`;
  if (!hooks) {
    return back + figure + xs.map((x) => eyes.white(x, y) + eyes.pupil(x, y, deep, glance)).join('') + mouth;
  }
  const whites = xs.map((x) => eyes.white(x, y)).join('');
  const pupils = eyes.pupils
    ? `<g class="bk-av__look"><g class="bk-av__pupils">${xs.map((x) => eyes.pupil(x, y, deep, glance)).join('')}</g></g>`
    : '';
  return (
    back +
    `<g class="bk-av__fig">${figure}<g class="bk-av__eyes">${whites}${pupils}</g>` +
    (mouth ? `<g class="bk-av__mouth">${mouth}</g>` : '') +
    '</g>'
  );
}

/** Build the Silip avatar SVG for a seed. Same seed → same SVG; static, no animation, no ids. */
export function agentAvatarSvg(seed: string, opts: AgentAvatarSvgOptions = {}): string {
  const size = sizeNum(opts.size, 64);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${buildAvatarInner(seed, false)}</svg>`;
}

/**
 * Seeded motion rhythm so a list of avatars never blinks in sync. Derived from its own hash so it never shifts
 * the look. Durations in seconds; delays are negative (start mid-cycle).
 */
export function avatarRhythm(seed: string): {
  blink: number;
  blinkDelay: number;
  glance: number;
  glanceDelay: number;
  dir: 1 | -1;
} {
  const h = hashSeed(`${seed}#motion`);
  const f = (shift: number, span: number) => (((h >>> shift) & 0xff) / 255) * span;
  const blink = Math.round((4.2 + f(0, 3.6)) * 100) / 100; // 4.2–7.8 s
  const glance = Math.round((8 + f(8, 6)) * 100) / 100; // 8–14 s
  return {
    blink,
    blinkDelay: -Math.round(f(16, blink) * 100) / 100,
    glance,
    glanceDelay: -Math.round(f(24, glance) * 100) / 100,
    dir: h & 1 ? 1 : -1,
  };
}
