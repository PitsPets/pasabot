/**
 * `capturePage` under tsx (how the e2e and dev servers run): tsx compiles with esbuild's keepNames, so a compiled
 * function with named inner functions reaches the page as `__name(...)` calls and fails there with "__name is not
 * defined". Every script capturePage hands to Playwright must be free of bundler helpers.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const intent = fileURLToPath(new URL('./intent.ts', import.meta.url));

const script = `
const { capturePage } = await import(${JSON.stringify(intent)});
const seen = [];
const record = (f) => { seen.push({ kind: typeof f, src: String(f) }); };
const main = {};
const frame = {
  evaluate: async (f) => { record(f); return [{ name: 'card', id: '', type: '', autocomplete: '', placeholder: '', label: '', tag: 'input', hidden: false }]; },
  frameElement: async () => ({ isVisible: async () => false }),
};
const page = {
  evaluate: async (f) => { record(f); return { url: 'https://shop.example.test/p/1', fields: [], total: '' }; },
  frames: () => [main, frame],
  mainFrame: () => main,
};
const target = { count: async () => 1, first: () => ({ evaluate: async (f) => { record(f); return { label: 'Add to cart', attrs: '', form: 0 }; } }) };
const cap = await capturePage(page, target);
process.stdout.write(JSON.stringify({ seen, cap }));
`;

describe('capturePage under tsx', () => {
  it('hands Playwright scripts without bundler helpers (no __name), and a hidden frame’s fields are hidden', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--conditions=source', '--input-type=module', '-e', script],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      seen: { kind: string; src: string }[];
      cap: { fields: { hidden?: boolean; frame?: boolean }[]; target: unknown };
    };
    expect(out.seen).toHaveLength(3);
    for (const s of out.seen) {
      expect(s.src).not.toContain('__name');
      // each script is valid page JavaScript on its own
      expect(() => new Function(`return (${s.src});`)).not.toThrow();
    }
    expect(out.cap.fields).toEqual([expect.objectContaining({ frame: true, hidden: true })]);
    expect(out.cap.target).toEqual({ label: 'Add to cart', attrs: '', form: 0 });
  });
});
