/**
 * W36: an MCP server's own sign-in (MCP authorization). From the server's address alone it finds where to sign in,
 * following the published metadata, and registers PasaBot as a client there, so the owner types nothing:
 *   1. RFC 9728 protected-resource metadata (`/.well-known/oauth-protected-resource[/path]`) names the authorization
 *      server and its scopes; a server without it is its own authorization server (MCP 2025-03-26).
 *   2. RFC 8414 authorization-server metadata (`/.well-known/oauth-authorization-server[/path]`, then OpenID's
 *      `openid-configuration`) gives the authorize, token and registration addresses; PKCE S256 must be offered.
 *   3. RFC 7591 dynamic client registration: a public client (no secret) for one return address.
 * Every request goes through safe-net (`allowHosts` from the manifest only), so a metadata file that points at a
 * private, loopback or cloud-metadata address is refused. The pages the owner's browser opens must be https (or a
 * host the manifest allowlists, for local tests). Sizes and times are capped; nothing here logs a body.
 */
import type { SafeNet } from '@pasabot/core';
import { z } from 'zod';

export interface SignInPages {
  authorizeUrl: string;
  tokenUrl: string;
  registrationUrl: string;
  /** the MCP server's address, sent as the RFC 8707 `resource` */
  resource: string;
  scopes: string[];
}

/** why a sign-in could not start, in words the page turns into a plain line */
export class SignInError extends Error {
  constructor(
    /** `insecure`: the app refused a return address that is plain http and not this computer (a phone on the LAN) */
    readonly reason: 'unreachable' | 'no_sign_in' | 'refused' | 'insecure',
    message: string,
  ) {
    super(message);
  }
}

const MAX = 64 * 1024;
const url = z.string().url().max(2000);
const prmSchema = z.object({
  authorization_servers: z.array(url).min(1).max(8).optional(),
  scopes_supported: z.array(z.string().max(300)).max(60).optional(),
});
const asSchema = z.object({
  authorization_endpoint: url,
  token_endpoint: url,
  registration_endpoint: url.optional(),
  code_challenge_methods_supported: z.array(z.string().max(20)).max(10).optional(),
});
const regSchema = z.object({
  client_id: z.string().min(1).max(500),
  client_secret: z.string().min(1).max(2000).optional(),
});

const wellKnown = (base: string, name: string) => {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, '');
  const at = (p: string) => `${u.origin}/.well-known/${name}${p}`;
  return path && path !== '/' ? [at(path), at('')] : [at('')];
};

/** a page the owner's browser opens: https, or a host the manifest allowlists (local tests) */
function browserSafe(u: string, allowHosts: string[]): boolean {
  try {
    const x = new URL(u);
    if (x.username || x.password) return false;
    return x.protocol === 'https:' || (x.protocol === 'http:' && allowHosts.includes(x.hostname));
  } catch {
    return false;
  }
}

async function getJson(net: SafeNet, u: string, allowHosts: string[]): Promise<unknown | null> {
  let res: Response;
  try {
    res = await net.fetch(u, {
      headers: { accept: 'application/json' },
      allowHosts,
      maxBytes: MAX,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // a refused address (private, loopback, metadata) stops the sign-in; a plain miss tries the next place
    const code = (e as { code?: string }).code;
    if (code === 'blocked_address' || code === 'bad_url')
      throw new SignInError('refused', `refused: ${(e as Error).message}`);
    throw new SignInError('unreachable', `could not reach ${new URL(u).host}`);
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** where this MCP server signs in, from its published metadata */
export async function discoverSignIn(
  net: SafeNet,
  mcpUrl: string,
  allowHosts: string[],
  scopes?: string[],
): Promise<SignInPages> {
  let prm: z.infer<typeof prmSchema> | null = null;
  for (const u of wellKnown(mcpUrl, 'oauth-protected-resource')) {
    const p = prmSchema.safeParse(await getJson(net, u, allowHosts));
    if (p.success && p.data.authorization_servers?.length) {
      prm = p.data;
      break;
    }
  }
  const issuer = prm?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  let as: z.infer<typeof asSchema> | null = null;
  for (const u of [
    ...wellKnown(issuer, 'oauth-authorization-server'),
    ...wellKnown(issuer, 'openid-configuration'),
  ]) {
    const p = asSchema.safeParse(await getJson(net, u, allowHosts));
    if (p.success) {
      as = p.data;
      break;
    }
  }
  if (!as) throw new SignInError('no_sign_in', 'the server publishes no sign-in');
  if (!as.registration_endpoint) throw new SignInError('no_sign_in', 'the server takes no new apps');
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256'))
    throw new SignInError('no_sign_in', 'the server does not offer PKCE S256');
  for (const u of [as.authorization_endpoint, as.token_endpoint, as.registration_endpoint])
    if (!browserSafe(u, allowHosts))
      throw new SignInError('refused', `refused: ${new URL(u).host} is not https`);
  return {
    authorizeUrl: as.authorization_endpoint,
    tokenUrl: as.token_endpoint,
    registrationUrl: as.registration_endpoint,
    resource: mcpUrl,
    scopes: scopes ?? prm?.scopes_supported ?? [],
  };
}

/** RFC 7591: register PasaBot as a public client for one return address */
export async function registerClient(
  net: SafeNet,
  pages: SignInPages,
  redirectUri: string,
  allowHosts: string[],
): Promise<{ clientId: string; clientSecret?: string }> {
  let res: Response;
  try {
    res = await net.fetch(pages.registrationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'PasaBot',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(pages.scopes.length ? { scope: pages.scopes.join(' ') } : {}),
      }),
      allowHosts,
      maxBytes: MAX,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new SignInError(
      'unreachable',
      `could not reach ${new URL(pages.registrationUrl).host}: ${String(e)}`,
    );
  }
  if (!res.ok) throw new SignInError('refused', `the server did not accept PasaBot (${res.status})`);
  const p = regSchema.safeParse(await res.json().catch(() => null));
  if (!p.success) throw new SignInError('refused', 'the server gave no client id');
  return {
    clientId: p.data.client_id,
    ...(p.data.client_secret ? { clientSecret: p.data.client_secret } : {}),
  };
}
