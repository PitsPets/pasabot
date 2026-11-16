import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexEntrySchema, indexSchema } from './registry.js';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'local-index.json'), 'utf8'),
) as { agents: Record<string, unknown>[] };

describe('registry homepage links', () => {
  it('keeps http(s) and drops every other scheme without losing the entry', () => {
    const base = fixture.agents[0]!;
    expect(indexEntrySchema.parse({ ...base, homepage: 'https://example.test/x' }).homepage).toBe(
      'https://example.test/x',
    );
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
    ]) {
      const e = indexEntrySchema.parse({ ...base, homepage: bad });
      expect(e.homepage, bad).toBeUndefined();
      expect(e.id).toBe(base.id);
    }
    const idx = indexSchema.parse({ version: 1, agents: [{ ...base, homepage: 'javascript:alert(1)' }] });
    expect(idx.agents).toHaveLength(1);
  });
});
