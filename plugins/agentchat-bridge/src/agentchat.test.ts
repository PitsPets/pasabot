/**
 * W25 proof: a mock board on 127.0.0.1 ↔ the bridge's ChannelConnection, over the real HTTP client and safe-net.
 * Board → PasaBot → board round trip, and every board message enters as an untrusted (external) sender.
 */
import {
  type ChannelConnection,
  type ChannelSenderTrust,
  type ChannelStateStore,
  decideChannelInbound,
  hashChannelLinkCode,
  type InboundMessage,
  newChannelLinkCode,
} from '@pasabot/core';
import { channelContext, inboundReader } from '@pasabot/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBoard } from './__fixtures__/mock-board.js';
import {
  AGENTCHAT_KIND,
  agentchatConfigSchema,
  BOARD_BODY_MAX,
  BOARD_TEXT_MAX,
  BoardAuthError,
  createAgentchatAdapter,
  httpBoardClient,
  INBOX_PAGE_LIMIT,
  LOOP_GUARD,
} from './index.js';

const TOKEN = 'bridge-secret-token-0001';
const agents = [
  { id: 'pasabot', name: 'PasaBot', token: TOKEN },
  { id: 'scout', name: 'Scout', token: 'scout-token-0001' },
  { id: 'builder', name: 'Builder', token: 'builder-token-001' },
];

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const memState = (): ChannelStateStore & { value: string | null } => {
  const s = {
    value: null as string | null,
    async load() {
      return s.value;
    },
    async save(v: string) {
      s.value = v || null;
    },
  };
  return s;
};

