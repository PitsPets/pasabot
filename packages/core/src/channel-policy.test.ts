import { describe, expect, it } from 'vitest';
import {
  channelOwnerTrust,
  channelSenderTurnTrust,
  decideChannelInbound,
  hashChannelLinkCode,
  newChannelLinkCode,
  parseChannelLinkCode,
} from './channel-policy.js';
import type { InboundMessage } from './ports.js';

const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({
  externalId: 'm1',
  placeId: 'p1',
  sender: { externalId: 'u1', name: 'Dee', isBot: false },
  text: 'hi',
  attachments: [],
  mentionsBot: true,
  at: 0,
  ...o,
});

describe('channel policy', () => {
  it('caps owner trust at standard and lowers non-owner senders one level', () => {
    expect(channelOwnerTrust('trusted')).toBe('standard');
    expect(channelOwnerTrust('guarded')).toBe('guarded');
    expect(channelSenderTurnTrust('trusted', 'trusted')).toBe('guarded');
    expect(channelSenderTurnTrust('trusted', 'owner')).toBe('standard');
    expect(channelSenderTurnTrust('guarded', 'standard')).toBe('guarded');
  });
  it('link codes round-trip through parse + hash, ignoring dashes and case', () => {
    const c = newChannelLinkCode();
    expect(c).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(hashChannelLinkCode(parseChannelLinkCode(`/link ${c.toLowerCase()}`)!)).toBe(
      hashChannelLinkCode(c),
    );
    expect(parseChannelLinkCode(`/start@pasabot_bot ${c.replace('-', '')}`)).toBe(c.replace('-', ''));
    expect(parseChannelLinkCode(c)).toBeNull();
    expect(parseChannelLinkCode(`/link ${c} extra`)).toBeNull();
  });
  it('a link code posted in a group is burned + audited, never linked or enqueued', () => {
    const code = newChannelLinkCode();
    const decide = (text: string, o: Partial<InboundMessage> = {}) =>
      decideChannelInbound({
        bindingId: 'b',
        msg: msg({ text, ...o }),
        place: { kind: 'group', allowedSenders: [] },
        senderTrust: () => 'owner',
        agentTrust: 'standard',
      });
    for (const text of [
      `/link ${code}`,
      `/link@pasabot_bot ${code}`,
      `/start ${code.replace('-', '')}`,
      `<@123> /link ${code.toLowerCase()} please`,
    ]) {
      for (const mentionsBot of [true, false]) {
        const d = decide(text, { mentionsBot });
        expect(d).toEqual({
          action: 'burn_link',
          codeHash: hashChannelLinkCode(code),
          audit: {
            action: 'channel.link_code_exposed',
            target: 'b:p1',
            data: { externalUserId: 'u1', messageId: 'm1' },
          },
        });
        expect(JSON.stringify(d)).not.toContain(code.replace('-', ''));
      }
    }
    // another bot repeating the code exposes it too
    expect(decide(`/link ${code}`, { sender: { externalId: 'b9', name: 'x', isBot: true } }).action).toBe(
      'burn_link',
    );
    // a plain mention without a code is still an ordinary owner turn
    expect(decide('hello /linked list').action).toBe('enqueue');
  });
  it('a link command in a DM still links', () => {
    const code = newChannelLinkCode();
    const d = decideChannelInbound({
      bindingId: 'b',
      msg: msg({ text: `/link ${code}` }),
      place: { kind: 'dm', allowedSenders: [] },
      senderTrust: () => undefined,
      agentTrust: 'standard',
    });
    expect(d).toMatchObject({ action: 'link', externalUserId: 'u1' });
  });
  it('allowed senders run one level lower and an empty message is ignored', () => {
    const base = {
      bindingId: 'b',
      place: { kind: 'group' as const, allowedSenders: ['u1'] },
      senderTrust: () => undefined,
      agentTrust: 'trusted' as const,
    };
    const d = decideChannelInbound({ ...base, msg: msg() });
    expect(d).toMatchObject({ action: 'enqueue', sender: { kind: 'external', trust: 'guarded' } });
    expect(decideChannelInbound({ ...base, msg: msg({ text: '  ' }) })).toEqual({
      action: 'ignore',
      reason: 'empty',
    });
  });
});
