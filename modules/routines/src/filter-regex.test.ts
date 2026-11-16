import { describe, expect, it } from 'vitest';
import { checkLogic } from './jsonlogic.js';

/**
 * Regex audit (review finding on `matches`): routine event filters are a small JsonLogic subset with no pattern
 * operator, so no agent- or user-supplied regular expression ever runs from a routine. A filter asking for one is
 * refused at save time.
 */
describe('routine filters run no user regex', () => {
  it('pattern-like operators are refused at save time', () => {
    for (const op of ['match', 'matches', 'regex', 'search', 'like'])
      expect(() => checkLogic({ [op]: [{ var: 'text' }, '(a+)+$'] } as never), op).toThrow(/unsupported/);
    expect(() => checkLogic({ '==': [{ var: 'text' }, 'ok'] } as never)).not.toThrow();
  });
});
