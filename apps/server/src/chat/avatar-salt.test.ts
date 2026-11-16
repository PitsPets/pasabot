import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

/** W29: the generated avatar's re-roll salt (seed = agent id + salt) is part of the agent record; owner-only. */
describe('agent avatar salt', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
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
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    agent = seedAgent(s.db);
    seedChat(s.db, { userIds: [member.id], agentIds: [agent] }); // a member sees the agents of its chats (W23)
  });
  afterAll(() => s.cleanup());

  it('defaults to empty (the original look) and every reader sees it', async () => {
    const own = (await (await req('GET', `/api/v1/agents/${agent}`, owner.token)).json()) as any;
    expect(own.agent.avatarSalt).toBe('');
    const pub = (await (await req('GET', '/api/v1/agents', member.token)).json()) as any;
    expect(pub.agents[0].avatarSalt).toBe('');
  });

  it('the owner changes it; a member cannot; bad salts are refused', async () => {
    const r = await req('PATCH', `/api/v1/agents/${agent}`, owner.token, { avatarSalt: 'k3x9' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).agent.avatarSalt).toBe('k3x9');
    const pub = (await (await req('GET', `/api/v1/agents/${agent}`, member.token)).json()) as any;
    expect(pub.agent.avatarSalt).toBe('k3x9');

    expect((await req('PATCH', `/api/v1/agents/${agent}`, member.token, { avatarSalt: 'mine' })).status).toBe(
      403,
    );
    for (const bad of ['"><script>', 'x'.repeat(33), 'a b'])
      expect((await req('PATCH', `/api/v1/agents/${agent}`, owner.token, { avatarSalt: bad })).status).toBe(
        400,
      );
    const after = (await (await req('GET', `/api/v1/agents/${agent}`, owner.token)).json()) as any;
    expect(after.agent.avatarSalt).toBe('k3x9');

    // back to the original look
    const reset = await req('PATCH', `/api/v1/agents/${agent}`, owner.token, { avatarSalt: '' });
    expect(((await reset.json()) as any).agent.avatarSalt).toBe('');
  });
});
