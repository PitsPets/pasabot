import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';

/**
 * First run, step 2 ("Meet your first agent"): renaming the agent made in step 1 renames its direct chat too, so the
 * chat she lands in carries the name she picked. A chat someone titled on purpose, and a channel, keep their title.
 */
describe('agent rename', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  const req = (method: string, path: string, body?: unknown) =>
    fetch(`${s.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${owner.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const title = (chatId: string) =>
    (s.db.prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string }).title;
  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    owner = seedUser(s.db, 'owner', 'Owner');
  });
  afterAll(() => s.cleanup());

  it("the agent's direct chat follows a rename; other chats keep their own title", async () => {
    const r = (await (await req('POST', '/api/v1/agents', { name: 'Tala', providerId: 'fake' })).json()) as {
      agent: { id: string };
      chatId: string;
    };
    const id = r.agent.id;
    expect(title(r.chatId)).toBe('Tala');
    // a direct chat with this agent that someone titled on purpose
    s.db.prepare("UPDATE chats SET title = 'Groceries' WHERE id = ?").run(r.chatId);
    const other = (await (
      await req('POST', '/api/v1/agents', { name: 'Tala', providerId: 'fake' })
    ).json()) as { agent: { id: string }; chatId: string };

    expect((await req('PATCH', `/api/v1/agents/${other.agent.id}`, { name: 'Ligaya' })).status).toBe(200);
    expect(title(other.chatId)).toBe('Ligaya');
    // the first agent's chat (titled on purpose) and the first agent are untouched
    expect(title(r.chatId)).toBe('Groceries');
    expect((await req('PATCH', `/api/v1/agents/${id}`, { name: 'Bituin' })).status).toBe(200);
    expect(title(r.chatId)).toBe('Groceries');
    // no name in the patch: nothing renamed
    expect((await req('PATCH', `/api/v1/agents/${other.agent.id}`, { instructions: 'x' })).status).toBe(200);
    expect(title(other.chatId)).toBe('Ligaya');
  });
});
