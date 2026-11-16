/**
 * A small in-process stand-in for the Telegram Bot HTTP API, written for these tests from the public method
 * shapes. Binds 127.0.0.1 on port 0. Only the methods the adapter uses.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChannelContractPlatform, ContractActor, ContractPlace } from '@pasabot/testkit';

interface Chat {
  id: number;
  type: 'private' | 'group' | 'supergroup';
  title?: string;
  first_name?: string;
}
interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
interface Msg {
  message_id: number;
  chat: Chat;
  from: User;
  date: number;
  text: string;
  entities?: unknown[];
}

export const TOKEN = '7000:AAH-test-token-not-real-0123456789';
export const BOT: User = { id: 7000, is_bot: true, first_name: 'PasaBot', username: 'pasabot_bot' };

export class MockBotApi implements ChannelContractPlatform {
  readonly users = {
    owner: { id: '1001', name: 'Dee Cruz' },
    stranger: { id: '2002', name: 'Some One' },
    impostor: { id: '3003', name: 'Dee Cruz' },
    otherBot: { id: '9009', name: 'Other' },
  };
  readonly places = { dm: '1001', strangerDm: '2002', group: '-100555' };
  readonly textLimit = 4096;
  /** every call, for assertions: method + params (never logged anywhere) */
  readonly calls: { method: string; params: any }[] = [];
  /** next N calls of a method answer 429 with retry_after 0 */
  readonly fail429 = new Map<string, number>();
  /** when set, every call answers 401 (token revoked) */
  revoked = false;
  private server: Server;
  private updates: { update_id: number; message: Msg }[] = [];
  private nextUpdate = 1;
  private nextMsg = new Map<number, number>();
  private stored = new Map<string, Msg>();
  private waiters = new Set<() => void>();
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        void this.handle(req.url ?? '', raw).then(([status, body]) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        });
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop() {
    for (const w of this.waiters) w();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private chat(place: ContractPlace): Chat {
    if (place === 'group') return { id: -100555, type: 'supergroup', title: 'PasaBot Crew' };
    const u = place === 'dm' ? this.users.owner : this.users.stranger;
    return { id: Number(u.id), type: 'private', first_name: u.name };
  }
  private user(a: ContractActor): User {
    const u = this.users[a];
    const [first, ...last] = u.name.split(' ');
    return {
      id: Number(u.id),
      is_bot: a === 'otherBot',
      first_name: first!,
      ...(last.length ? { last_name: last.join(' ') } : {}),
      ...(a === 'otherBot' ? { username: 'other_bot' } : {}),
    } as User;
  }
  private newMsg(chat: Chat, from: User, text: string, entities?: unknown[]): Msg {
    const id = (this.nextMsg.get(chat.id) ?? 0) + 1;
    this.nextMsg.set(chat.id, id);
    const m: Msg = { message_id: id, chat, from, date: Math.floor(Date.now() / 1000), text, entities };
    this.stored.set(`${chat.id}:${id}`, m);
    return m;
  }
  /** deliver a raw update (for unit tests of unusual shapes) */
  pushUpdate(message: any) {
    this.updates.push({ update_id: this.nextUpdate++, message });
    for (const w of this.waiters) w();
  }
  async deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }) {
    const handle = `@${BOT.username}`;
    const text = m.mention ? `${handle} ${m.text}` : m.text;
    const entities = m.mention ? [{ type: 'mention', offset: 0, length: handle.length }] : undefined;
    this.pushUpdate(this.newMsg(this.chat(m.place), this.user(m.from), text, entities));
  }
  messageText(placeId: string, externalId: string) {
    const m = this.stored.get(externalId);
    return m && String(m.chat.id) === placeId ? m.text : undefined;
  }
  botTexts(placeId: string) {
    return [...this.stored.values()]
      .filter((m) => String(m.chat.id) === placeId && m.from.id === BOT.id)
      .sort((a, b) => a.message_id - b.message_id)
      .map((m) => m.text);
  }

  private async handle(url: string, raw: string): Promise<[number, unknown]> {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m || m[1] !== TOKEN || this.revoked)
      return [401, { ok: false, error_code: 401, description: 'Unauthorized' }];
    const method = m[2]!;
    const p = raw ? JSON.parse(raw) : {};
    this.calls.push({ method, params: p });
    const n429 = this.fail429.get(method) ?? 0;
    if (n429 > 0) {
      this.fail429.set(method, n429 - 1);
      return [
        429,
        { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } },
      ];
    }
    const ok = (result: unknown): [number, unknown] => [200, { ok: true, result }];
    if (typeof p.text === 'string' && p.text.length > this.textLimit)
      return [400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' }];
    switch (method) {
      case 'getMe':
        return ok(BOT);
      case 'getUpdates': {
        const offset: number = p.offset ?? 0;
        this.updates = this.updates.filter((u) => u.update_id >= offset);
        if (!this.updates.length && p.timeout > 0) {
          await new Promise<void>((r) => {
            const done = () => {
              this.waiters.delete(done);
              clearTimeout(t);
              r();
            };
            const t = setTimeout(done, p.timeout * 1000);
            this.waiters.add(done);
          });
        }
        return ok(this.updates.slice(0, 100));
      }
      case 'sendMessage': {
        const chatId = Number(p.chat_id);
        const chat: Chat =
          chatId < 0
            ? { id: chatId, type: 'supergroup', title: 'PasaBot Crew' }
            : { id: chatId, type: 'private', first_name: 'x' };
        return ok(this.newMsg(chat, BOT, p.text));
      }
      case 'editMessageText': {
        const msg = this.stored.get(`${p.chat_id}:${p.message_id}`);
        if (!msg || msg.from.id !== BOT.id)
          return [400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }];
        if (msg.text === p.text)
          return [400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }];
        msg.text = p.text;
        return ok(msg);
      }
      case 'deleteMessage': {
        const key = `${p.chat_id}:${p.message_id}`;
        if (!this.stored.has(key))
          return [
            400,
            { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
          ];
        this.stored.delete(key);
        return ok(true);
      }
      case 'setMessageReaction':
        return ok(true);
      default:
        return [404, { ok: false, error_code: 404, description: 'Not Found' }];
    }
  }
}
