/**
 * Mints the per-action grants the Screen Helper insists on. Only server code that runs AFTER the owner said yes
 * calls `issue`: a tier-3 tool handler (the gateway runs it only once the owner approved that card with re-auth),
 * the owner's own take-over and "Try it" routes (an owner session), and the frame route of the owner's live view.
 * Module code has no other way to obtain one, and an agent never sees the key.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkPrivate } from './client.js';
import { GRANT_TTL_MS, type Grant, parseKey, signGrant, type WireRequest } from './protocol.js';

export type Authorize = (r: WireRequest) => Grant;

export class GrantIssuer {
  constructor(
    private readonly keyPath: string,
    private readonly now: () => number = Date.now,
  ) {}
  /** the key is read for every grant: the launcher writes a new one each time PasaBot starts */
  issue(r: WireRequest): Grant {
    checkPrivate(this.keyPath, 'file');
    const key = parseKey(readFileSync(this.keyPath, 'utf8'));
    return signGrant(key, `g-${randomBytes(12).toString('hex')}`, this.now() + GRANT_TTL_MS, r);
  }
}
