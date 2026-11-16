/**
 * A small in-process stand-in for the Slack Web API (only the methods the adapter calls), written for these tests
 * from the public method shapes, plus the Events API side: `deliver` signs an event with the app's signing secret
 * and hands it to the connection's `handleHttp`, as the binding runtime does. Binds 127.0.0.1 on port 0.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChannelConnection, ChannelHttpResponse } from '@pasabot/core';
import type { ChannelContractPlatform, ContractActor, ContractPlace } from '@pasabot/testkit';

export const TOKEN = 'xoxb-1000-2000-testtokennotreal';
export const BAD_TOKEN = 'xoxb-1000-2000-wrongtokenxxxxx';
export const SIGNING_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const TEAM = 'T0TEAM';
export const BOT_USER = 'U0BOT';

const LIMIT = 4000;

export function signSlack(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': `v0=${mac}` };
}

export class MockSlack implements ChannelContractPlatform {
  readonly users = {
    owner: { id: `${TEAM}:U0OWNER`, name: 'Dee Cruz' },
    stranger: { id: `${TEAM}:U0STRANGER`, name: 'Some One' },
    impostor: { id: `${TEAM}:U0IMPOSTOR`, name: 'Dee Cruz' },
    otherBot: { id: `${TEAM}:B0OTHER`, name: 'Other' },
  };
  readonly places = { dm: 'D0OWNER', strangerDm: 'D0STRANGER', group: 'C0GROUP' };
  readonly textLimit = LIMIT;
  url = '';
  conn: ChannelConnection | null = null;
  readonly calls: string[] = [];
  private server: Server | null = null;
  private seq = 0;
  /** channel -> messages the bot posted, in order */
  private sent = new Map<string, { ts: string; text: string }[]>();

  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const method = (req.url ?? '').replace(/^\/api\//, '');
        this.calls.push(method);
        const auth = req.headers.authorization;
        const j = body ? (JSON.parse(body) as Record<string, string>) : {};
        const out = (o: unknown) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (auth !== `Bearer ${TOKEN}`) return out({ ok: false, error: 'invalid_auth' });
        if (method === 'auth.test')
          return out({ ok: true, user_id: BOT_USER, team_id: TEAM, bot_id: 'B0SELF' });
        if (method === 'users.info') {
          const u = Object.values(this.users).find((x) => x.id === `${TEAM}:${j.user}`);
          return out({ ok: true, user: { id: j.user, profile: { display_name: u?.name ?? '' } } });
        }
        if (method === 'chat.postMessage') {
          if ((j.text ?? '').length > LIMIT) return out({ ok: false, error: 'msg_too_long' });
          const ts = `1700000000.${String(++this.seq).padStart(6, '0')}`;
          const list = this.sent.get(j.channel!) ?? [];
          list.push({ ts, text: j.text ?? '' });
          this.sent.set(j.channel!, list);
          return out({ ok: true, channel: j.channel, ts });
        }
        if (method === 'chat.update') {
          if ((j.text ?? '').length > LIMIT) return out({ ok: false, error: 'msg_too_long' });
          const m = this.sent.get(j.channel!)?.find((x) => x.ts === j.ts);
          if (!m) return out({ ok: false, error: 'message_not_found' });
          m.text = j.text ?? '';
          return out({ ok: true, channel: j.channel, ts: j.ts });
        }
        if (method === 'reactions.add') return out({ ok: true });
        return out({ ok: false, error: 'unknown_method' });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
    return this;
  }
  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** a signed Events API request, as Slack sends it */
  async post(payload: unknown, secret = SIGNING_SECRET, ts?: number): Promise<ChannelHttpResponse> {
    if (!this.conn?.handleHttp) throw new Error('no connection');
    const body = JSON.stringify(payload);
    return this.conn.handleHttp({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signSlack(secret, body, ts) },
      rawBody: Buffer.from(body),
    });
  }

  async deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }) {
    const who = this.users[m.from].id.split(':')[1]!;
    const channel = this.places[m.place];
    const ts = `1700000100.${String(++this.seq).padStart(6, '0')}`;
    const event =
      m.from === 'otherBot'
        ? {
            type: m.mention ? 'app_mention' : 'message',
            bot_id: who,
            user: 'U0OTHERBOT',
            subtype: 'bot_message',
          }
        : { type: m.mention ? 'app_mention' : 'message', user: who };
    const res = await this.post({
      type: 'event_callback',
      team_id: TEAM,
      event: {
        ...event,
        // the other bot speaks as its bot id; Slack also sets a user id on it, which is not a person
        ...(m.from === 'otherBot' ? { user: undefined } : {}),
        channel,
        channel_type: m.place === 'group' ? 'channel' : 'im',
        text: m.text,
        ts,
        team: TEAM,
      },
    });
    if (res.status !== 200) throw new Error(`deliver: ${res.status}`);
  }

  messageText(placeId: string, externalId: string) {
    const ts = externalId.slice(externalId.lastIndexOf(':') + 1);
    return this.sent.get(placeId)?.find((m) => m.ts === ts)?.text;
  }
  botTexts(placeId: string) {
    return (this.sent.get(placeId) ?? []).map((m) => m.text);
  }
}
