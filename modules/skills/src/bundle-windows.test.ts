/** Skill bundles move between machines: names Windows cannot write are refused on every platform. */
import { describe, expect, it } from 'vitest';
import { caseClash, validateFiles, validPath } from './bundle.js';

const skill = Buffer.from('---\nname: demo\ndescription: d\n---\nbody\n');

describe('Windows-safe skill files', () => {
  it('refuses device names (CON, NUL, COM1, LPT1, also with an extension) and a trailing dot', () => {
    for (const p of ['CON', 'nul.txt', 'docs/aux.md', 'COM1', 'lpt9.log', 'notes.'])
      expect(validPath(p)).toBe(false);
    for (const p of ['console.md', 'nullable.txt', 'docs/com10.md', 'auxiliary.md'])
      expect(validPath(p)).toBe(true);
  });
  it('refuses two paths that differ only in capitals, folders included', () => {
    expect(caseClash(['README.md', 'readme.md'])).toBe('readme.md');
    expect(caseClash(['a/x.md', 'b/x.md'])).toBeNull();
    const files = new Map([
      ['SKILL.md', skill],
      ['ref/a.md', Buffer.from('a')],
      ['Ref/b.md', Buffer.from('b')],
    ]);
    expect(() => validateFiles(files)).toThrow(/capitals/);
  });
});
