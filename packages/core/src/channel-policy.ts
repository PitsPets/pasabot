/**
 * Channel binding rules (ARCHITECTURE 5.2) as pure functions, so every channel package, the binding runtime
 * and `runChannelContract` apply the same decisions. No storage, no I/O.
 */
import { createHash, randomBytes } from 'node:crypto';
import { minTrust, TRUST_ORDER, type TrustLevel } from '@pasabot/protocol';
import type { ApprovalTier, InboundMessage, PlaceInfo } from './ports.js';
import type { SenderInfo } from './provider.js';

/** `channels_sender.trust`, keyed on the platform's immutable user id (never a display name). */
export type ChannelSenderTrust = 'owner' | TrustLevel;

export interface ChannelPlacePolicy {
  kind: PlaceInfo['kind'];
  /** immutable platform user ids allowed besides the owner; empty = owner only */
  allowedSenders: string[];
}

export type ChannelInboundDecision =
  | { action: 'link'; code: string; externalUserId: string }
  | {
      action: 'burn_link';
      /** `hashChannelLinkCode` of the exposed code; the runtime invalidates it if it is still live */
      codeHash: string;
      audit: { action: 'channel.link_code_exposed'; target: string; data: Record<string, unknown> };
    }
  | { action: 'enqueue'; idemKey: string; sender: SenderInfo }
  | { action: 'ignore'; reason: 'bot' | 'no_mention' | 'empty' }
  | {
      action: 'drop';
      reason: 'stranger';
      audit: { action: 'channel.sender_dropped'; target: string; data: Record<string, unknown> };
    };

/** Owner turns that arrive by channel run at most `standard` (8, "Channel account takeover"). */
export const channelOwnerTrust = (agentTrust: TrustLevel): TrustLevel => minTrust(agentTrust, 'standard');

/** Non-owner channel turns run one level below the owner's channel trust, never below `guarded` (7.1). */
export function channelSenderTurnTrust(agentTrust: TrustLevel, senderTrust: ChannelSenderTrust): TrustLevel {
  const ownerCap = channelOwnerTrust(agentTrust);
  if (senderTrust === 'owner') return ownerCap;
  const capped = minTrust(ownerCap, senderTrust);
  return TRUST_ORDER[Math.max(0, TRUST_ORDER.indexOf(capped) - 1)]!;
}

/** Only the linked owner may answer an approval in a channel, and never a tier-3 one (paired device + re-auth). */
export const channelMayAnswerApproval = (tier: ApprovalTier, senderTrust: ChannelSenderTrust | undefined) =>
  tier < 3 && senderTrust === 'owner';

/** Queue idempotency key; adapters keep `externalId` unique per binding so redelivery dedupes. */
export const channelIdemKey = (bindingId: string, externalId: string) => `channel:${bindingId}:${externalId}`;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A fresh one-time owner link code (10 Crockford chars, shown as XXXXX-XXXXX). Store only its hash. */
export function newChannelLinkCode(): string {
  const b = randomBytes(10);
  const s = Array.from(b, (x) => CROCKFORD[x % 32]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normalizeCode = (c: string) => c.replace(/-/g, '').toUpperCase();
export const hashChannelLinkCode = (code: string) =>
  createHash('sha256')
    .update(`pasabot-channel-link:${normalizeCode(code)}`)
    .digest('hex');

/** `/link CODE` or `/start CODE` (Telegram deep link), optionally `/link@botname CODE`. */
export function parseChannelLinkCode(text: string): string | null {
  const m = /^\/(?:link|start)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{5}-?[A-Za-z0-9]{5})\s*$/.exec(text.trim());
  return m ? normalizeCode(m[1]!) : null;
}

/**
 * A link command anywhere in the text (e.g. after a `<@bot>` mention prefix or with trailing words).
 * Used to spot a code that was posted where others can read it, so it can be burned.
 */
export function findChannelLinkCode(text: string): string | null {
  const m =
    /(?:^|\s)\/(?:link|start)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{5}-?[A-Za-z0-9]{5})(?![A-Za-z0-9])/.exec(
      text,
    );
  return m ? normalizeCode(m[1]!) : null;
}

export interface ChannelInboundInput {
  bindingId: string;
  msg: InboundMessage;
  place: ChannelPlacePolicy;
  /** lookup by the immutable platform user id only */
  senderTrust: (externalUserId: string) => ChannelSenderTrust | undefined;
  agentTrust: TrustLevel;
}

/**
 * What the binding runtime does with one inbound message. Order matters:
 * a link code posted outside a DM (by anyone, mention or not) is exposed, so it is burned + audited and the
 * text never becomes a turn; bots are ignored; a link command is honoured only in a DM; group chatter without
 * a mention is ignored before the stranger check (so a busy group does not flood the audit log); strangers
 * are dropped + audited.
 */
export function decideChannelInbound(i: ChannelInboundInput): ChannelInboundDecision {
  const { msg, place } = i;
  if (place.kind !== 'dm') {
    const exposed = findChannelLinkCode(msg.text);
    if (exposed)
      return {
        action: 'burn_link',
        codeHash: hashChannelLinkCode(exposed),
        audit: {
          action: 'channel.link_code_exposed',
          target: `${i.bindingId}:${msg.placeId}`,
          data: { externalUserId: msg.sender.externalId, messageId: msg.externalId },
        },
      };
  }
  if (msg.sender.isBot) return { action: 'ignore', reason: 'bot' };
  if (place.kind === 'dm') {
    const code = parseChannelLinkCode(msg.text);
    if (code) return { action: 'link', code, externalUserId: msg.sender.externalId };
  }
  if (place.kind !== 'dm' && !msg.mentionsBot) return { action: 'ignore', reason: 'no_mention' };
  const known = i.senderTrust(msg.sender.externalId);
  const allowed = known === 'owner' || place.allowedSenders.includes(msg.sender.externalId);
  if (!allowed)
    return {
      action: 'drop',
      reason: 'stranger',
      audit: {
        action: 'channel.sender_dropped',
        target: `${i.bindingId}:${msg.placeId}`,
        data: { externalUserId: msg.sender.externalId, name: msg.sender.name, messageId: msg.externalId },
      },
    };
  if (!msg.text.trim() && msg.attachments.length === 0) return { action: 'ignore', reason: 'empty' };
  const senderTrust: ChannelSenderTrust = known ?? 'standard';
  return {
    action: 'enqueue',
    idemKey: channelIdemKey(i.bindingId, msg.externalId),
    sender: {
      kind: senderTrust === 'owner' ? 'owner' : 'external',
      id: msg.sender.externalId,
      name: msg.sender.name,
      trust: channelSenderTurnTrust(i.agentTrust, senderTrust),
    },
  };
}
