/**
 * Simplify spec 4: sidebar pins are per person (own row only, follow them across devices) and the owner's "Not
 * using this" list is owner-only, refuses never-hideable features and drops hidden ids from everyone's pins.
 */
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';

describe('ui prefs and hidden features', () => {
  let s: TestServer;
  let owner = '';
  let member = '';
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    owner = seedUser(s.db, 'owner').token;
    member = seedUser(s.db, 'member', 'Member').token;
  });
  afterAll(() => s.cleanup());

  // review finding (FIRST-TIMER fix 13): a brand-new account never saw the old UI, so no "We tidied up" card
  it('"We tidied up" shows only to an account that existed before the simplified UI arrived', async () => {
    expect((await call(owner, 'GET', '/api/v1/me/prefs')).json.prefs['ui.tidied']).toBe(true);
    const old = seedUser(s.db, 'member', 'Old member');
    const { t } = s.db
      .prepare("SELECT MIN(applied_at) AS t FROM _migrations WHERE name LIKE '%user_prefs%'")
      .get() as { t: number };
    s.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(t - 60_000, old.id);
    expect((await call(old.token, 'GET', '/api/v1/me/prefs')).json.prefs['ui.tidied']).toBe(false);
    await call(old.token, 'PUT', '/api/v1/me/prefs/ui.tidied', { value: true });
    expect((await call(old.token, 'GET', '/api/v1/me/prefs')).json.prefs['ui.tidied']).toBe(true);
  });

  it('nothing is pinned by default; signed out gets 401', async () => {
    expect((await call(owner, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual([]);
    expect((await call('', 'GET', '/api/v1/me/prefs')).status).toBe(401);
    expect((await call('', 'PUT', '/api/v1/me/prefs/ui.pins', { value: ['routines'] })).status).toBe(401);
  });

  it('each person keeps their own ordered pins; duplicates and bad ids are refused or dropped', async () => {
    const a = await call(owner, 'PUT', '/api/v1/me/prefs/ui.pins', {
      value: ['routines', 'inbox', 'routines'],
    });
    expect(a.status).toBe(200);
    expect(a.json.prefs['ui.pins']).toEqual(['routines', 'inbox']);
    await call(member, 'PUT', '/api/v1/me/prefs/ui.pins', { value: ['search'] });
    expect((await call(owner, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual([
      'routines',
      'inbox',
    ]);
    expect((await call(member, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual(['search']);
    expect((await call(owner, 'PUT', '/api/v1/me/prefs/ui.pins', { value: ['<script>'] })).status).toBe(400);
    expect((await call(owner, 'PUT', '/api/v1/me/prefs/ui.pins', { value: 'routines' })).status).toBe(400);
    expect((await call(owner, 'PUT', '/api/v1/me/prefs/other', { value: 1 })).status).toBe(404);
    expect((await call(owner, 'PUT', '/api/v1/me/prefs/__proto__', { value: 1 })).status).toBe(404);
  });

  it('only the owner hides features; core ones never hide; hidden ids leave every pin list', async () => {
    expect((await call(member, 'PUT', '/api/v1/settings/features', { hidden: ['inbox'] })).status).toBe(403);
    expect((await call(owner, 'PUT', '/api/v1/settings/features', { hidden: ['safety'] })).status).toBe(400);
    expect((await call(owner, 'PUT', '/api/v1/settings/features', { hidden: ['devices'] })).status).toBe(400);
    const r = await call(owner, 'PUT', '/api/v1/settings/features', { hidden: ['inbox', 'shop', 'people'] });
    expect(r.status).toBe(200);
    expect((await call(owner, 'GET', '/api/v1/settings/features')).json.hidden).toEqual([
      'inbox',
      'shop',
      'people',
    ]);
    // a member learns only the hidden ids of features their role may see
    expect((await call(member, 'GET', '/api/v1/settings/features')).json.hidden).toEqual(['people']);
    expect((await call(owner, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual(['routines']);
    // shown again: the old pin comes back (the stored row was never rewritten)
    await call(owner, 'PUT', '/api/v1/settings/features', { hidden: [] });
    expect((await call(owner, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual([
      'routines',
      'inbox',
    ]);
  });

  it('a member or guest can never pin an owner-only feature (the server drops it, whatever the client sends)', async () => {
    const guest = seedUser(s.db, 'guest', 'Guest').token;
    const m = await call(member, 'PUT', '/api/v1/me/prefs/ui.pins', {
      value: ['admin', 'trust', 'hidden-features', 'routines', 'search', 'made-up', 'agents'],
    });
    expect(m.status).toBe(200);
    expect(m.json.prefs['ui.pins']).toEqual(['search', 'agents']);
    const g = await call(guest, 'PUT', '/api/v1/me/prefs/ui.pins', {
      value: ['agents', 'people', 'always-asks'],
    });
    expect(g.json.prefs['ui.pins']).toEqual(['people']);
    // a row written before this rule (or by hand) is filtered on the way out too
    const uid = (
      s.db.prepare("SELECT user_id FROM user_prefs WHERE key = 'ui.pins' ORDER BY updated_at DESC").get() as {
        user_id: string;
      }
    ).user_id;
    s.db
      .prepare("UPDATE user_prefs SET value = ? WHERE user_id = ? AND key = 'ui.pins'")
      .run(JSON.stringify(['admin', 'people']), uid);
    expect((await call(guest, 'GET', '/api/v1/me/prefs')).json.prefs['ui.pins']).toEqual(['people']);
    // the owner keeps any feature id
    const o = await call(owner, 'PUT', '/api/v1/me/prefs/ui.pins', {
      value: ['admin', 'trust', 'routines', 'inbox'],
    });
    expect(o.json.prefs['ui.pins']).toEqual(['admin', 'trust', 'routines', 'inbox']);
    await call(owner, 'PUT', '/api/v1/me/prefs/ui.pins', { value: ['routines', 'inbox'] });
    await call(member, 'PUT', '/api/v1/me/prefs/ui.pins', { value: ['search'] });
  });

  it('pins live in one row per person', () => {
    const row = s.db.prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE key = 'ui.pins'").get() as {
      n: number;
    };
    expect(row.n).toBe(3);
  });
});
