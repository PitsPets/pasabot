/**
 * The one safe-net exception (ARCHITECTURE 12, W34): owner-configured local model endpoints of kind `local-model`.
 *
 * `classifyLocalModelUrl` decides whether a URL may be configured at all: http(s), no credentials, a literal IP or
 * `localhost` (never a DNS name, so nothing can rebind it later), and an address on this machine (loopback) or the
 * local network (private, CGNAT/Tailscale, ULA), the latter with a warning. Public, link-local/metadata, multicast and
 * unspecified addresses are refused.
 *
 * `fetchLocalModel` reaches such an endpoint only when the URL's origin is exactly one of the `allowed` origins the
 * caller passes (the owner's list, kept by the local provider; agents and tools never add to it). It connects to the
 * literal address (localhost = 127.0.0.1), follows no redirects and streams the body (model replies stream), capped.
 * Every request gets its own connection (no keep-alive reuse), so a stale pooled socket never looks like a dead
 * endpoint; a connect that does not finish within `connectTimeoutMs` fails fast with `ETIMEDOUT`.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

export type LocalModelScope = 'loopback' | 'lan';
export type LocalModelUrlCheck =
  | { ok: true; origin: string; baseUrl: string; scope: LocalModelScope; warning?: string }
  | { ok: false; reason: string };

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
const lan = new BlockList();
for (const [net, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // CGNAT, incl. Tailscale
] as const)
  lan.addSubnet(net, prefix, 'ipv4');
lan.addSubnet('fc00::', 7, 'ipv6'); // ULA

const strip = (h: string) => h.replace(/^\[|\]$/g, '').toLowerCase();

/** Where a literal address sits: on this machine, on the local network, or neither (refused). */
export function localScopeOf(ip: string): LocalModelScope | null {
  const fam = isIP(ip);
  if (!fam) return null;
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return localScopeOf(mapped[1]!);
  const type = fam === 4 ? 'ipv4' : 'ipv6';
  if (loopback.check(ip, type)) return 'loopback';
  if (lan.check(ip, type)) return 'lan';
  return null;
}

/** May the owner configure this URL as a local model endpoint? */
export function classifyLocalModelUrl(raw: string): LocalModelUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'only http and https are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in URLs are not allowed' };
  if (url.search || url.hash) return { ok: false, reason: 'no query or fragment' };
  const host = strip(url.hostname);
  const ip = host === 'localhost' ? '127.0.0.1' : host;
  if (!isIP(ip)) return { ok: false, reason: 'use an IP address or localhost, not a host name' };
  const scope = localScopeOf(ip);
  if (!scope) return { ok: false, reason: 'not a loopback or local-network address' };
  const path = url.pathname.replace(/\/+$/, '');
  return {
    ok: true,
    origin: url.origin,
    baseUrl: `${url.origin}${path}`,
    scope,
    ...(scope === 'lan'
      ? {
          warning:
            'This address is on your local network, not this machine: anyone who controls it sees the prompts and can answer as the model.',
        }
      : {}),
  };
}

export class LocalModelRefused extends Error {
  readonly code = 'local_model_refused';
}

export interface LocalModelFetchOptions {
  /** the owner-configured origins (exact `scheme://host:port`) this call may reach */
  allowed: readonly string[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** idle socket timeout once connected (default 120 s: a local model may think a while before its first token);
   * on expiry the request fails with code `ESOCKETTIMEDOUT` (the endpoint answered, then went quiet) */
  timeoutMs?: number;
  /** how long the TCP (and TLS) connect may take (default 5 s); on expiry the request fails with code `ETIMEDOUT`
   * (the endpoint is unreachable: asleep, off the network, black-holed) */
  connectTimeoutMs?: number;
  /** body cap (default 50 MB) */
  maxBytes?: number;
}

/** fetch() for an owner-configured local model endpoint only; the Response body streams. */
export async function fetchLocalModel(input: string, o: LocalModelFetchOptions): Promise<Response> {
  const check = classifyLocalModelUrl(input.replace(/\?.*$/, ''));
  if (!check.ok) throw new LocalModelRefused(`refused: ${check.reason}`);
  const url = new URL(input);
  if (!o.allowed.includes(url.origin))
    throw new LocalModelRefused(`refused: ${url.origin} is not an owner-configured local model endpoint`);
  const host = strip(url.hostname);
  const ip = host === 'localhost' ? '127.0.0.1' : host;
  const family = isIP(ip) as 4 | 6;
  const maxBytes = o.maxBytes ?? 50 * 1024 * 1024;
  const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: (o.method ?? 'GET').toUpperCase(),
        headers: { ...o.headers, host: url.host },
        lookup: (_h, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as any)(null, [{ address: ip, family }]);
          else (cb as any)(null, ip, family);
        },
        signal: o.signal,
        timeout: o.timeoutMs ?? 120_000,
        // a fresh connection per request: a reused keep-alive socket the server already closed would fail with
        // ECONNRESET and read as "unreachable"
        agent: false,
      },
      resolve,
    );
    const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
    const connectMs = o.connectTimeoutMs ?? 5_000;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnect = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const tls = url.protocol === 'https:';
    req.on('socket', (socket) => {
      // over https the connect phase lasts until the TLS handshake is done, even once TCP is up
      if (!socket.connecting && !tls) return;
      connectTimer = setTimeout(
        () =>
          req.destroy(
            coded(`local model endpoint did not accept a connection within ${connectMs} ms`, 'ETIMEDOUT'),
          ),
        connectMs,
      );
      socket.once(tls ? 'secureConnect' : 'connect', clearConnect);
    });
    req.on('close', clearConnect);
    req.on('timeout', () => req.destroy(coded('local model request timed out', 'ESOCKETTIMEDOUT')));
    req.on('error', (e) => {
      clearConnect();
      reject(e);
    });
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    res.resume();
    throw new LocalModelRefused('refused: a local model endpoint may not redirect');
  }
  let n = 0;
  res.on('data', (c: Buffer) => {
    n += c.length;
    if (n > maxBytes) res.destroy(new Error(`response larger than ${maxBytes} bytes`));
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const nullBody = status === 204 || status === 304 || o.method?.toUpperCase() === 'HEAD';
  if (nullBody) res.resume();
  return new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    headers,
  });
}
