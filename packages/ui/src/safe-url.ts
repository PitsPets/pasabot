/**
 * The one gate for URLs that come from data into an `href` or `src` (registry homepages, HTML-block frames,
 * channel QR images, anything an agent, channel or connector supplied). Anything else — `javascript:`, `data:`
 * (except the image types `safeImageSrc` allows), `vbscript:`, `file:`, protocol-relative `//host`, garbage —
 * is refused, and the caller renders plain text or nothing instead.
 */

const HTTP = new Set(['http:', 'https:']);
/** C0 control characters or DEL anywhere (`java\tscript:` and friends). */
const hasControl = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

/** An absolute http(s) URL, normalised; undefined for anything else. For `<a href>` and `<iframe src>`. */
export function safeHref(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined;
  // control characters and whitespace inside a scheme are how `java\tscript:` slips past naive checks
  if (hasControl(raw)) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  return HTTP.has(u.protocol) && u.hostname ? u.href : undefined;
}

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(;charset=[\w-]+)?(;base64)?,/i;

/**
 * For `<img src>` only: what `safeHref` allows, plus `data:` images (an `<img>` never runs scripts, SVG included)
 * and same-origin absolute paths (`/api/...`, never `//host`).
 */
export function safeImageSrc(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2_000_000) return undefined;
  if (IMAGE_DATA.test(raw)) return raw;
  if (/^\/(?![/\\])/.test(raw) && !hasControl(raw)) return raw;
  return safeHref(raw);
}
