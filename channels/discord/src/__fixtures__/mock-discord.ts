/**
 * A small in-process stand-in for Discord's REST API and Gateway, written for these tests from the public
 * shapes. One HTTP server on 127.0.0.1 port 0; the gateway is a minimal RFC 6455 text-frame server on the
 * same port (no dependency), enough for the adapter's JSON frames.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ChannelContractPlatform, ContractActor, ContractPlace } from '@pasabot/testkit';

export const TOKEN = `MTAwMDAwMDAwMDAwMDAwMDA5.Gx-test.${'n0t-a-real-token-'.repeat(3)}`;
export const BOT = { id: '100000000000000009', username: 'pasabot', global_name: 'PasaBot', bot: true };
const GUILD = '400000000000000001';

// ---------- minimal websocket server side ----------
class MiniWs {
  private buf = Buffer.alloc(0);
  closed = false;
  /** half-open link: nothing in either direction, not even a close frame */
  frozen = false;
  onText: (s: string) => void = () => {};
  constructor(private sock: Socket) {
    sock.on('data', (c: Buffer) => {
      if (this.frozen) return;
      this.buf = Buffer.concat([this.buf, c]);
      this.drain();
    });
    sock.on('close', () => (this.closed = true));
    sock.on('error', () => (this.closed = true));
  }
  private drain() {
    while (this.buf.length >= 2) {
      const op = this.buf[0]! & 0x0f;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (this.buf[1]! & 0x80) !== 0;
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i]! ^= this.buf[maskOff + (i % 4)]!;
      this.buf = this.buf.subarray(off + len);
      if (op === 1) this.onText(payload.toString('utf8'));
      else if (op === 8) this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
      else if (op === 9) this.frame(10, payload);
    }
  }
  private frame(op: number, payload: Buffer) {
    if (this.closed || this.frozen) return;
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | op, n])
        : n < 65536
          ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff])
          : Buffer.concat([Buffer.from([0x80 | op, 127]), Buffer.alloc(8)]);
    if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
    this.sock.write(Buffer.concat([head, payload]));
  }
  sendJson(v: unknown) {
    this.frame(1, Buffer.from(JSON.stringify(v)));
  }
  close(code = 1000) {
    if (this.frozen) {
      this.closed = true;
      this.sock.destroy();
      return;
    }
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.frame(8, p);
    this.closed = true;
    this.sock.end();
  }
}

interface Stored {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string };
}

