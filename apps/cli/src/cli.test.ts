import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadCommands, main } from './main.js';

describe('cli', () => {
  it('discovers the W0b verbs by glob', async () => {
    const names = [
      ...(await loadCommands(fileURLToPath(new URL('./commands', import.meta.url)))).keys(),
    ].sort();
    // later workstreams add verbs as new files (W20/W21/W22), so only the W0b ones are pinned here
    expect(names).toEqual(
      expect.arrayContaining(['login', 'logout', 'name', 'setup-link', 'status', 'version']),
    );
  });

  it('--version and --help / -h print and exit 0 without calling a server; the product is named PasaBot', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await main(['--version'])).toBe(0);
      expect(out.join('')).toMatch(/^PasaBot \d+\.\d+\.\d+\n$/);
      for (const arg of ['--help', '-h']) {
        out.length = 0;
        expect(await main([arg])).toBe(0);
        expect(out.join('')).toContain('PasaBot command-line tool');
        expect(out.join('')).toContain('usage: pasabot <command>');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
