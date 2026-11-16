/** What an agent's "What it does" line is made of: its job, never a model call and never the whole instructions. */
import { describe, expect, it } from 'vitest';
import { jobSummary } from './agent-view.js';

describe('jobSummary', () => {
  it('is the first paragraph (the job), not the rest of the instructions', () => {
    expect(
      jobSummary(
        'Handles orders and customer questions for your shop.\n\nReply in the language the person writes in. Keep answers short.',
      ),
    ).toBe('Handles orders and customer questions for your shop.');
  });
  it('keeps at most two sentences and drops markdown marks', () => {
    expect(jobSummary('## Role\n\n**You help** with `money`. You track costs. You never pay. Ever.')).toBe(
      'You help with money. You track costs.',
    );
    expect(jobSummary('**You help** with `money`. You track costs. You never pay.')).toBe(
      'You help with money. You track costs.',
    );
    expect(jobSummary('- Plans meals\n- Sends reminders')).toBe('Plans meals Sends reminders');
  });
  it('is cut at a word under 160 characters', () => {
    const s = jobSummary(`${'word '.repeat(80)}end.`);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/ …$/);
  });
  it('is the same every time, and empty for no instructions', () => {
    const x = 'Drafts messages, keeps notes and tracks your to-dos.';
    expect(jobSummary(x)).toBe(jobSummary(x));
    expect(jobSummary('')).toBe('');
    expect(jobSummary('  \n\n ')).toBe('');
  });
});
