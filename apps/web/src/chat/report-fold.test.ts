/** A report's "Show the full answer" fold: only when it shows something the report's own words do not (ws/threads review). */
import { describe, expect, it } from 'vitest';
import { foldAddsSomething } from './report-fold.js';

interface ReportItem {
  taskId: string;
  agentId: string;
  state: string;
  answer: string;
  chatId: string | null;
  messageId: string | null;
  blocks: unknown[];
}

const item = (o: Partial<ReportItem>): ReportItem => ({
  taskId: 't1',
  agentId: 'a1',
  state: 'done',
  answer: '',
  chatId: 'c1',
  messageId: 'm1',
  blocks: [],
  ...o,
});

describe('foldAddsSomething', () => {
  it('a helper that failed with no answer: nothing to fold (the report already says it)', () => {
    expect(foldAddsSomething([item({ state: 'failed' })], 'Tala couldn’t finish.')).toBe(false);
  });
  it('one helper’s short answer: the report says it, no fold', () => {
    expect(foldAddsSomething([item({ answer: 'Twelve pens.' })], 'Sabi ni Ligaya: labindalawa.')).toBe(false);
  });
  it('every answer already in the report word for word: no fold', () => {
    const items = [item({ answer: 'twelve pens' }), item({ taskId: 't2', answer: 'three\nreams' })];
    expect(foldAddsSomething(items, 'Ligaya: twelve pens. Tala: three reams.')).toBe(false);
  });
  it('a long answer, several answers the report only sums up, or files: the fold stays', () => {
    expect(foldAddsSomething([item({ answer: 'x'.repeat(400) })], 'Ligaya found a lot.')).toBe(true);
    const two = [item({ answer: 'twelve pens' }), item({ taskId: 't2', answer: 'three reams' })];
    expect(foldAddsSomething(two, 'Both answered.')).toBe(true);
    const file = item({
      answer: 'Here it is.',
      blocks: [{ kind: 'richchat.files', v: 1, data: {} }] as never,
    });
    expect(foldAddsSomething([file], 'Here it is.')).toBe(true);
  });
});
