/**
 * The Slack Events hook through a running server (not only inside the adapter): the channels module's public route
 * `/hooks/channels/<binding>/events` hands the exact request bytes to the Slack connection. A signed request is
 * accepted (URL verification, then a DM that links the owner and gets the agent's reply), a bad signature is 401,
 * and a captured request replayed after the 5-minute window is refused. The Slack Web API is a fake `fetch`; no
 * network.
 */
import { createHmac } from 'node:crypto';
import { bootTestServer, seedAgent, seedUser, type TestServer } from '@pasabot/testkit';
import { afterEach, expect, it } from 'vitest';
import { createChannelsModule } from '../../../modules/channels/src/server.js';
import { FakeProvider } from '../../../providers/fake/src/index.js';
import { createSlackAdapter } from './index.js';

const SECRET = 'e2eSigningSecret0123456789abcdef';
let s: TestServer | null = null;
afterEach(async () => {
  await s?.cleanup().catch(() => {});
  s = null;
});

async function until<T>(
  f: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  ms = 5000,
) {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sign = (body: string, ts: number, secret = SECRET) =>
  `v0=${createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex')}`;

it('the Slack Events hook works through a booted server: signed accepted, bad signature 401, replay refused', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const slack = createSlackAdapter({
    fetch: async (url, init) => {
      const method = url.split('/').pop()!;
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      calls.push({ method, body });
      const out =
        method === 'auth.test'
          ? { ok: true, user_id: 'UBOT', team_id: 'T1', bot_id: 'BBOT' }
          : method === 'users.info'
            ? { ok: true, user: { id: 'U1', name: 'diwa', real_name: 'Diwa' } }
            : { ok: true, ts: `${Date.now() / 1000}`, channel: body.channel };
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    },
  });
  s = await bootTestServer({
    modules: [createChannelsModule()],
    providers: [
      new FakeProvider({
        script: [
          { event: { type: 'text.final', text: 'Salamat, natanggap ko.' } },
          { event: { type: 'done', stop: 'end' } },
        ],
      }),
    ],
    channels: [slack],
    channelRuntime: { backoffBaseMs: 20, backoffMaxMs: 100, editMs: 5, statusPollMs: 20 },
    dispatcher: { pollMs: 5 },
  });
  const srv = s;
  const owner = seedUser(srv.db);
  const agent = seedAgent(srv.db, { trust: 'trusted' });
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${srv.url}/api/m/channels${path}`, {
      method,
      headers: {
        authorization: `Bearer ${owner.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const created = await api('POST', '/bindings', {
    kind: 'slack',
    agentId: agent,
    secrets: { botToken: 'xoxb-1234567890-abcdefghij', signingSecret: SECRET },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const binding = ((await created.json()) as { binding: { id: string } }).binding.id;
  await until(
    () =>
      (srv.db.prepare('SELECT status FROM channels_binding WHERE id = ?').get(binding) as { status: string })
        .status === 'connected',
  );

  const hook = `${srv.url}/hooks/channels/${binding}/events`;
  const post = (body: string, headers: Record<string, string>) =>
    fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const signed = (body: string, ts = Math.floor(Date.now() / 1000)) =>
    post(body, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sign(body, ts) });
  let n = 0;
  const dm = (text: string) =>
    JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: `Ev${++n}`,
      event: {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        user: 'U1',
        team: 'T1',
        text,
        ts: `1700000${n}.000100`,
      },
    });

  // signed: URL verification answers the challenge
  const v = await signed(JSON.stringify({ type: 'url_verification', challenge: 'chal-123' }));
  expect(v.status).toBe(200);
  expect(await v.json()).toEqual({ challenge: 'chal-123' });

  // signed: the owner links by DM, then a DM gets the agent's reply back out through the Web API
  const { code } = (await (await api('POST', `/bindings/${binding}/link`)).json()) as { code: string };
  expect((await signed(dm(`/link ${code}`))).status).toBe(200);
  const hello = dm('hello from slack');
  const helloTs = Math.floor(Date.now() / 1000);
  expect((await signed(hello, helloTs)).status).toBe(200);
  await until(() =>
    calls.some(
      (c) =>
        (c.method === 'chat.postMessage' || c.method === 'chat.update') &&
        String(c.body.text) === 'Salamat, natanggap ko.',
    ),
  );
  const runs = () =>
    (srv.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE kind = 'message'").get() as { n: number }).n;
  const ran = runs();

  // bad signature: 401, nothing queued
  const bad = await post(dm('forged'), {
    'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-slack-signature': sign(dm('forged'), Math.floor(Date.now() / 1000), 'wrongSecret0123456789abcdefgh'),
  });
  expect(bad.status).toBe(401);
  expect(await post(dm('unsigned'), {}).then((r) => r.status)).toBe(401);

  // replay: the captured, validly signed request sent again after the window is refused
  const old = helloTs - 6 * 60;
  const replay = await post(hello, {
    'x-slack-request-timestamp': String(old),
    'x-slack-signature': sign(hello, old),
  });
  expect(replay.status).toBe(401);
  // and the same event redelivered inside the window (Slack's retry) is accepted but runs once
  expect((await signed(hello)).status).toBe(200);
  await new Promise((r) => setTimeout(r, 200));
  expect(runs()).toBe(ran);
});
