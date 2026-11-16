/**
 * W43 "Do it with me" on the inbox side: the sign-up step's server flow takes only names and an idea the checklist
 * showed, asks the browser port to open the service's own sign-up hosts and fill those three fields, posts the
 * hand-over card (Take over, Done), and on Done the checklist asks for the new address. No browser starts here (the
 * port is a recording stand-in; the browser module's own test drives a real one on a fake sign-up page). When the
 * helper's browser cannot start, the route says so (the card falls back to "I'll do it in my own browser").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSystem, defineModule, type ManagedBrowserPort, type ModuleHost } from '@pasabot/core';
import type { MessageDTO } from '@pasabot/protocol';
import { bootTestServer, seedAgent, seedChat, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInboxModule } from './server.js';

const calls: { what: string; o: unknown }[] = [];
let fail = false;
const guided: NonNullable<ManagedBrowserPort['guided']> = {
  async start(_a, o) {
    calls.push({ what: 'start', o });
    if (fail) throw new Error('chromium could not start');
    return { profileId: 'P1' };
  },
  async fill(_a, o) {
    calls.push({ what: 'fill', o });
    return { filled: o.fields.map((f) => f.kind) };
  },
  takeOver(o) {
    calls.push({ what: 'take', o });
  },
  end(o) {
    calls.push({ what: 'end', o });
  },
  state: () => ({ active: true, takenOver: false }),
};
let teamHost: ModuleHost | null = null;
/** stands in for the browser module (its port) and the team builder (its team card) */
const stand = defineModule({
  id: 'orchestrator',
  register(app: ModuleHost) {
    teamHost = app;
    app.blocks.register('orchestrator.team', z.object({}).passthrough());
    app.browser.set({ guided } as unknown as ManagedBrowserPort);
  },
});

