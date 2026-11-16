import { ulid } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChannelsModule } from '../../../../modules/channels/src/server.js';
import { createWorkflowsModule } from '../../../../modules/workflows/src/server.js';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';

/**
 * "Owner only" routes check the owner role, not who made the resource. That is exact only while a server has one
 * owner, so the database refuses a second one (ARCHITECTURE 3.1 `users`, 7.4).
 */
describe('single owner per server', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await bootTestServer({ modules: [createWorkflowsModule({ tickMs: 0 }), createChannelsModule()] });
  });
  afterAll(() => s.cleanup());

  it('the database refuses a second owner, even disabled, and never via an update', () => {
    const owner = seedUser(s.db, 'owner');
    const insert = (id: string, disabledAt: number | null) =>
      s.db
        .prepare(
          "INSERT INTO users (id, kind, display_name, created_at, disabled_at) VALUES (?, 'owner', 'Two', ?, ?)",
        )
        .run(id, Date.now(), disabledAt);
    expect(() => insert(ulid(), null)).toThrow(/UNIQUE/);
    expect(() => insert(ulid(), Date.now())).toThrow(/UNIQUE/);
    const member = seedUser(s.db, 'member', 'Member');
    expect(() => s.db.prepare("UPDATE users SET kind = 'owner' WHERE id = ?").run(member.id)).toThrow(
      /UNIQUE/,
    );
    // seeding "owner" again is the same owner with a new session
    expect(seedUser(s.db, 'owner').id).toBe(owner.id);
    expect(
      (s.db.prepare("SELECT count(*) AS n FROM users WHERE kind = 'owner'").get() as { n: number }).n,
    ).toBe(1);
  });

  it('owner-only workflow and channel routes refuse members and guests', async () => {
    const member = seedUser(s.db, 'member', 'Member');
    const guest = seedUser(s.db, 'guest', 'Guest');
    const calls: [string, string, unknown?][] = [
      ['POST', '/api/m/workflows/runs/R1/cancel', {}],
      ['POST', '/api/m/workflows/runs/R1/steps/S1/approve', {}],
      ['POST', '/api/m/workflows/runs/R1/steps/S1/reject', {}],
      ['DELETE', '/api/m/channels/bindings/B1'],
      ['POST', '/api/m/channels/bindings/B1/pairing', { acknowledgeRisk: true }],
      ['DELETE', '/api/m/channels/bindings/B1/pairing'],
    ];
    for (const who of [member, guest])
      for (const [method, path, body] of calls) {
        const r = await fetch(`${s.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${who.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
  });
});
