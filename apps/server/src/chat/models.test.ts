import type { ModelInfo, ProviderAdapter } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  FakeProvider,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

/** The agent form's model picker reads `GET /api/v1/providers/:id/models` (Simplify: model picker). */
describe('provider model list', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let calls = 0;
  let fail = false;
  const listed: ProviderAdapter = Object.assign(Object.create(FakeProvider.prototype), new FakeProvider(), {
    id: 'listed',
    displayName: 'Listed',
    async listModels(): Promise<ModelInfo[]> {
      calls++;
      if (fail) throw new Error('cli exploded');
      return [
        { id: 'a', label: 'A', hint: 'fast', recommended: true },
        { id: 'b', hint: 'smartest', curated: true },
      ];
    },
  });
  const unlisted: ProviderAdapter = Object.assign(Object.create(FakeProvider.prototype), new FakeProvider(), {
    id: 'unlisted',
    displayName: 'Unlisted',
    listModels: undefined,
  });
  const get = (path: string, token: string) =>
    fetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  beforeAll(async () => {
    s = await bootTestServer({ providers: [listed, unlisted] });
    owner = seedUser(s.db, 'owner', 'PitsPets');
    member = seedUser(s.db, 'member', 'Member');
  });
  afterAll(() => s.cleanup());

  it('lists what the provider offers, with hint, recommended and curated marks, and keeps it briefly', async () => {
    const r = await get('/api/v1/providers/listed/models', owner.token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      listed: true,
      models: [
        { id: 'a', label: 'A', hint: 'fast', recommended: true },
        { id: 'b', hint: 'smartest', curated: true },
      ],
    });
    await get('/api/v1/providers/listed/models', owner.token);
    expect(calls).toBe(1);
    // Refresh asks the provider again
    await get('/api/v1/providers/listed/models?refresh=1', owner.token);
    expect(calls).toBe(2);
  });

  it('says "unavailable" when the provider could not be asked, and does not keep that answer', async () => {
    fail = true;
    const r = (await (await get('/api/v1/providers/listed/models?refresh=1', owner.token)).json()) as any;
    expect(r).toEqual({ listed: true, models: [], error: 'unavailable' });
    fail = false;
    const again = (await (await get('/api/v1/providers/listed/models', owner.token)).json()) as any;
    expect(again.models).toHaveLength(2);
  });

  it('a brain without a model list says so; an unknown brain is 404; members cannot ask', async () => {
    expect(await (await get('/api/v1/providers/unlisted/models', owner.token)).json()).toEqual({
      models: [],
      listed: false,
    });
    expect((await get('/api/v1/providers/nope/models', owner.token)).status).toBe(404);
    expect((await get('/api/v1/providers/listed/models', member.token)).status).toBe(403);
  });
});

/**
 * review-b (low): GET /api/v1/providers runs every brain's CLI outside the sandbox. Its result is shared and kept
 * briefly, so a burst of requests runs each CLI once, and a member or guest gets only what the picker reads.
 */
describe('provider list: cached detection, owner-only details', () => {
  let s: TestServer;
  let detects = 0;
  const counted: ProviderAdapter = Object.assign(Object.create(FakeProvider.prototype), new FakeProvider(), {
    id: 'counted',
    displayName: 'Counted',
    async detect() {
      detects++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        installed: true,
        signedIn: true,
        version: '9.9.9',
        hint: 'secret-ish hint',
        installCmd: ['x'],
      };
    },
  });
  beforeAll(async () => {
    s = await bootTestServer({ providers: [counted] });
  });
  afterAll(async () => {
    await s?.cleanup();
  });
  const list = async (token: string) => {
    const r = await fetch(`${s.url}/api/v1/providers`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as { providers: Record<string, any>[] } };
  };

  it('a burst of requests runs the CLI once; members and guests see only the picker fields', async () => {
    const owner = seedUser(s.db, 'owner', 'O');
    const member = seedUser(s.db, 'member', 'M');
    const guest = seedUser(s.db, 'guest', 'G');
    const before = detects;
    const many = await Promise.all(
      Array.from({ length: 12 }, (_, i) => list((i % 2 ? guest : member).token)),
    );
    expect(many.every((r) => r.status === 200)).toBe(true);
    expect(detects - before).toBe(1);
    // still kept for the next member/guest request
    await list(guest.token);
    expect(detects - before).toBe(1);
    const g = (await list(guest.token)).body.providers.find((p) => p.id === 'counted')!;
    expect(g.status).toEqual({ installed: true, signedIn: true });
    expect(Object.keys(g).sort()).toEqual(
      ['displayName', 'id', 'status', ...('displayNameKey' in g ? ['displayNameKey'] : [])].sort(),
    );
    // the owner gets the whole status and the capabilities
    const o = (await list(owner.token)).body.providers.find((p) => p.id === 'counted')!;
    expect(o.status).toMatchObject({ version: '9.9.9', installCmd: ['x'] });
    expect(o.caps).toBeTruthy();
    expect((await fetch(`${s.url}/api/v1/providers`)).status).toBe(401);
  });
});
