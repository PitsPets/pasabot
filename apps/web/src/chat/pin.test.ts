/** The team builder's chat is pinned first in the chat list, whatever the activity order or a search. */
import { describe, expect, it } from 'vitest';
import { isPinnedChat, pinFirst } from './pin.js';

type C = { id: string; kind: 'direct' | 'channel'; agent: string; settings: Record<string, unknown> };
const chat = (
  id: string,
  agent: string,
  kind: C['kind'] = 'direct',
  settings: Record<string, unknown> = {},
): C => ({
  id,
  kind,
  agent,
  settings,
});
const ids = (cs: C[]) => cs.map((c) => c.id);
const pin = (builder: string | null) => (c: C) => isPinnedChat(c, c.agent, builder);

describe('the pinned team builder', () => {
  // the activity order (someone waiting, then the newest) as sortedChats gives it: the builder's chat is last
  const byActivity = [chat('ligaya', 'a-ligaya'), chat('dalisay', 'a-dalisay'), chat('tala', 'a-tala')];

  it('puts the team builder first, whatever the activity order', () => {
    expect(ids(pinFirst(byActivity, pin('a-tala')))).toEqual(['tala', 'ligaya', 'dalisay']);
  });
  it('keeps everyone else in their order (stable)', () => {
    const many = [
      chat('c1', 'x1'),
      chat('c2', 'x2'),
      chat('tala', 'a-tala'),
      chat('c3', 'x3'),
      chat('c4', 'x4'),
    ];
    expect(ids(pinFirst(many, pin('a-tala')))).toEqual(['tala', 'c1', 'c2', 'c3', 'c4']);
  });
  it('stays first after a search (the search only filters the pinned order)', () => {
    const list = pinFirst(byActivity, pin('a-tala'));
    expect(ids(list.filter((c) => c.id.includes('a')))).toEqual(['tala', 'ligaya', 'dalisay']);
    expect(ids(list.filter((c) => c.id !== 'ligaya'))[0]).toBe('tala');
  });
  it('pins nothing without a team builder (a member, or no team builder module)', () => {
    expect(ids(pinFirst(byActivity, pin(null)))).toEqual(['ligaya', 'dalisay', 'tala']);
  });
  it("pins only the builder's own chat: never a group chat or a helpers' conversation (Team talk)", () => {
    expect(isPinnedChat(chat('g', 'a-tala', 'channel'), 'a-tala', 'a-tala')).toBe(false);
    expect(isPinnedChat(chat('t', 'a-tala', 'direct', { collabFrom: 'a-ligaya' }), 'a-tala', 'a-tala')).toBe(
      false,
    );
    expect(isPinnedChat(chat('tala', 'a-tala'), 'a-tala', 'a-tala')).toBe(true);
    expect(isPinnedChat(chat('l', 'a-ligaya'), 'a-ligaya', 'a-tala')).toBe(false);
  });
});
