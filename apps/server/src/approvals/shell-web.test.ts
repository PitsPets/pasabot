/**
 * 7.1 owner decision: an agent given a terminal can do anything a terminal can, so each agent has "Ask before terminal
 * and raw web commands": off by default at `trusted` (the permissive default stays), on by default below it, and the
 * owner may set it either way. When on, a provider CLI's shell or raw web/HTTP tool asks every time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { asksBeforeShellWeb, cliToolAutoApproves, isShellOrRawWebTool } from './index.js';

const owner = { kind: 'owner', id: 'u1', name: 'Owner', trust: 'trusted' } as const;

describe('ask before terminal and raw web commands', () => {
  it('names the terminal and raw web tools of the provider CLIs, never gateway (mcp__) tools or file tools', () => {
    for (const t of [
      'Bash',
      'BashOutput',
      'shell',
      'exec_command',
      'run_shell_command',
      'WebFetch',
      'web_fetch',
    ])
      expect(isShellOrRawWebTool(t), t).toBe(true);
    for (const t of [
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'TodoWrite',
      'mcp__pasabot__tools_invoke',
      'mcp__x__bash',
    ])
      expect(isShellOrRawWebTool(t), t).toBe(false);
  });

  it('defaults: off at trusted, on at standard and guarded; the owner choice wins either way', () => {
    expect(asksBeforeShellWeb({ trustLevel: 'trusted' })).toBe(false);
    expect(asksBeforeShellWeb({ trustLevel: 'trusted', askShellWeb: null })).toBe(false);
    expect(asksBeforeShellWeb({ trustLevel: 'standard' })).toBe(true);
    expect(asksBeforeShellWeb({ trustLevel: 'guarded' })).toBe(true);
    expect(asksBeforeShellWeb({ trustLevel: 'trusted', askShellWeb: true })).toBe(true);
    expect(asksBeforeShellWeb({ trustLevel: 'standard', askShellWeb: false })).toBe(false);
  });

  it('a trusted agent on an owner turn: Bash runs as before by default, asks once the toggle is on', () => {
    expect(cliToolAutoApproves('Bash', 2, { trustLevel: 'trusted' }, owner)).toBe(true);
    expect(cliToolAutoApproves('WebFetch', 2, { trustLevel: 'trusted' }, owner)).toBe(true);
    expect(cliToolAutoApproves('Bash', 2, { trustLevel: 'trusted', askShellWeb: true }, owner)).toBe(false);
    expect(cliToolAutoApproves('WebFetch', 2, { trustLevel: 'trusted', askShellWeb: true }, owner)).toBe(
      false,
    );
    // other tools are untouched by the toggle; turning it off never makes a tier 3 call or a stranger's turn auto
    expect(cliToolAutoApproves('Write', 1, { trustLevel: 'trusted', askShellWeb: true }, owner)).toBe(true);
    expect(cliToolAutoApproves('Bash', 3, { trustLevel: 'trusted', askShellWeb: false }, owner)).toBe(false);
    expect(
      cliToolAutoApproves('Bash', 2, { trustLevel: 'trusted', askShellWeb: false }, {
        kind: 'external',
        trust: 'standard',
      } as never),
    ).toBe(false);
  });
});

describe('the per-agent toggle over REST (owner session only)', () => {
  let s: TestServer;
  let ownerUser: { id: string; token: string };
  let member: { id: string; token: string };
  let agent: string;
  const req = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${s.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  beforeAll(async () => {
    s = await bootTestServer();
    ownerUser = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    agent = seedAgent(s.db, { trust: 'trusted' });
  });
  afterAll(() => s.cleanup());

  it('starts at the trust default (null), the owner sets and resets it, a member cannot', async () => {
    const get = async () =>
      ((await (await req('GET', `/api/v1/agents/${agent}`, ownerUser.token)).json()) as any).agent
        .askShellWeb;
    expect(await get()).toBeNull();
    const on = await req('PATCH', `/api/v1/agents/${agent}`, ownerUser.token, { askShellWeb: true });
    expect(on.status).toBe(200);
    expect(await get()).toBe(true);
    expect((await req('PATCH', `/api/v1/agents/${agent}`, member.token, { askShellWeb: false })).status).toBe(
      403,
    );
    expect(await get()).toBe(true);
    expect(
      (await req('PATCH', `/api/v1/agents/${agent}`, ownerUser.token, { askShellWeb: 'yes' })).status,
    ).toBe(400);
    await req('PATCH', `/api/v1/agents/${agent}`, ownerUser.token, { askShellWeb: null });
    expect(await get()).toBeNull();
  });
});
