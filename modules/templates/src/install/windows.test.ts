/** The free starter on Windows, proven by injecting the platform (the real install is checked by selftest.ps1). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBinDir } from '../server.js';
import { ReleaseInstaller, unpackCommand } from './installer.js';

const catalog = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'catalog', 'templates', 'opencode-install.json'),
    'utf8',
  ),
) as { assets: Record<string, string>; binary: string; release: string; hosts: string[] };

describe('free starter on Windows', () => {
  it('the catalog has the Windows builds (x64 and arm64)', () => {
    expect(catalog.assets['win32-x64']).toBe('opencode-windows-x64.zip');
    expect(catalog.assets['win32-arm64']).toBe('opencode-windows-arm64.zip');
  });
  it('unpacks with Windows’ own tar.exe by full path (reads zip; never unzip, never a tar from PATH)', () => {
    expect(
      unpackCommand('win32-x64', 'a.zip', 'C:\\t\\a.zip', 'C:\\t\\x', { SystemRoot: 'C:\\Windows' }),
    ).toEqual(['C:\\Windows\\System32\\tar.exe', ['-xf', 'C:\\t\\a.zip', '-C', 'C:\\t\\x']]);
    expect(unpackCommand('darwin-arm64', 'a.zip', '/t/a.zip', '/t/x')[0]).toBe('unzip');
    expect(unpackCommand('linux-x64', 'a.tar.gz', '/t/a', '/t/x')[0]).toBe('tar');
  });
  it('installs opencode.exe into %LOCALAPPDATA%\\PasaBot\\bin, a folder PasaBot searches for brains', () => {
    expect(
      defaultBinDir('win32', { LOCALAPPDATA: 'C:\\Users\\Peña\\AppData\\Local' }, 'C:\\Users\\Peña'),
    ).toBe('C:\\Users\\Peña\\AppData\\Local\\PasaBot\\bin');
    const i = new ReleaseInstaller({
      source: catalog,
      binDir: 'C:\\Users\\u\\AppData\\Local\\PasaBot\\bin',
      fetch: async () => new Response('{}'),
      platform: 'win32-x64',
    });
    expect(i.describe().where).toBe('C:\\Users\\u\\AppData\\Local\\PasaBot\\bin\\opencode.exe');
  });
});
