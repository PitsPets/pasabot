/**
 * Update check: OFF by default. When the person turns it on, the app reads ONE static JSON file over https through
 * safe-net (`{ "version": "x.y.z", "page": "https://..." }`), sends nothing about the machine or the person, and
 * only tells them a newer version exists. It never downloads or installs anything; the person opens the page.
 */
import { type SafeFetchOptions, safeFetch } from '@pasabot/safe-net';

export type Fetcher = (url: string, o?: SafeFetchOptions) => Promise<Response>;

export interface UpdateInfo {
  version: string;
  page: string | null;
}

export type UpdateResult =
  | { status: 'available'; info: UpdateInfo }
  | { status: 'current' }
  | { status: 'off' }
  | { status: 'no-source' }
  | { status: 'failed'; reason: string };

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,32}))?$/;

/** semver order (numeric core, a pre-release sorts before its release); null when either is not a version */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  return x[4] < y[4] ? -1 : 1;
}

export const UPDATE_FETCH: Readonly<SafeFetchOptions> = Object.freeze({
  method: 'GET',
  headers: { accept: 'application/json' },
  maxRedirects: 3,
  maxBytes: 64 * 1024,
  timeoutMs: 10_000,
});

export async function checkForUpdate(o: {
  enabled: boolean;
  current: string;
  url: string | null;
  fetcher?: Fetcher;
}): Promise<UpdateResult> {
  if (!o.enabled) return { status: 'off' };
  if (!o.url) return { status: 'no-source' };
  if (!o.url.startsWith('https://')) return { status: 'failed', reason: 'the update source must be https' };
  let body: unknown;
  try {
    const res = await (o.fetcher ?? safeFetch)(o.url, { ...UPDATE_FETCH });
    if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };
    body = JSON.parse(await res.text());
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
  const b = (body && typeof body === 'object' ? body : {}) as { version?: unknown; page?: unknown };
  if (typeof b.version !== 'string') return { status: 'failed', reason: 'the release file has no version' };
  const cmp = compareVersions(b.version, o.current);
  if (cmp === null) return { status: 'failed', reason: 'the release file has a bad version' };
  if (cmp <= 0) return { status: 'current' };
  let page: string | null = null;
  if (typeof b.page === 'string') {
    try {
      const u = new URL(b.page);
      if (u.protocol === 'https:' && !u.username && !u.password) page = u.toString();
    } catch {
      // not a URL: no page to offer
    }
  }
  return { status: 'available', info: { version: b.version, page } };
}
