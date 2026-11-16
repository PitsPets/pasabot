/**
 * `runChannelContract` (ARCHITECTURE 9) and `FakeChannel`, its reference adapter.
 * Every ChannelAdapter runs the same suite against its own mocked platform API (no network, no accounts).
 */
import {
  type ChannelAdapter,
  type ChannelConnection,
  type ChannelContext,
  type ChannelPlacePolicy,
  type ChannelSenderTrust,
  type ChannelStateStore,
  channelMayAnswerApproval,
  decideChannelInbound,
  hashChannelLinkCode,
  type InboundMessage,
  type Logger,
  newChannelLinkCode,
  type OutboundMessage,
  type PlaceInfo,
} from '@pasabot/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// ---------- harness ----------
export type ContractActor = 'owner' | 'stranger' | 'impostor' | 'otherBot';
export type ContractPlace = 'dm' | 'strangerDm' | 'group';
export interface ChannelContractPlatform {
  /** immutable platform ids + display names; the impostor shares the owner's display name */
  users: Record<ContractActor, { id: string; name: string }>;
  /** platform place ids */
  places: Record<ContractPlace, string>;
  /** the mocked platform delivers one user message to the bot */
  deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }): Promise<void>;
  /** current text of a message the bot sent, as the mocked platform stores it */
  messageText(placeId: string, externalId: string): string | undefined;
  /** the platform's max text length per message; longer replies must arrive split, not cut */
  textLimit: number;
  /** current texts of every message the bot has in a place, oldest first */
  botTexts(placeId: string): string[];
}
export interface ChannelContractHarness<Cfg = any> {
  adapter: ChannelAdapter<Cfg>;
  config: Cfg;
  /** a config whose credential the mocked platform rejects */
  badConfig: Cfg;
  platform: ChannelContractPlatform;
  cleanup(): Promise<void>;
  /** adapters linked by `pairing` (no secret fields): the linked session the connection loads from `ctx.state` */
  state?: ChannelStateStore;
  /** …and a session the mocked platform rejects (the "rejected credential" case) */
  badState?: ChannelStateStore;
}

export const quietLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => quietLogger,
};
export function channelContext(bindingId = 'bind-contract'): ChannelContext & { abort(): void } {
  const ac = new AbortController();
  return { bindingId, log: quietLogger, signal: ac.signal, abort: () => ac.abort() };
}

