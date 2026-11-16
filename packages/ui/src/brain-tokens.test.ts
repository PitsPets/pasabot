/**
 * Brain tile colours (SPEC "Simplify" 5.1) are tokens with a dark pair: the light block, the phone's dark default and
 * the forced dark theme each define every `--bk-brain-*` colour and the ink, and each pair reads at 4.5:1 or better.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
const IDS = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'local', 'acp'];

function block(start: string): Record<string, string> {
  const i = css.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const body = css.slice(i, css.indexOf('}', i));
  return Object.fromEntries(
    [...body.matchAll(/(--bk-brain-[a-z]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('brain tile tokens', () => {
  it('are defined for light, the phone dark default and the forced dark theme, each pair >= 4.5:1', () => {
    const blocks = {
      light: block(':root {'),
      phoneDark: block(':root:not([data-theme="light"]) {'),
      dark: block(':root[data-theme="dark"] {'),
    };
    for (const [name, b] of Object.entries(blocks)) {
      const ink = b['--bk-brain-ink'];
      expect(ink, `${name} ink`).toBeTruthy();
      for (const id of IDS) {
        const bg = b[`--bk-brain-${id}`];
        expect(bg, `${name} ${id}`).toBeTruthy();
        expect(ratio(bg!, ink!), `${name} ${id}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(blocks.light['--bk-brain-ink']).toBe('#ffffff');
    expect(blocks.dark['--bk-brain-ink']).toBe('#0e1713');
    expect(blocks.dark['--bk-brain-grok']).not.toBe(blocks.light['--bk-brain-grok']);
  });
});
