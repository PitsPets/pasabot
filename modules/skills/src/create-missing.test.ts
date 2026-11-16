/** R7 review: the "write a new ability" form names each empty field itself, so an empty send never reaches the server. */
import { describe, expect, it } from 'vitest';
import { createMissing } from '../web/index.js';

describe('the add-ability form', () => {
  it('lists every empty or blank field in the order they sit, and nothing once all are filled', () => {
    expect(createMissing({ name: '', description: '', instructions: '' })).toEqual([
      'name',
      'description',
      'instructions',
    ]);
    expect(createMissing({ name: '  ', description: 'Use when quoting', instructions: '\n' })).toEqual([
      'name',
      'instructions',
    ]);
    expect(
      createMissing({ name: 'quotes', description: 'Use when quoting', instructions: 'Add VAT.' }),
    ).toEqual([]);
  });
});
