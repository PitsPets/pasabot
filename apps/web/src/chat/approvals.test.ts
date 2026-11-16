import { askFromArgs, callFacts } from '@pasabot/core';
import type { ApprovalDTO } from '@pasabot/protocol';
import { describe, expect, it } from 'vitest';
import { askView, PLAIN_ARGS_MAX, plainArgs } from './approvals.js';

/** a t() that shows the key and its params, so the test reads which message the card picked */
const t = ((key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key)) as never;

/** an always-ask card the way the gateway builds it: the summary facts, then the tool and the full arguments */
function card(cls: 'money' | 'outbound-message', tool: string, args: Record<string, unknown>): ApprovalDTO {
  const ask = askFromArgs(cls, args);
  return {
    id: 'ap1',
    tier: 2,
    state: 'pending',
    tool,
    action: { tool, input: args },
    ask: { ...ask, fields: [...ask.fields, ...callFacts(tool, args)] },
  } as unknown as ApprovalDTO;
}

const factValue = (v: ReturnType<typeof askView>, label: string) =>
  v?.facts.find((f) => f.label === label)?.value;

describe('plain always-ask card (Advanced off)', () => {
  it('a bcc hidden next to the recipient is on the card', () => {
    const v = askView(
      t,
      card('outbound-message', 'mail/send', {
        envelope: { to: 'boss@family.example', bcc: 'attacker@evil.example' },
        text: 'Payroll attached',
      }),
      false,
    );
    expect(factValue(v, 'approval.fact.request')).toContain('envelope › bcc: attacker@evil.example');
    expect(v?.warning).toContain('approval.unshownShown');
  });
  it('a second payee hidden in the payment object is on the card', () => {
    const v = askView(
      t,
      card('money', 'shop/pay', {
        payment: { merchant: 'Jollibee', total: 150, splits: [{ to: 'acct-999', amount: 9000 }] },
      }),
      false,
    );
    expect(factValue(v, 'approval.fact.request')).toContain('payment › splits 1 › to: acct-999');
  });
  it('a request cut at the cap says how much it left out and to turn on Advanced', () => {
    const args: Record<string, string> = {};
    for (let n = 0; n < 45; n++) args[String(n)] = 'x';
    args.recipient_handle = 'attacker';
    args.to = 'boss@family.example';
    args.text = 'hi';
    const v = askView(t, card('outbound-message', 'mail/send', args), false);
    const request = factValue(v, 'approval.fact.request') ?? '';
    // 45 padding lines and the handle are unread (48 lines in all): the card cannot list them all, so it says how many it left
    // out and sends the owner to Advanced instead of claiming the details are shown
    expect(request.split(' · ')).toHaveLength(PLAIN_ARGS_MAX + 1);
    expect(request).toMatch(/· \+8$/);
    expect(v?.warning).toContain('approval.unshownPlain');
    expect(v?.warning).not.toContain('approval.unshownShown');
  });
});

describe('plainArgs', () => {
  it('names how many lines it left out', () => {
    const o: Record<string, number> = {};
    for (let n = 0; n < PLAIN_ARGS_MAX + 5; n++) o[`k${n}`] = n;
    const r = plainArgs(JSON.stringify(o));
    expect(r?.more).toBe(5);
    expect(r?.text.endsWith(' · +5')).toBe(true);
  });
  it('read arguments never push an unread one past the cap', () => {
    const o: Record<string, unknown> = { items: Array.from({ length: 60 }, (_, n) => ({ sku: n })) };
    o.recipient_handle = 'attacker';
    const r = plainArgs(JSON.stringify(o), ['recipient_handle']);
    expect(r?.text.startsWith('recipient_handle: attacker · ')).toBe(true);
    expect(r?.more).toBe(21);
  });
  it('lists the unread arguments first', () => {
    const r = plainArgs(JSON.stringify({ a: 1, b: { c: 2, d: 3 }, e: [{ f: 4 }] }), ['b › d', 'e']);
    expect(r).toEqual({ text: 'b › d: 3 · e 1 › f: 4 · a: 1 · b › c: 2', more: 0 });
  });
});
