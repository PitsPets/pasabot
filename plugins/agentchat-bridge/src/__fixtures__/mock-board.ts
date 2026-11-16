/**
 * An in-process agent message board speaking the bridge's board protocol (README) on 127.0.0.1, port 0.
 * Used by the unit tests and the Playwright spec; no network, no real board, no account.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAgent {
  id: string;
  name: string;
  token: string;
}
export interface MockMessage {
  id: string;
  seq: number;
  from: { id: string; name: string };
  to: string | null;
  room: string | null;
  threadId: string | null;
  text: string;
  createdAt: number;
}

export class MockBoard {
  readonly messages: MockMessage[] = [];
  /** every request the board received (method + path, the bearer it carried) */
  readonly requests: { method: string; path: string; auth: string | undefined }[] = [];
  /** a board that predates the `limit` parameter and returns everything after the cursor */
  ignoreLimit = false;
  /** answer every `after=` inbox call with a body that is not JSON */
  brokenInbox = false;
  /** every `limit` the inbox was asked for */
  readonly limits: number[] = [];
  private seq = 0;
  private server: Server | null = null;
  url = '';

  constructor(readonly agents: MockAgent[]) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://board');
      this.requests.push({ method: req.method ?? '', path: u.pathname, auth: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const me = this.agents.find((a) => a.token === bearer);
      if (!me) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && u.pathname === '/api/whoami')
        return send(200, { id: me.id, name: me.name });
      if (req.method === 'GET' && u.pathname === '/api/inbox') {
        const cursor = String(this.seq);
        if (u.searchParams.get('latest')) return send(200, { messages: [], cursor });
        const after = Number(u.searchParams.get('after') ?? '0');
        if (this.brokenInbox) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"messages": [ not json');
        }
        const asked = Number(u.searchParams.get('limit') ?? '0');
        if (asked) this.limits.push(asked);
        let mine = this.messages.filter(
          (m) => m.seq > after && (m.room !== null || m.to === null || m.to === me.id || m.from.id === me.id),
        );
        let next = cursor;
        if (asked > 0 && !this.ignoreLimit && mine.length > asked) {
          mine = mine.slice(0, asked);
          next = String(mine.at(-1)!.seq);
        }
        return send(200, { messages: mine.map(({ seq: _s, ...m }) => m), cursor: next });
      }
      if (req.method === 'POST' && u.pathname === '/api/messages') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const b = JSON.parse(raw || '{}') as {
            to?: string;
            room?: string;
            threadId?: string;
            text?: string;
          };
          if (!b.text) return send(400, { error: 'text required' });
          const m = this.add(me, { to: b.to, room: b.room, threadId: b.threadId, text: b.text });
          send(201, { id: m.id });
        });
        return;
      }
      send(404, { error: 'not found' });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** an agent posts on the board (what another agent's tool call does) */
  post(fromId: string, p: { to?: string; room?: string; threadId?: string; text: string }): MockMessage {
    const from = this.agents.find((a) => a.id === fromId);
    if (!from) throw new Error(`no board agent ${fromId}`);
    return this.add(from, p);
  }

  /** texts an agent posted, oldest first */
  textsFrom(agentId: string): string[] {
    return this.messages.filter((m) => m.from.id === agentId).map((m) => m.text);
  }

  private add(from: MockAgent, p: { to?: string; room?: string; threadId?: string; text: string }) {
    const seq = ++this.seq;
    const m: MockMessage = {
      id: `m${seq}`,
      seq,
      from: { id: from.id, name: from.name },
      to: p.to ?? null,
      room: p.room ?? null,
      threadId: p.threadId ?? `t${seq}`,
      text: p.text,
      createdAt: Date.now(),
    };
    this.messages.push(m);
    return m;
  }

  async stop() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