describe('"Do it with me" (W43): the helper opens the sign-up, the owner does the secret parts', () => {
  let s: TestServer;
  let home: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let lead = '';
  let chat = '';
  const req = async (method: string, p: string, body?: unknown, token = owner.token) => {
    const r = await fetch(`${s.url}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : {}) as any };
  };
  const messages = async () =>
    ((await req('GET', `/api/v1/chats/${chat}/messages`)).json as { messages: MessageDTO[] }).messages;
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'inbox-withme-'));
    s = await bootTestServer({
      home,
      modules: [
        stand,
        createInboxModule({
          pollEveryMs: 0,
          signup: { url: 'https://signup.test/signup', hosts: ['signup.test'] },
        }),
      ],
    });
    owner = seedUser(s.db, 'owner', 'PitsPets');
    member = seedUser(s.db, 'member', 'Mia');
    lead = seedAgent(s.db, { slug: 'mayumi', trust: 'trusted' });
    s.db.prepare('UPDATE agents SET name = ? WHERE id = ?').run('Mayumi', lead);
    chat = seedChat(s.db, { userIds: [owner.id], agentIds: [lead] });
    teamHost!.chats.post(asSystem('test: team card'), {
      chatId: chat,
      authorKind: 'agent',
      authorId: lead,
      body: 'Your team is ready',
      blocks: [{ kind: 'orchestrator.team', v: 1, data: { steps: [{ kind: 'email-new' }], agents: [] } }],
    });
    await waitFor(async () => (await req('GET', '/api/m/inbox/guide')).json.guide ?? undefined);
  });
  afterAll(async () => {
    await s?.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it('fills only the names and an idea from the card, on the sign-up’s own hosts, then hands over', async () => {
    let g = (await req('GET', '/api/m/inbox/guide')).json.guide;
    g = (await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'name', name: 'Kakanin ni Ligaya' }))
      .json.guide;
    const idea = g.ideas[0] as string;
    g = (await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'next' })).json.guide;
    expect(g.step).toBe('signup');
    const body = { id: g.id, first: 'Ligaya', last: 'Santos', idea };
    // only an idea the card showed, plain names, the owner only
    expect((await req('POST', '/api/m/inbox/guide/withme', { ...body, idea: 'boss@evil.test' })).status).toBe(
      400,
    );
    expect((await req('POST', '/api/m/inbox/guide/withme', { ...body, first: '<b>x</b>' })).status).toBe(400);
    expect((await req('POST', '/api/m/inbox/guide/withme', body, member.token)).status).toBe(403);
    expect((await req('POST', '/api/m/inbox/guide/withme/take', { id: g.id }, member.token)).status).toBe(
      403,
    );
    expect((await req('POST', '/api/m/inbox/guide/withme/done', { id: g.id }, member.token)).status).toBe(
      403,
    );
    expect(calls).toEqual([]);
    const r = await req('POST', '/api/m/inbox/guide/withme', body);
    expect(r.status).toBe(200);
    expect(r.json.guide.withMe).toMatchObject({ profileId: 'P1', state: 'yours', idea });
    expect(calls[0]).toEqual({
      what: 'start',
      o: { profileName: 'Mayumi', url: 'https://signup.test/signup', allowedHosts: ['signup.test'] },
    });
    expect(calls[1]).toEqual({
      what: 'fill',
      o: {
        profileId: 'P1',
        fields: [
          { kind: 'givenName', value: 'Ligaya' },
          { kind: 'familyName', value: 'Santos' },
          { kind: 'username', value: idea.split('@')[0] },
        ],
      },
    });
    // no name is kept in the checklist's state
    expect(JSON.stringify((await req('GET', '/api/m/inbox/guide')).json.guide)).not.toContain('Santos');
    // the hand-over card: the helper's, with the live browser, Take over and Done (in the decision bar)
    const card = (await messages())
      .flatMap((m) => m.blocks)
      .find((b) => b.kind === 'core.card' && (b.data as any).source === 'inbox.withme')?.data as any;
    expect(card).toMatchObject({
      title: { key: 'inbox:guide.withMe.yourTurn' },
      visual: { kind: 'browser', profileId: 'P1' },
      needsAnswer: true,
      state: 'open',
    });
    expect(card.actions.map((a: { id: string }) => a.id)).toEqual(['take', 'done']);
    // Back is closed while the helper's browser is on the sign-up
    expect((await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'back' })).json.guide.step).toBe(
      'signup',
    );
    // Take over (the card's tap): the owner drives; the helper is out of that browser
    expect((await req('POST', `/api/v1/cards/${card.id}/act`, { action: 'take' })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ what: 'take', o: { profileId: 'P1' } });
    expect((await req('GET', '/api/m/inbox/guide')).json.guide.withMe.state).toBe('taken');
    // a second Do it with me (a double tap, another tab) never restarts the flow the owner took over
    const startsBefore = calls.filter((c) => c.what === 'start').length;
    const again = await req('POST', '/api/m/inbox/guide/withme', body);
    expect([again.status, again.json.error ?? again.json.code]).toEqual([409, 'moved']);
    expect(calls.filter((c) => c.what === 'start').length).toBe(startsBefore);
    expect((await req('GET', '/api/m/inbox/guide')).json.guide.withMe.state).toBe('taken');
    // a card tap never approves anything
    expect(s.db.prepare("SELECT count(*) n FROM approvals WHERE state = 'approved'").get()).toEqual({ n: 0 });
    // Done: the flow ends, the card settles, the checklist asks for the new address
    const done = await req('POST', `/api/v1/cards/${card.id}/act`, { action: 'done' });
    expect(done.json.card).toMatchObject({ state: 'done', settled: { key: 'inbox:guide.withMe.settled' } });
    expect(calls.at(-1)).toEqual({ what: 'end', o: { profileId: 'P1' } });
    const after = (await req('GET', '/api/m/inbox/guide')).json.guide;
    expect([after.step, after.withMe]).toEqual(['address', null]);
    // and on into the Gmail connect steps
    const a = await req('POST', '/api/m/inbox/guide/step', { id: after.id, do: 'address', address: idea });
    expect(a.json.guide.step).toBe('guide');
  });

  it('when the helper’s browser cannot start, the route says so and the step stays (own-browser way)', async () => {
    // the open checklist (on the app password guide now) goes back to the sign-up step
    let g = (await req('GET', '/api/m/inbox/guide')).json.guide;
    g = (await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'back' })).json.guide;
    g = (await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'back' })).json.guide;
    expect(g.step).toBe('signup');
    fail = true;
    const r = await req('POST', '/api/m/inbox/guide/withme', {
      id: g.id,
      first: 'Ana',
      last: 'Reyes',
      idea: g.ideas[0],
    });
    fail = false;
    expect([r.status, r.json.error ?? r.json.code]).toEqual([409, 'no_browser']);
    const now = (await req('GET', '/api/m/inbox/guide')).json.guide;
    expect([now.step, now.withMe ?? null]).toEqual(['signup', null]);
    // the old way still works: Done moves on to the address
    expect((await req('POST', '/api/m/inbox/guide/step', { id: g.id, do: 'next' })).json.guide.step).toBe(
      'address',
    );
  });
});
