import { describe, expect, it } from 'vitest';
import { looksSignedOut } from './provider.js';

describe('looksSignedOut', () => {
  it("reads a CLI's own signed-out line as such", () => {
    for (const t of [
      'Not logged in · Please run /login', // Claude Code 2.1.321, as seen on macOS inside the old sandbox
      'Not logged in. Please run /login',
      'Error: not signed in',
      "You're not logged in.",
      'Please run /login',
      'Invalid API key · Please run /login',
      'Authentication failed',
      '  Unauthorized  ',
    ])
      expect(looksSignedOut(t), t).toBe(true);
  });
  it('never mistakes an answer for one', () => {
    for (const t of [
      'ready',
      '',
      'The site says you are not logged in, so I could not read the page.',
      'To fix it, open Terminal and type claude, then sign in.',
      `Not logged in ${'x'.repeat(220)}`,
    ])
      expect(looksSignedOut(t), t).toBe(false);
  });
});
