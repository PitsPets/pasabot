/**
 * @pasabot/safe-net — outbound HTTP with an SSRF guard (ARCHITECTURE.md 8, "SSRF"), webhook HMAC verify, URL policy.
 *
 * safeFetch resolves DNS itself, refuses loopback/private/link-local/CGNAT/ULA/metadata addresses unless the host
 * is in the caller's allowlist, connects to the exact IP it checked (no second lookup, so DNS rebinding cannot swap
 * the address), and re-checks every redirect hop (max 5). Bodies and time are capped.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { SafeNet } from '@pasabot/core';

export class SsrfError extends Error {
  constructor(
    readonly code: 'blocked_address' | 'bad_url' | 'too_many_redirects' | 'too_large' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

import { isBlockedAddress, type Resolver } from './blocked.js';

export { isBlockedAddress, type Resolver } from './blocked.js';

const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })) as { address: string; family: 4 | 6 }[];

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** hostnames (exact, lowercase) that may resolve to private addresses */
  allowHosts?: string[];
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** injectable for tests (DNS rebinding cases) */
  resolver?: Resolver;
}

const stripBrackets = (h: string) => h.replace(/^\[|\]$/g, '');

/** Resolve and vet a URL's host; returns the single IP to connect to. */
export async function vetUrl(
  url: URL,
  o: Pick<SafeFetchOptions, 'allowHosts' | 'resolver'> = {},
): Promise<{ ip: string; family: 4 | 6 }> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SsrfError('bad_url', `scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new SsrfError('bad_url', 'credentials in URLs are not allowed');
  const host = stripBrackets(url.hostname.toLowerCase());
  const allowed = (o.allowHosts ?? []).map((h) => stripBrackets(h.toLowerCase())).includes(host);
  const literal = isIP(host);
  const addrs = literal
    ? [{ address: host, family: literal as 4 | 6 }]
    : await (o.resolver ?? defaultResolver)(host);
  if (addrs.length === 0) throw new SsrfError('bad_url', `no address for ${host}`);
  // every answer must pass, so a mixed public/private answer cannot be used to rebind later
  if (!allowed) {
    for (const a of addrs)
      if (isBlockedAddress(a.address))
        throw new SsrfError('blocked_address', `${host} resolves to a blocked address (${a.address})`);
  }
  return { ip: addrs[0]!.address, family: addrs[0]!.family };
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
function withoutCredentials(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return h;
  return Object.fromEntries(Object.entries(h).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
}

/** fetch() with the SSRF guard. Returns a standard Response (body fully buffered, capped). */
export async function safeFetch(input: string, o: SafeFetchOptions = {}): Promise<Response> {
  const maxRedirects = o.maxRedirects ?? 5;
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = o.timeoutMs ?? 30_000;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError('bad_url', 'invalid URL');
  }
  let method = (o.method ?? 'GET').toUpperCase();
  let body = o.body;
  let sendHeaders = o.headers;
  for (let hop = 0; ; hop++) {
    const { ip, family } = await vetUrl(url, o);
    const res = await requestPinned(url, ip, family, {
      method,
      headers: sendHeaders,
      body,
      timeoutMs,
      signal: o.signal,
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects)
        throw new SsrfError('too_many_redirects', `more than ${maxRedirects} redirects`);
      const next = new URL(res.headers.location, url);
      // credentials never follow a redirect to another origin
      if (next.origin !== url.origin) sendHeaders = withoutCredentials(sendHeaders);
      url = next;
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const buf = await readCapped(res, maxBytes);
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    const nullBody = status === 204 || status === 304 || method === 'HEAD';
    return new Response(nullBody ? null : new Uint8Array(buf), { status, headers });
  }
}

function requestPinned(
  url: URL,
  ip: string,
  family: 4 | 6,
  o: {
    method: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: o.method,
        headers: { ...o.headers, host: url.host },
        servername: isIP(stripBrackets(url.hostname)) ? undefined : url.hostname,
        // connect to the vetted IP only: no second DNS lookup between check and use
        lookup: (_h, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as any)(null, [{ address: ip, family }]);
          else (cb as any)(null, ip, family);
        },
        signal: o.signal,
        timeout: o.timeoutMs,
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(new SsrfError('timeout', 'request timed out')));
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

async function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res) {
    n += (c as Buffer).length;
    if (n > maxBytes) {
      res.destroy();
      throw new SsrfError('too_large', `response larger than ${maxBytes} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Upper bounds a caller of the SafeNet port may ask for (per call). */
export const SAFE_NET_MAX_BYTES = 512 * 1024 * 1024;
export const SAFE_NET_MAX_TIMEOUT_MS = 15 * 60_000;
const clamp = (v: number | undefined, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : undefined;

/** The SafeNet port backed by safeFetch, with an owner-level allowlist merged into every call. */
export function createSafeNet(base: { allowHosts?: string[]; resolver?: Resolver } = {}): SafeNet {
  return {
    async fetch(url, init = {}) {
      const { allowHosts, headers, body, method, signal } = init;
      const maxBytes = clamp(init.maxBytes, SAFE_NET_MAX_BYTES);
      const timeoutMs = clamp(init.timeoutMs, SAFE_NET_MAX_TIMEOUT_MS);
      const h: Record<string, string> = {};
      new Headers(headers).forEach((v, k) => {
        h[k] = v;
      });
      return safeFetch(url, {
        method,
        headers: h,
        body: typeof body === 'string' || body instanceof Uint8Array ? body : undefined,
        signal: signal ?? undefined,
        allowHosts: [...(base.allowHosts ?? []), ...(allowHosts ?? [])],
        resolver: base.resolver,
        ...(maxBytes ? { maxBytes } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    },
  };
}

// ---------- webhook HMAC (ARCHITECTURE 5.3) ----------
export function signWebhook(secret: string | Buffer, ts: string, deliveryId: string, body: string | Buffer) {
  const mac = createHmac('sha256', secret).update(`v1:${ts}:${deliveryId}:`).update(body).digest('hex');
  return `v1=${mac}`;
}
/** Constant-time check of `X-PasaBot-Signature` within a ±windowMs timestamp window. */
export function verifyWebhook(
  secret: string | Buffer,
  h: { ts?: string; deliveryId?: string; signature?: string },
  body: string | Buffer,
  now = Date.now(),
  windowMs = 5 * 60_000,
): boolean {
  if (!h.ts || !h.deliveryId || !h.signature) return false;
  const tsMs = Number(h.ts) * (h.ts.length <= 10 ? 1000 : 1);
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > windowMs) return false;
  const want = Buffer.from(signWebhook(secret, h.ts, h.deliveryId, body));
  const got = Buffer.from(h.signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------- owner-configured local model endpoints (W34, ARCHITECTURE 12) ----------
export {
  classifyLocalModelUrl,
  fetchLocalModel,
  type LocalModelFetchOptions,
  LocalModelRefused,
  type LocalModelScope,
  type LocalModelUrlCheck,
  localScopeOf,
} from './local-model.js';

// ---------- mail protocols over TCP + TLS (W35, ARCHITECTURE 13) ----------
export {
  type SafeConnectOptions,
  type SafeTcpConnection,
  safeConnect,
  TcpRefused,
  type TlsMode,
  vetTcpHost,
} from './tcp.js';