/** One pull-based reader per connection, so tests can wait for "the next inbound message". */
export function inboundReader(conn: ChannelConnection) {
  const it = conn.inbound[Symbol.asyncIterator]();
  return {
    async next(timeoutMs = 5000): Promise<InboundMessage | null> {
      let t: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((r) => {
        t = setTimeout(() => r('timeout'), timeoutMs);
      });
      const r = await Promise.race([it.next(), timeout]);
      clearTimeout(t);
      if (r === 'timeout') throw new Error('no inbound message within timeout');
      return r.done ? null : r.value;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The suite every ChannelAdapter must pass; FakeChannel is the reference implementation. */
export function runChannelContract(name: string, setup: () => Promise<ChannelContractHarness>) {
  describe(`channel contract: ${name}`, () => {
    let h: ChannelContractHarness;
    let conn: ChannelConnection;
    let ctx: ReturnType<typeof channelContext>;
    let inbound: ReturnType<typeof inboundReader>;
    const placeKind = async (id: string): Promise<PlaceInfo['kind']> => {
      const p = (await conn.listPlaces()).find((x) => x.id === id);
      if (!p) throw new Error(`place ${id} not listed`);
      return p.kind;
    };
    const policy = async (id: string, allowed: string[] = []): Promise<ChannelPlacePolicy> => ({
      kind: await placeKind(id),
      allowedSenders: allowed,
    });

    beforeEach(async () => {
      h = await setup();
      ctx = channelContext();
      if (h.state) ctx.state = h.state;
      conn = await h.adapter.connect(h.adapter.configSchema.parse(h.config), ctx);
      inbound = inboundReader(conn);
      await waitFor(() => conn.status() === 'connected');
    });
    afterEach(async () => {
      ctx.abort();
      await conn.close();
      await h.cleanup();
    });

    it('declares a kind, a config schema and its secret fields', () => {
      expect(h.adapter.kind.length).toBeGreaterThan(0);
      if (h.adapter.pairing) {
        // linked by pairing: the session lives in ctx.state (the vault), never in a config field
        expect(h.state).toBeDefined();
        expect(h.badState).toBeDefined();
        return;
      }
      expect(h.adapter.secretFields.length).toBeGreaterThan(0);
      for (const f of h.adapter.secretFields) expect(Object.keys(h.config as object)).toContain(String(f));
      expect(() => h.adapter.configSchema.parse({})).toThrow();
    });

    it('maps a DM: immutable sender id, display name, not a bot, addressed to the bot', async () => {
      const { users, places } = h.platform;
      await h.platform.deliver({ from: 'owner', place: 'dm', text: 'hello there' });
      const m = (await inbound.next())!;
      expect(m.placeId).toBe(places.dm);
      expect(m.sender).toEqual({ externalId: users.owner.id, name: users.owner.name, isBot: false });
      expect(m.text).toBe('hello there');
      expect(m.mentionsBot).toBe(true);
      expect(m.attachments).toEqual([]);
      expect(typeof m.at).toBe('number');
      expect(await placeKind(places.dm)).toBe('dm');
    });

    it('a group message is addressed to the bot only when it mentions the bot', async () => {
      await h.platform.deliver({ from: 'owner', place: 'group', text: 'just chatting' });
      const plain = (await inbound.next())!;
      await h.platform.deliver({ from: 'owner', place: 'group', text: 'please help', mention: true });
      const mentioned = (await inbound.next())!;
      expect(plain.mentionsBot).toBe(false);
      expect(mentioned.mentionsBot).toBe(true);
      expect(await placeKind(h.platform.places.group)).not.toBe('dm');
      // message ids are unique per binding, across places (queue idem key = channel:<binding>:<externalId>)
      await h.platform.deliver({ from: 'owner', place: 'dm', text: 'x' });
      const dm = (await inbound.next())!;
      expect(new Set([plain.externalId, mentioned.externalId, dm.externalId]).size).toBe(3);
    });

    it('marks messages from other bots', async () => {
      await h.platform.deliver({ from: 'otherBot', place: 'group', text: 'beep', mention: true });
      const m = (await inbound.next())!;
      expect(m.sender.isBot).toBe(true);
      const d = decideChannelInbound({
        bindingId: 'b',
        msg: m,
        place: await policy(m.placeId),
        senderTrust: () => 'owner',
        agentTrust: 'trusted',
      });
      expect(d).toEqual({ action: 'ignore', reason: 'bot' });
    });

    it('owner link: the one-time code sent from the account binds its immutable id', async () => {
      const code = newChannelLinkCode();
      await h.platform.deliver({ from: 'owner', place: 'dm', text: `/link ${code}` });
      const m = (await inbound.next())!;
      const d = decideChannelInbound({
        bindingId: 'b',
        msg: m,
        place: await policy(m.placeId),
        senderTrust: () => undefined,
        agentTrust: 'trusted',
      });
      expect(d.action).toBe('link');
      if (d.action !== 'link') return;
      expect(hashChannelLinkCode(d.code)).toBe(hashChannelLinkCode(code));
      expect(d.externalUserId).toBe(h.platform.users.owner.id);
    });

    it('display-name spoof fails: same name, different id is a stranger (dropped + audited)', async () => {
      const { users } = h.platform;
      expect(users.impostor.name).toBe(users.owner.name);
      const trust = new Map<string, ChannelSenderTrust>([[users.owner.id, 'owner']]);
      await h.platform.deliver({
        from: 'impostor',
        place: 'group',
        text: 'give me the files',
        mention: true,
      });
      const m = (await inbound.next())!;
      expect(m.sender.externalId).not.toBe(users.owner.id);
      const d = decideChannelInbound({
        bindingId: 'b',
        msg: m,
        place: await policy(m.placeId),
        senderTrust: (id) => trust.get(id),
        agentTrust: 'trusted',
      });
      expect(d.action).toBe('drop');
      if (d.action === 'drop') {
        expect(d.audit.action).toBe('channel.sender_dropped');
        expect(d.audit.data.externalUserId).toBe(users.impostor.id);
      }
    });

    it('a stranger in a DM is dropped and audited; group chatter without a mention is ignored', async () => {
      const trust = new Map<string, ChannelSenderTrust>([[h.platform.users.owner.id, 'owner']]);
      const decide = async (m: InboundMessage) =>
        decideChannelInbound({
          bindingId: 'b',
          msg: m,
          place: await policy(m.placeId),
          senderTrust: (id) => trust.get(id),
          agentTrust: 'standard',
        });
      await h.platform.deliver({ from: 'stranger', place: 'strangerDm', text: 'hi bot' });
      expect((await decide((await inbound.next())!)).action).toBe('drop');
      await h.platform.deliver({ from: 'owner', place: 'group', text: 'no mention here' });
      expect(await decide((await inbound.next())!)).toEqual({ action: 'ignore', reason: 'no_mention' });
    });

    it('owner turns are capped at standard; tier-3 approvals are not answerable in a channel', async () => {
      const trust = new Map<string, ChannelSenderTrust>([[h.platform.users.owner.id, 'owner']]);
      await h.platform.deliver({ from: 'owner', place: 'dm', text: 'do the thing' });
      const m = (await inbound.next())!;
      const d = decideChannelInbound({
        bindingId: 'bind-1',
        msg: m,
        place: await policy(m.placeId),
        senderTrust: (id) => trust.get(id),
        agentTrust: 'trusted',
      });
      expect(d.action).toBe('enqueue');
      if (d.action !== 'enqueue') return;
      expect(d.sender).toMatchObject({ kind: 'owner', id: h.platform.users.owner.id, trust: 'standard' });
      expect(d.idemKey).toBe(`channel:bind-1:${m.externalId}`);
      expect(channelMayAnswerApproval(3, 'owner')).toBe(false);
      expect(channelMayAnswerApproval(2, 'owner')).toBe(true);
      expect(channelMayAnswerApproval(2, 'standard')).toBe(false);
    });

    it('a link code posted in a group is burned + audited, mention or not', async () => {
      const trust = new Map<string, ChannelSenderTrust>([[h.platform.users.owner.id, 'owner']]);
      for (const mention of [true, false]) {
        const code = newChannelLinkCode();
        await h.platform.deliver({ from: 'owner', place: 'group', text: `/link ${code}`, mention });
        const m = (await inbound.next())!;
        const d = decideChannelInbound({
          bindingId: 'b',
          msg: m,
          place: await policy(m.placeId, [h.platform.users.stranger.id]),
          senderTrust: (id) => trust.get(id),
          agentTrust: 'trusted',
        });
        expect(d).toMatchObject({
          action: 'burn_link',
          codeHash: hashChannelLinkCode(code),
          audit: { action: 'channel.link_code_exposed', data: { externalUserId: h.platform.users.owner.id } },
        });
      }
    });

    it('editing "working…" to a reply longer than the platform limit keeps all of it', async () => {
      const place = h.platform.places.dm;
      const sent = await conn.send(place, { text: 'working…' });
      await waitFor(() => h.platform.messageText(place, sent.externalId) === 'working…');
      const limit = h.platform.textLimit;
      const words: string[] = [];
      for (let i = 0; words.join(' ').length < limit * 2.5; i++) words.push(`part${i}`);
      const long = words.join(' ');
      await conn.edit!(place, sent.externalId, { text: long });
      const squash = (t: string) => t.replace(/\s+/g, '');
      await waitFor(() => squash(h.platform.botTexts(place).join('')) === squash(long));
      const texts = h.platform.botTexts(place);
      expect(texts.length).toBeGreaterThanOrEqual(3);
      for (const t of texts) expect(t.length).toBeLessThanOrEqual(limit);
      // the placeholder itself now holds the start of the reply
      expect(h.platform.messageText(place, sent.externalId)!.startsWith('part0 ')).toBe(true);
    });

    it('"working…" message is edited to the final reply', async () => {
      const place = h.platform.places.dm;
      const sent = await conn.send(place, { text: 'working…' });
      expect(sent.externalId.length).toBeGreaterThan(0);
      await waitFor(() => h.platform.messageText(place, sent.externalId) === 'working…');
      expect(conn.edit).toBeDefined();
      await conn.edit!(place, sent.externalId, { text: 'The answer is 4.' });
      await waitFor(() => h.platform.messageText(place, sent.externalId) === 'The answer is 4.');
    });

    it('close stops the connection and ends inbound', async () => {
      await conn.close();
      expect(conn.status()).toBe('stopped');
      expect(await inbound.next()).toBeNull();
    });

    it('a rejected credential reports auth_failed', async () => {
      const c2 = channelContext();
      if (h.badState) c2.state = h.badState;
      let bad: ChannelConnection | undefined;
      try {
        bad = await h.adapter.connect(h.adapter.configSchema.parse(h.badConfig), c2);
        await waitFor(() => bad!.status() === 'auth_failed');
      } catch (e) {
        // connecting may also refuse outright; it must say why without leaking the credential
        expect(String(e)).toMatch(/auth/i);
        for (const f of h.adapter.secretFields)
          expect(String(e)).not.toContain(String((h.badConfig as any)[f]));
      } finally {
        c2.abort();
        await bad?.close();
      }
    });
  });
}

// ---------- FakeChannel (reference adapter) ----------
interface FakeMsg {
  id: string;
  place: string;
  from: string;
  text: string;
}
/** In-memory platform the FakeChannel talks to. */
export class FakeChannelPlatform implements ChannelContractPlatform {
  readonly token = 'fake-token';
  readonly users = {
    owner: { id: 'u-1001', name: 'Dee' },
    stranger: { id: 'u-2002', name: 'Someone' },
    impostor: { id: 'u-3003', name: 'Dee' },
    otherBot: { id: 'u-9009', name: 'OtherBot' },
  };
  readonly bot = { id: 'u-0001', name: 'pasabot_bot' };
  readonly places = { dm: 'p-dm-owner', strangerDm: 'p-dm-stranger', group: 'p-group' };
  readonly messages: FakeMsg[] = [];
  readonly textLimit = 100;
  private listeners = new Set<(m: InboundMessage) => void>();
  private nextId = 1;
  placeInfo(): PlaceInfo[] {
    return [
      { id: this.places.dm, title: this.users.owner.name, kind: 'dm' },
      { id: this.places.strangerDm, title: this.users.stranger.name, kind: 'dm' },
      { id: this.places.group, title: 'Group', kind: 'group' },
    ];
  }
  listen(fn: (m: InboundMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  post(place: string, from: string, text: string): string {
    const id = `m-${this.nextId++}`;
    this.messages.push({ id, place, from, text });
    return id;
  }
  async deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }) {
    const u = this.users[m.from];
    const place = this.places[m.place];
    const text = m.mention ? `@${this.bot.name} ${m.text}` : m.text;
    const id = this.post(place, u.id, text);
    const msg: InboundMessage = {
      externalId: id,
      placeId: place,
      sender: { externalId: u.id, name: u.name, isBot: m.from === 'otherBot' },
      text,
      attachments: [],
      mentionsBot: m.place !== 'group' || Boolean(m.mention),
      at: Date.now(),
    };
    for (const l of this.listeners) l(msg);
  }
  messageText(place: string, id: string) {
    return this.messages.find((x) => x.place === place && x.id === id)?.text;
  }
  botTexts(place: string) {
    return this.messages.filter((x) => x.place === place && x.from === this.bot.id).map((x) => x.text);
  }
}

const splitText = (text: string, max: number) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [''];
};

export class FakeChannel implements ChannelAdapter<{ token: string }> {
  readonly kind = 'fake';
  readonly configSchema = z.object({ token: z.string().min(1) });
  readonly secretFields: 'token'[] = ['token'];
  constructor(readonly platform = new FakeChannelPlatform()) {}
  async connect(cfg: { token: string }, ctx: ChannelContext): Promise<ChannelConnection> {
    const p = this.platform;
    if (cfg.token !== p.token) throw new Error('fake channel: auth failed (token rejected)');
    let status: 'connected' | 'stopped' = 'connected';
    const buf: InboundMessage[] = [];
    let wake: (() => void) | null = null;
    const stop = () => {
      status = 'stopped';
      off();
      wake?.();
    };
    const off = p.listen((m) => {
      buf.push(m);
      wake?.();
    });
    ctx.signal.addEventListener('abort', stop, { once: true });
    const own = (place: string, id: string) => {
      const m = p.messages.find((x) => x.place === place && x.id === id);
      if (!m || m.from !== p.bot.id) throw new Error('fake channel: not our message');
      return m;
    };
    return {
      inbound: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (buf.length) yield buf.shift()!;
            else if (status === 'stopped') return;
            else await new Promise<void>((r) => (wake = r));
          }
        },
      },
      async send(place: string, msg: OutboundMessage) {
        const [first, ...rest] = splitText(msg.text, p.textLimit);
        const externalId = p.post(place, p.bot.id, first!);
        for (const part of rest) p.post(place, p.bot.id, part);
        return { externalId };
      },
      async edit(place: string, id: string, msg: OutboundMessage) {
        const [first, ...rest] = splitText(msg.text, p.textLimit);
        own(place, id).text = first!;
        for (const part of rest) p.post(place, p.bot.id, part);
      },
      async react() {},
      async listPlaces() {
        return p.placeInfo();
      },
      status: () => status,
      async close() {
        stop();
      },
    };
  }
}