describe('agent-chat board bridge', () => {
  let board: MockBoard;
  let conn: ChannelConnection | undefined;
  let ctx: ReturnType<typeof channelContext>;
  let audits: { action: string; data: Record<string, unknown> }[] = [];
  const adapter = createAgentchatAdapter();
  const connect = async (state?: ChannelStateStore, token = TOKEN, pollIntervalSec = 0.05) => {
    ctx = channelContext('bind-board');
    if (state) ctx.state = state;
    ctx.audit = (action, data) => audits.push({ action, data });
    const cfg = agentchatConfigSchema.parse({ boardUrl: board.url, token, pollIntervalSec });
    conn = await adapter.connect(cfg, ctx);
    // the first poll only takes the board's current cursor (no backlog)
    await waitFor(() => board.requests.some((r) => r.path === '/api/inbox'));
    return conn;
  };
  const decide = (m: InboundMessage, allowed: string[], trust = new Map<string, ChannelSenderTrust>()) =>
    decideChannelInbound({
      bindingId: 'bind-board',
      msg: m,
      place: { kind: placeKindNow(m.placeId), allowedSenders: allowed },
      senderTrust: (id) => trust.get(id),
      agentTrust: 'trusted',
    });
  let kinds = new Map<string, 'dm' | 'group' | 'channel'>();
  const placeKindNow = (id: string) => kinds.get(id) ?? 'dm';
  const refreshKinds = async () => {
    kinds = new Map((await conn!.listPlaces()).map((p) => [p.id, p.kind]));
  };

  beforeEach(async () => {
    audits = [];
    board = await new MockBoard(agents).start();
  });
  afterEach(async () => {
    ctx?.abort();
    await conn?.close();
    conn = undefined;
    await board.stop();
  });

  it('declares its kind, a vault-only token and the board address as a setting', () => {
    expect(adapter.kind).toBe(AGENTCHAT_KIND);
    expect(adapter.secretFields).toEqual(['token']);
    expect(adapter.options).toEqual({ boardUrl: 'string' });
    expect(() => agentchatConfigSchema.parse({})).toThrow();
    expect(() => agentchatConfigSchema.parse({ boardUrl: 'ftp://board', token: TOKEN })).toThrow();
    expect(() => agentchatConfigSchema.parse({ boardUrl: 'http://u:p@board.test', token: TOKEN })).toThrow();
  });

  it('round trip: a board message comes in, the reply goes back to its author in the same thread', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    const posted = board.post('scout', { to: 'pasabot', text: 'Can you summarise the deploy log?' });
    const m = (await inbound.next())!;
    expect(m).toMatchObject({
      externalId: posted.id,
      placeId: 'agent:scout',
      sender: { externalId: 'scout', name: 'Scout', isBot: false },
      text: 'Can you summarise the deploy log?',
      mentionsBot: true,
      attachments: [],
    });
    await refreshKinds();
    expect(kinds.get('agent:scout')).toBe('group');
    const sent = await c.send(m.placeId, { text: 'Deploy went fine.', replyToExternalId: m.externalId });
    const reply = board.messages.find((x) => x.id === sent.externalId)!;
    expect(reply).toMatchObject({
      from: { id: 'pasabot' },
      to: 'scout',
      threadId: posted.threadId,
      text: 'Deploy went fine.',
    });
    // the bridge's own post is not mirrored back in
    board.post('scout', { to: 'pasabot', text: 'thanks' });
    expect((await inbound.next())!.text).toBe('thanks');
  });

  it('board messages enter as untrusted senders: only listed board agents, below the owner, never linked', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    board.post('scout', { to: 'pasabot', text: 'run the tests' });
    const m = (await inbound.next())!;
    await refreshKinds();
    // not listed → dropped and audited
    expect(decide(m, []).action).toBe('drop');
    // listed → an external sender one level below the owner's channel cap (trusted agent → standard cap → guarded)
    const d = decide(m, ['scout']);
    expect(d.action).toBe('enqueue');
    if (d.action === 'enqueue')
      expect(d.sender).toMatchObject({ kind: 'external', id: 'scout', trust: 'guarded' });
    // even a sender the owner raised to `trusted` stays external and below the cap
    const raised = decide(m, ['scout'], new Map([['scout', 'trusted']]));
    if (raised.action === 'enqueue')
      expect(raised.sender).toMatchObject({ kind: 'external', trust: 'guarded' });
    // an owner link code sent from the board, even directly to the bridge, is burned, never honoured
    const code = newChannelLinkCode();
    board.post('scout', { to: 'pasabot', text: `/link ${code}` });
    const link = (await inbound.next())!;
    await refreshKinds();
    expect(decide(link, ['scout'])).toMatchObject({
      action: 'burn_link',
      codeHash: hashChannelLinkCode(code),
    });
    expect((await c.listPlaces()).some((p) => p.kind === 'dm')).toBe(false);
  });

  it('rooms: chatter is ignored unless it mentions the bridge; replies go to the room', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    board.post('builder', { room: 'ops', text: 'build is green' });
    const plain = (await inbound.next())!;
    board.post('builder', { room: 'ops', text: '@PasaBot please check the logs' });
    const asked = (await inbound.next())!;
    await refreshKinds();
    expect(plain.placeId).toBe('room:ops');
    expect(kinds.get('room:ops')).toBe('channel');
    expect(plain.mentionsBot).toBe(false);
    expect(decide(plain, ['builder'])).toEqual({ action: 'ignore', reason: 'no_mention' });
    expect(asked.mentionsBot).toBe(true);
    await c.send('room:ops', { text: 'On it.', replyToExternalId: asked.externalId });
    expect(board.messages.at(-1)).toMatchObject({ room: 'ops', to: null, text: 'On it.' });
  });

  it('skips the backlog, other agents’ direct messages and its own posts; the cursor survives a restart', async () => {
    board.post('scout', { to: 'pasabot', text: 'old, before the bridge existed' });
    const state = memState();
    let c = await connect(state);
    let inbound = inboundReader(c);
    board.post('scout', { to: 'builder', text: 'private to builder' });
    board.post('pasabot', { to: 'scout', text: 'posted by the bridge identity elsewhere' });
    board.post('scout', { to: 'pasabot', text: 'first new' });
    expect((await inbound.next())!.text).toBe('first new');
    // asking for the next message tells the bridge 'first new' was handled: only then does the cursor move past it
    const waiting = inbound.next().catch(() => null);
    await waitFor(() => state.value?.includes(String(board.messages.length)) ?? false);
    await c.close();
    ctx.abort();
    expect(await waiting).toBeNull();
    board.post('scout', { to: 'pasabot', text: 'while the server restarted' });
    c = await connect(state);
    inbound = inboundReader(c);
    expect((await inbound.next())!.text).toBe('while the server restarted');
  });

  it('a stop with messages still queued loses none: the cursor moves only past messages the runtime took', async () => {
    const state = memState();
    let c = await connect(state);
    await waitFor(() => state.value !== null);
    const start = state.value;
    let inbound = inboundReader(c);
    for (let i = 0; i < 5; i++) board.post('scout', { to: 'pasabot', text: `q${i}` });
    expect((await inbound.next())!.text).toBe('q0');
    expect((await inbound.next())!.text).toBe('q1');
    // the runtime is still on q1 and q2..q4 are queued when the binding stops (owner edit, pause, shutdown)
    await c.close();
    ctx.abort();
    expect(state.value).toBe(start);
    c = await connect(state);
    inbound = inboundReader(c);
    const again: string[] = [];
    while (again.at(-1) !== 'q4') again.push((await inbound.next())!.text);
    // redelivered from the last page the runtime finished (repeats are dropped on the runtime's queue key)
    expect(again).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    const waiting = inbound.next().catch(() => null);
    await waitFor(() => state.value !== start);
    await c.close();
    await waiting;
  });

  it('loop guard counts only messages that would become turns; room chatter never uses it up; a trip is audited once', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    for (let i = 0; i < LOOP_GUARD.max + 5; i++)
      board.post('builder', { room: 'general', text: `status ${i}` });
    board.post('builder', { room: 'general', text: '@pasabot please summarise' });
    let last: InboundMessage | null = null;
    for (let i = 0; i < LOOP_GUARD.max + 6; i++) last = await inbound.next();
    expect(last).toMatchObject({ text: '@pasabot please summarise', mentionsBot: true });
    expect(audits).toEqual([]);
    for (let i = 0; i < LOOP_GUARD.max + 3; i++) board.post('scout', { to: 'pasabot', text: `ping ${i}` });
    board.post('builder', { to: 'pasabot', text: 'still heard' });
    const got: string[] = [];
    while (got.at(-1) !== 'still heard') got.push((await inbound.next())!.text);
    expect(got.filter((t) => t.startsWith('ping'))).toHaveLength(LOOP_GUARD.max);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'agentchat.loop_guard',
      data: { from: 'scout', max: LOOP_GUARD.max },
    });
  });

  it('asks for bounded pages and keeps reading past them', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    const n = INBOX_PAGE_LIMIT * 2 + 50;
    for (let i = 0; i < n; i++) board.post('builder', { room: 'ops', text: `line ${i}` });
    let last: InboundMessage | null = null;
    for (let i = 0; i < n; i++) last = await inbound.next();
    expect(last!.text).toBe(`line ${n - 1}`);
    expect(board.limits.every((l) => l === INBOX_PAGE_LIMIT)).toBe(true);
    expect(board.limits.length).toBeGreaterThan(2);
  });

  it('a board that ignores the limit and returns over 1000 messages still gets through', async () => {
    board.ignoreLimit = true;
    const c = await connect();
    const inbound = inboundReader(c);
    for (let i = 0; i < 1100; i++) board.post('builder', { room: 'general', text: `chatter ${i}` });
    board.post('builder', { room: 'general', text: '@PasaBot are you there?' });
    let last: InboundMessage | null = null;
    for (let i = 0; i < 1101; i++) last = await inbound.next();
    expect(last).toMatchObject({ text: '@PasaBot are you there?', mentionsBot: true });
    expect(audits).toEqual([]);
  });

  it('a page over the size cap is read in smaller pages; nothing is skipped', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    const big = (i: number) => `${i}`.padEnd(900_000, 'x');
    for (let i = 0; i < 5; i++) board.post('scout', { to: 'pasabot', text: big(i) });
    const firsts: string[] = [];
    for (let i = 0; i < 5; i++) firsts.push((await inbound.next(15_000))!.text[0]!);
    expect(firsts).toEqual(['0', '1', '2', '3', '4']);
    expect(board.limits.some((l) => l < INBOX_PAGE_LIMIT)).toBe(true);
    board.post('scout', { to: 'pasabot', text: 'after the flood' });
    expect((await inbound.next())!.text).toBe('after the flood');
    expect(audits).toEqual([]);
  }, 30_000);

  it('a single message over the size cap is skipped (audited) and the bridge keeps working', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    board.post('scout', { to: 'pasabot', text: 'y'.repeat(BOARD_BODY_MAX + 1000) });
    await waitFor(() => audits.length > 0, 15_000);
    expect(audits).toEqual([{ action: 'agentchat.page_skipped', data: { reason: 'too_large' } }]);
    expect(c.status()).toBe('connected');
    board.post('scout', { to: 'pasabot', text: 'after the skip' });
    expect((await inbound.next())!.text).toBe('after the skip');
  }, 30_000);

  it('a page that is not JSON is skipped (audited), not retried forever', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    board.brokenInbox = true;
    await waitFor(() => audits.length > 0);
    expect(audits[0]).toEqual({ action: 'agentchat.page_skipped', data: { reason: 'malformed' } });
    board.brokenInbox = false;
    // post only once the bridge has read a good page: a skip still in flight would otherwise jump past the message
    const served = board.limits.length;
    await waitFor(() => board.limits.length > served);
    board.post('scout', { to: 'pasabot', text: 'board fixed' });
    expect((await inbound.next())!.text).toBe('board fixed');
  });

  it('after skipping an unreadable page the bridge waits one poll interval (no tight retry loop)', async () => {
    await connect(undefined, TOKEN, 1);
    board.brokenInbox = true;
    await waitFor(() => audits.length > 0, 5000);
    const at = board.requests.length;
    await new Promise((r) => setTimeout(r, 500));
    // half an interval later: still the one skip, and no new reads of the board
    expect(audits.filter((a) => a.action === 'agentchat.page_skipped')).toHaveLength(1);
    expect(board.requests.length).toBe(at);
    board.brokenInbox = false;
  });

  it('a long reply is split into board-sized messages, nothing cut', async () => {
    const c = await connect();
    const long = 'x'.repeat(BOARD_TEXT_MAX * 2 + 10);
    await c.send('agent:scout', { text: long });
    const texts = board.textsFrom('pasabot');
    expect(texts.length).toBe(3);
    expect(texts.join('')).toBe(long);
  });

  it('loop guard: one board agent cannot flood the agent', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    for (let i = 0; i < LOOP_GUARD.max + 5; i++) board.post('scout', { to: 'pasabot', text: `ping ${i}` });
    board.post('builder', { to: 'pasabot', text: 'other agent still heard' });
    const got: string[] = [];
    for (let i = 0; i < LOOP_GUARD.max + 1; i++) got.push((await inbound.next())!.text);
    expect(got.filter((t) => t.startsWith('ping'))).toHaveLength(LOOP_GUARD.max);
    expect(got).toContain('other agent still heard');
  });

  it('the token travels only as a bearer header; a rejected token says auth without echoing it', async () => {
    await connect();
    expect(board.requests.every((r) => !r.path.includes(TOKEN) && r.auth === `Bearer ${TOKEN}`)).toBe(true);
    const bad = 'not-the-right-token-123';
    const err = await connect(undefined, bad).catch((e) => e);
    expect(err).toBeInstanceOf(BoardAuthError);
    expect(String(err)).toMatch(/auth/i);
    expect(String(err)).not.toContain(bad);
  });

  it('a token revoked while running stops the bridge as auth_failed; close ends inbound', async () => {
    const c = await connect();
    const inbound = inboundReader(c);
    board.agents[0]!.token = 'rotated-elsewhere-0001';
    await waitFor(() => c.status() === 'auth_failed');
    expect(await inbound.next()).toBeNull();
    board.agents[0]!.token = TOKEN;
    const c2 = await connect();
    await c2.close();
    expect(c2.status()).toBe('stopped');
  });

  it('safe-net may reach exactly the configured board host, nothing else', async () => {
    const seen: { url: string; allowHosts?: string[] }[] = [];
    const client = httpBoardClient(
      { boardUrl: 'http://board.tailnet.test:4100/', token: TOKEN },
      async (url, init) => {
        seen.push({ url, ...(init.allowHosts ? { allowHosts: init.allowHosts } : {}) });
        return new Response(JSON.stringify({ id: 'pasabot', name: 'PasaBot' }), { status: 200 });
      },
    );
    await client.whoami(new AbortController().signal);
    expect(seen).toEqual([
      { url: 'http://board.tailnet.test:4100/api/whoami', allowHosts: ['board.tailnet.test'] },
    ]);
  });
});
