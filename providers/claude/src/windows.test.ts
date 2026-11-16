/** Windows sign-in hand-over, proven by injecting the platform (no Windows machine needed). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { windowsLoginEnv } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'pb-claude-win-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const login = (expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'refresh-never', expiresAt } });

describe('windowsLoginEnv', () => {
  it('no link (Windows without Developer Mode): hands over only the access token, never the refresh token', () => {
    const clean = join(dir, 'a');
    mkdirSync(clean);
    const env = windowsLoginEnv({ HOME: dir }, clean, 'win32', () => login(Date.now() + 3_600_000));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-123');
    expect(JSON.stringify(env)).not.toContain('refresh-never');
  });
  it('a working link, an expired login, a key already in the env, or another OS: nothing is added', () => {
    const clean = join(dir, 'b');
    mkdirSync(clean);
    const user = join(dir, 'user.json');
    writeFileSync(user, login(Date.now() + 3_600_000));
    symlinkSync(user, join(clean, '.credentials.json'));
    const read = () => login(Date.now() + 3_600_000);
    expect(windowsLoginEnv({}, clean, 'win32', read).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const c2 = join(dir, 'c');
    mkdirSync(c2);
    expect(
      windowsLoginEnv({}, c2, 'win32', () => login(Date.now() - 1)).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
    expect(
      windowsLoginEnv({ ANTHROPIC_API_KEY: 'k' }, c2, 'win32', read).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
    expect(windowsLoginEnv({}, c2, 'linux', read).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(windowsLoginEnv({}, c2, 'win32', () => null).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
