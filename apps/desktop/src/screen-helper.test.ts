import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HELPER_APP_NAME,
  helperAppPath,
  helperHome,
  helperHomeOk,
  helperKeyPath,
  removeHelperKey,
  startScreenHelper,
  writeHelperKey,
} from './screen-helper.js';

describe('Screen Helper hand-off (W16)', () => {
  // the helper trusts only `<user home>/.pasabot`: the tests stand in a scratch user home for it
  const userHome = mkdtempSync(join(tmpdir(), 'pb-desk-'));
  const home = join(userHome, '.pasabot');
  mkdirSync(home, { mode: 0o700 });
  afterAll(() => rmSync(userHome, { recursive: true, force: true }));

  it('writes a fresh 64-hex key per launch, 0600 in a 0700 run folder, and removes it on stop', () => {
    const a = readFileSync(writeHelperKey(home), 'utf8');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(helperKeyPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    const b = readFileSync(writeHelperKey(home), 'utf8');
    expect(b).not.toBe(a);
    removeHelperKey(home);
    expect(() => statSync(helperKeyPath(home))).toThrow();
  });

  it('starts the bundled helper through LaunchServices (open -g -a), never as a child, after the key exists', async () => {
    expect(helperAppPath(null)).toBeNull();
    expect(helperAppPath('/Applications/PasaBot.app', () => false)).toBeNull();
    const app = helperAppPath('/Applications/PasaBot.app', () => true)!;
    expect(app).toBe(`/Applications/PasaBot.app/Contents/Helpers/${HELPER_APP_NAME}`);
    const calls: { cmd: string; args: string[]; keyThere: boolean }[] = [];
    const ok = await startScreenHelper({
      home,
      app,
      userHome: join(home, '..'),
      open: async (cmd, args) => {
        calls.push({ cmd, args, keyThere: readFileSync(helperKeyPath(home), 'utf8').length === 64 });
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { cmd: '/usr/bin/open', args: ['-g', '-a', app, '--args', '--home', home], keyThere: true },
    ]);
    const failed = await startScreenHelper({
      home,
      app,
      userHome: join(home, '..'),
      open: async () => {
        throw new Error('no such app');
      },
      log: () => {},
    });
    expect(failed).toBe(false);
  });

  // security review 2026-11-15: a helper started with an agent's folder as its home would trust the agent's own key
  it('is never started for a data folder other than ~/.pasabot (the helper would refuse it anyway)', async () => {
    expect(helperHome('/Users/x')).toBe('/Users/x/.pasabot');
    expect(helperHomeOk('/Users/x/.pasabot/', '/Users/x')).toBe(true);
    expect(helperHomeOk('/Users/x/.pasabot/workspaces/a', '/Users/x')).toBe(false);
    expect(helperHomeOk('/tmp/other', '/Users/x')).toBe(false);
    const other = mkdtempSync(join(tmpdir(), 'pb-desk-other-'));
    const calls: string[][] = [];
    const logs: string[] = [];
    const ok = await startScreenHelper({
      home: other,
      app: '/Applications/PasaBot.app/Contents/Helpers/x.app',
      userHome,
      open: async (_c, args) => {
        calls.push(args);
      },
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
    expect(logs[0]).toMatch(/standard data folder/);
    rmSync(other, { recursive: true, force: true });
  });
});