export class MockDiscord implements ChannelContractPlatform {
  readonly users = {
    owner: { id: '100000000000000001', name: 'Dee Cruz' },
    stranger: { id: '100000000000000002', name: 'Some One' },
    impostor: { id: '100000000000000003', name: 'Dee Cruz' },
    otherBot: { id: '100000000000000004', name: 'Other' },
  };
  readonly places = {
    dm: '200000000000000001',
    strangerDm: '200000000000000002',
    group: '300000000000000001',
  };
  readonly textLimit = 2000;
  readonly rest: { method: string; url: string; body: any }[] = [];
  readonly gatewayOps: { op: number; d: any }[] = [];
  /** close code used to answer the next Identify (e.g. 4004, 4014) */
  identifyCloseCode: number | null = null;
  /** sent in HELLO; tests shorten it */
  heartbeatInterval = 45_000;
  url = '';
  wsUrl = '';
  private server: Server;
  private sockets = new Set<MiniWs>();
  private nextId = 500000000000000000n;
  private seq = 0;
  private stored = new Map<string, Stored>();

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const [status, body] = this.handleRest(req, raw);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      });
    });
    this.server.on('upgrade', (req, sock: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      sock.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const ws = new MiniWs(sock);
      this.sockets.add(ws);
      sock.on('close', () => this.sockets.delete(ws));
      ws.onText = (t) => this.onGateway(ws, JSON.parse(t));
      ws.sendJson({ op: 10, d: { heartbeat_interval: this.heartbeatInterval }, s: null, t: null });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/api/v10`;
    this.wsUrl = `ws://127.0.0.1:${port}/?v=10&encoding=json`;
    return this;
  }
  async stop() {
    for (const s of this.sockets) s.close(1001);
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  /** drop every gateway connection without a close handshake reason the adapter treats as fatal */
  dropGateway(code = 4000) {
    for (const s of this.sockets) s.close(code);
  }
  /** every current gateway link goes silent without closing (NAT timeout, sleep, Wi-Fi drop) */
  zombie() {
    for (const s of this.sockets) s.frozen = true;
  }
  connectedSockets() {
    return [...this.sockets].filter((s) => !s.closed).length;
  }

  private dispatch(t: string, d: unknown) {
    this.seq++;
    for (const s of this.sockets) s.sendJson({ op: 0, d, s: this.seq, t });
  }
  private onGateway(ws: MiniWs, f: { op: number; d: any }) {
    this.gatewayOps.push(f);
    if (f.op === 1) ws.sendJson({ op: 11, d: null, s: null, t: null });
    if (f.op === 2) {
      if (f.d.token !== TOKEN) return ws.close(4004);
      if (this.identifyCloseCode) return ws.close(this.identifyCloseCode);
      this.seq++;
      ws.sendJson({
        op: 0,
        s: this.seq,
        t: 'READY',
        d: {
          v: 10,
          user: BOT,
          session_id: 'sess-1',
          resume_gateway_url: this.wsUrl.replace(/\/\?.*$/, ''),
          private_channels: [],
          guilds: [{ id: GUILD, unavailable: true }],
        },
      });
      this.seq++;
      ws.sendJson({
        op: 0,
        s: this.seq,
        t: 'GUILD_CREATE',
        d: {
          id: GUILD,
          channels: [
            { id: this.places.group, type: 0, name: 'pasabot-crew' },
            { id: '300000000000000002', type: 2, name: 'voice' },
          ],
          threads: [],
        },
      });
    }
    if (f.op === 6) {
      if (f.d.token !== TOKEN) return ws.close(4004);
      this.seq++;
      ws.sendJson({ op: 0, s: this.seq, t: 'RESUMED', d: {} });
    }
  }

  private id() {
    this.nextId++;
    return this.nextId.toString();
  }
  /** dispatch a raw MESSAGE_CREATE (for unit tests of unusual shapes) */
  pushMessage(d: unknown) {
    this.dispatch('MESSAGE_CREATE', d);
  }
  async deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }) {
    const u = this.users[m.from];
    const group = m.place === 'group';
    const id = this.id();
    const content = m.mention ? `<@${BOT.id}> ${m.text}` : m.text;
    this.stored.set(id, { id, channel_id: this.places[m.place], content, author: { id: u.id } });
    this.pushMessage({
      id,
      channel_id: this.places[m.place],
      ...(group ? { guild_id: GUILD, member: { nick: null } } : {}),
      author: {
        id: u.id,
        username: u.name.toLowerCase().replace(/\s+/g, ''),
        global_name: u.name,
        ...(m.from === 'otherBot' ? { bot: true } : {}),
      },
      content,
      timestamp: new Date().toISOString(),
      mentions: m.mention ? [{ id: BOT.id, username: BOT.username }] : [],
      attachments: [],
    });
  }
  messageText(placeId: string, externalId: string) {
    const s = this.stored.get(externalId);
    return s && s.channel_id === placeId ? s.content : undefined;
  }
  /** insertion order = send order */
  botTexts(placeId: string) {
    return [...this.stored.values()]
      .filter((s) => s.channel_id === placeId && s.author.id === BOT.id)
      .map((s) => s.content);
  }

  private handleRest(req: IncomingMessage, raw: string): [number, unknown] {
    const method = req.method ?? 'GET';
    const url = (req.url ?? '').replace(/^\/api\/v10/, '');
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.headers.authorization !== `Bot ${TOKEN}`) return [401, { message: '401: Unauthorized', code: 0 }];
    this.rest.push({ method, url, body });
    if (typeof body?.content === 'string' && body.content.length > this.textLimit)
      return [400, { message: 'Invalid Form Body', code: 50035 }];
    if (method === 'GET' && url === '/users/@me') return [200, BOT];
    let m = /^\/channels\/(\d+)\/messages$/.exec(url);
    if (m && method === 'POST') {
      const id = this.id();
      const s: Stored = { id, channel_id: m[1]!, content: body.content, author: { id: BOT.id } };
      this.stored.set(id, s);
      // Discord echoes the bot's own message on the gateway; the adapter must skip it
      this.dispatch('MESSAGE_CREATE', {
        ...s,
        author: BOT,
        timestamp: new Date().toISOString(),
        mentions: [],
        attachments: [],
      });
      return [200, s];
    }
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(url);
    if (m && method === 'PATCH') {
      const s = this.stored.get(m[2]!);
      if (!s || s.channel_id !== m[1] || s.author.id !== BOT.id) return [403, { message: 'Cannot edit' }];
      s.content = body.content;
      return [200, s];
    }
    if (m && method === 'DELETE') {
      const s = this.stored.get(m[2]!);
      if (!s || s.channel_id !== m[1]) return [404, { message: 'Unknown Message', code: 10008 }];
      this.stored.delete(m[2]!);
      return [204, undefined];
    }
    if (/^\/channels\/\d+\/messages\/\d+\/reactions\/[^/]+\/@me$/.test(url) && method === 'PUT')
      return [204, undefined];
    return [404, { message: 'Unknown' }];
  }
}
