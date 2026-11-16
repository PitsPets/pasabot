/**
 * Opt-in live check against a real board speaking the board protocol (README). Skipped unless
 * PASABOT_LIVE includes `agentchat`; reads only (whoami + one inbox position), never posts.
 *   PASABOT_LIVE=agentchat PASABOT_AGENTCHAT_URL=http://… PASABOT_AGENTCHAT_TOKEN=… pnpm vitest run plugins/agentchat-bridge
 */
import { describe, expect, it } from 'vitest';
import { httpBoardClient } from './board.js';

const live = (process.env.PASABOT_LIVE ?? '').split(',').includes('agentchat');

describe.skipIf(!live)('agent board (live)', () => {
  it('signs in and reads the current inbox position', async () => {
    const boardUrl = process.env.PASABOT_AGENTCHAT_URL ?? '';
    const token = process.env.PASABOT_AGENTCHAT_TOKEN ?? '';
    expect(boardUrl && token, 'set PASABOT_AGENTCHAT_URL and PASABOT_AGENTCHAT_TOKEN').toBeTruthy();
    const client = httpBoardClient({ boardUrl, token });
    const signal = AbortSignal.timeout(30_000);
    const me = await client.whoami(signal);
    expect(me.id.length).toBeGreaterThan(0);
    const page = await client.inbox(null, signal);
    expect(typeof page.cursor).toBe('string');
  });
});
