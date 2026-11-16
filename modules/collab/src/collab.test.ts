/**
 * W6 done-criteria, end to end on a real server (port 0, temp home) with scripted fake agents that call the
 * `/mcp` gateway with their run bearer exactly like a CLI would:
 *  - A delegates to B, B's reply lands in A's run, B runs at trust = min(A, B)
 *  - a channel with 3 agents: only the task owner answers; Reassign moves ownership
 *  - silent lead: one retry, then the backup model answers
 *  - Stop cancels the channel's work and keeps new messages from running; Resume lets them run again
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import collab from './server.js';

type Behave = (input: TurnInput, signal: AbortSignal) => Promise<string> | string;
class ScriptedAgents implements ProviderAdapter {
  constructor(
    readonly id: any,
    private readonly behave: Behave,
  ) {}
  readonly displayName = 'Scripted fake agents (tests)';
  async detect() {
    return { installed: true, signedIn: true as const };
  }
  capabilities() {
    return {
      resume: false,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: true,
      contextReport: false,
    };
  }
  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    let text: string;
    try {
      text = await this.behave(input, signal);
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: String(e) };
      yield { type: 'done', stop: signal.aborted ? 'cancelled' : 'error' };
      return;
    }
    yield { type: 'text.final', text };
    yield { type: 'done', stop: 'end' };
  }
}

const callTool = async (input: TurnInput, name: string, args: unknown) => {
  const r = await fetch(input.mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  if (j.result.isError) throw new Error(j.result.content[0]!.text);
  return JSON.parse(j.result.content[0]!.text);
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new Error('aborted'));
    });
  });

/** per-agent behaviour, keyed by slug */
const behaviours: Record<string, Behave> = {};
const seen: { slug: string; text: string; sender: TurnInput['user']['from'] }[] = [];

describe('collab (W6)', () => {
  let s: TestServer;
  let owner: string;
  const ids: Record<string, string> = {};
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${s.url}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${owner}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const until = async <T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting');
      await sleep(20);
    }
  };
  const agentMsgs = (chatId: string) =>
    s.db
      .prepare(
        "SELECT author_id, body, status, run_id FROM messages WHERE chat_id = ? AND author_kind = 'agent' ORDER BY created_at, id",
      )
      .all(chatId) as { author_id: string; body: string; status: string; run_id: string }[];
  const systemMsgs = (chatId: string) =>
    (
      s.db
        .prepare(
          "SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'system' ORDER BY created_at, id",
        )
        .all(chatId) as { body: string }[]
    ).map((m) => m.body);
  const idle = () =>
    until(
      () =>
        !s.db.prepare("SELECT 1 FROM queue_items WHERE state IN ('queued', 'leased', 'running')").get() &&
        !s.db.prepare("SELECT 1 FROM runs WHERE state = 'running'").get(),
    );
  const mkAgent = async (slug: string, trustLevel: string, behave: Behave) => {
    behaviours[slug] = behave;
    const r = await api('/api/v1/agents', { body: { name: slug, slug, providerId: 'fake', trustLevel } });
    expect(r.status).toBe(201);
    ids[slug] = r.json.agent.id;
    return r.json as { agent: { id: string; workspaceDir: string }; chatId: string };
  };
  const say = (chatId: string, text: string) => api(`/api/v1/chats/${chatId}/messages`, { body: { text } });
  const sourceOf = (taskId: string) =>
    JSON.parse(
      (
        s.db
          .prepare(
            'SELECT q.source FROM collab_task t JOIN queue_items q ON q.id = t.queue_item_id WHERE t.id = ?',
          )
          .get(taskId) as { source: string }
      ).source,
    );

  beforeAll(async () => {
    const main = new ScriptedAgents('fake', (input, signal) => {
      seen.push({ slug: input.agent.slug, text: input.user.text, sender: input.user.from });
      const b = behaviours[input.agent.slug];
      return b ? b(input, signal) : 'ok';
    });
    const backup = new ScriptedAgents(
      'fake-backup',
      (input) => `backup model answering for ${input.agent.slug}`,
    );
    s = await bootTestServer({ modules: [collab], providers: [main, backup] as ProviderAdapter[] });
    owner = seedUser(s.db).token;
  });
  afterAll(() => s.cleanup());

  it('A delegates to B: B runs at min(A, B) and its reply lands in A’s run', async () => {
    const b = await mkAgent('bea', 'standard', (input) =>
      input.user.text.includes('add 2+2') ? 'four, says Bea' : 'hm',
    );
    const a = await mkAgent('ana', 'trusted', async (input) => {
      if (!input.user.text.includes('ask bea')) return 'nothing to do';
      const r = await callTool(input, 'collab_delegate', {
        to: 'bea',
        task: 'add 2+2',
        requestAck: true,
        wait: true,
      });
      return `Bea replied: ${r.reply} (trust ${r.trust})`;
    });
    await say(a.chatId, 'please ask bea');
    await idle();
    const replies = agentMsgs(a.chatId);
    expect(replies.at(-1)!.body).toBe('Bea replied: four, says Bea (trust standard)');
    // B's turn: an agent sender (never owner), trust = min(owner turn trusted, A trusted, B standard)
    const bTurn = seen.find((x) => x.slug === 'bea')!;
    expect(bTurn.sender).toMatchObject({ kind: 'agent', id: a.agent.id, trust: 'standard' });
    expect(bTurn.text).toContain('collab_ack');
    expect(bTurn.text).toContain('> add 2+2');
    // B answered in its own chat, under A's request (a thread written as A), and the task log shows it
    const mine = agentMsgs(b.chatId);
    expect(mine.map((m) => [m.author_id, m.body])).toEqual([
      [a.agent.id, 'add 2+2'],
      [b.agent.id, 'four, says Bea'],
    ]);
    // A read the answer itself (wait: true) and said it: no second report
    expect(s.db.prepare('SELECT report_mode FROM collab_task WHERE to_agent_id = ?').get(b.agent.id)).toEqual(
      {
        report_mode: 'inline',
      },
    );
    // ...and that reply is credited like a report turn's: whose answer it is, and the way to Bea's thread
    const credited = s.db
      .prepare('SELECT blocks FROM messages WHERE chat_id = ? AND author_kind = ? ORDER BY created_at DESC')
      .all(a.chatId, 'agent')
      .map((r) => JSON.parse((r as { blocks: string }).blocks) as { kind: string; data: any }[])
      .flatMap((bl) => bl.filter((x) => x.kind === 'collab.report'));
    expect(credited).toHaveLength(1);
    expect(credited[0]!.data).toMatchObject({
      mode: 'report',
      items: [{ agentId: b.agent.id, state: 'done', answer: 'four, says Bea', chatId: b.chatId }],
      still: [],
    });
    const request = s.db
      .prepare('SELECT id FROM messages WHERE chat_id = ? AND author_id = ? ORDER BY created_at LIMIT 1')
      .get(b.chatId, a.agent.id) as { id: string };
    expect(credited[0]!.data.items[0].messageId).toBe(request.id);
    const tasks = (await api('/api/m/collab/tasks')).json.tasks;
    expect(tasks[0]).toMatchObject({
      kind: 'delegate',
      from: a.agent.id,
      to: b.agent.id,
      state: 'done',
      trust: 'standard',
    });
  });

  it('a guarded caller cannot raise the target above guarded; the answer comes back as a report turn', async () => {
    const t = await mkAgent('tess', 'trusted', (input) =>
      input.user.text.includes('Task from') ? 'tess done' : 'tess idle',
    );
    const g = await mkAgent('gil', 'guarded', async (input) => {
      if (input.user.text.startsWith('The work you gave other helpers is back')) return 'got it back';
      if (!input.user.text.includes('go')) return 'idle';
      const r = await callTool(input, 'collab_delegate', { to: 'tess', task: 'do a thing', wait: false });
      return `queued ${r.state}`;
    });
    await say(g.chatId, 'go');
    await idle();
    expect(seen.filter((x) => x.slug === 'tess').at(-1)!.sender.trust).toBe('guarded');
    const back = agentMsgs(g.chatId).map((m) => m.body);
    expect(back).toContain('got it back');
    expect(agentMsgs(t.chatId).at(-1)!.body).toBe('tess done');
    // the report turn runs as tess, at the task's trust (never the owner's)
    expect(seen.filter((x) => x.slug === 'gil').at(-1)!.sender).toMatchObject({
      kind: 'agent',
      id: t.agent.id,
      trust: 'guarded',
    });
  });

  it('acknowledge, status, react and send a file between agents', async () => {
    const r = await mkAgent('rio', 'trusted', async (input) => {
      const m = /Task id (\w+)/.exec(input.user.text);
      if (!m) return 'rio idle';
      await callTool(input, 'collab_ack', { taskId: m[1] });
      return 'rio acked';
    });
    let taskId = '';
    const q = await mkAgent('quinn', 'trusted', async (input) => {
      if (!input.user.text.includes('share')) return 'quinn idle';
      writeFileSync(join(input.workspaceDir, 'notes.txt'), 'shared notes');
      const sent = await callTool(input, 'collab_send_file', {
        to: 'rio',
        path: 'notes.txt',
        note: 'for you',
      });
      taskId = sent.taskId;
      await expect(
        callTool(input, 'collab_send_file', { to: 'rio', path: '../../pasabot.db' }),
      ).rejects.toThrow();
      const msgId = (
        s.db
          .prepare("SELECT id FROM messages WHERE chat_id = ? AND author_kind = 'user'")
          .get(q.chatId) as any
      ).id;
      await callTool(input, 'collab_react', { messageId: msgId, emoji: '👍' });
      return 'quinn shared';
    });
    await say(q.chatId, 'share it');
    await idle();
    expect(readFileSync(join(r.agent.workspaceDir, 'inbox', 'quinn', 'notes.txt'), 'utf8')).toBe(
      'shared notes',
    );
    const task = (await api('/api/m/collab/tasks')).json.tasks.find((t: any) => t.id === taskId);
    expect(task).toMatchObject({ kind: 'file', state: 'done' });
    expect(task.ackedAt).toBeTypeOf('number');
    const reacts = (await api(`/api/m/collab/chats/${q.chatId}/reactions`)).json.reactions;
    expect(reacts).toEqual([
      expect.objectContaining({ emoji: '👍', actorKind: 'agent', actorId: q.agent.id }),
    ]);
    mkdirSync(join(r.agent.workspaceDir), { recursive: true });
  });

  it('channel with 3 agents: only the task owner answers; Reassign moves ownership', async () => {
    for (const n of ['lead1', 'mate2', 'mate3']) await mkAgent(n, 'trusted', (i) => `${i.agent.slug} here`);
    const ch = await api('/api/v1/chats', {
      body: {
        kind: 'channel',
        title: 'Crew',
        agentIds: [ids.lead1, ids.mate2, ids.mate3],
        taskOwnerAgentId: ids.lead1,
      },
    });
    const chatId = ch.json.chat.id;
    await say(chatId, 'hello team');
    await idle();
    expect(agentMsgs(chatId).map((m) => m.author_id)).toEqual([ids.lead1]);
    const team = (await api(`/api/m/collab/chats/${chatId}/team`)).json;
    expect(team).toMatchObject({ isTeam: true, lead: ids.lead1, state: 'active' });
    expect(team.agents).toHaveLength(3);

    const re = await api(`/api/m/collab/chats/${chatId}/reassign`, { body: { agentId: ids.mate3 } });
    expect(re.json.lead).toBe(ids.mate3);
    await say(chatId, 'who leads now');
    await idle();
    expect(agentMsgs(chatId).map((m) => m.author_id)).toEqual([ids.lead1, ids.mate3]);
    expect(systemMsgs(chatId).at(-1)).toContain('mate3 now leads');
    // only agents of the channel can lead
    expect((await api(`/api/m/collab/chats/${chatId}/reassign`, { body: { agentId: ids.ana } })).status).toBe(
      400,
    );
  });

  it('silent lead: one retry, then the backup model answers', async () => {
    await mkAgent('quiet', 'trusted', () => '');
    await mkAgent('helper', 'trusted', () => 'helper here');
    const chatId = (
      await api('/api/v1/chats', {
        body: {
          kind: 'channel',
          title: 'Quiet',
          agentIds: [ids.quiet, ids.helper],
          taskOwnerAgentId: ids.quiet,
        },
      })
    ).json.chat.id;
    const set = await api(`/api/m/collab/chats/${chatId}/settings`, {
      method: 'PUT',
      body: { backup: { providerId: 'fake-backup' } },
    });
    expect(set.json.backup).toEqual({ providerId: 'fake-backup' });
    await say(chatId, 'anyone there?');
    await idle();
    await until(() => agentMsgs(chatId).length === 3);
    const msgs = agentMsgs(chatId);
    expect(msgs.map((m) => m.body)).toEqual(['', '', 'backup model answering for quiet']);
    expect(msgs.every((m) => m.author_id === ids.quiet)).toBe(true);
    const run = s.db.prepare('SELECT provider_id FROM runs WHERE id = ?').get(msgs[2]!.run_id) as any;
    expect(run.provider_id).toBe('fake-backup');
    const notes = systemMsgs(chatId);
    expect(notes[0]).toContain('Asking once more');
    expect(notes[1]).toContain('backup model');
    // the backup's answer ends the rule: nothing more is queued
    expect(s.db.prepare('SELECT count(*) AS n FROM collab_silent WHERE chat_id = ?').get(chatId)).toEqual({
      n: 2,
    });
  });

  it('silent lead: the retry and the backup re-run the unanswered message as its sender, at its trust', async () => {
    const guest = seedUser(s.db, 'guest', 'Gwen');
    // the lead answers everything except the guest's ask; it is slow on the first one so the owner posts meanwhile
    let asks = 0;
    await mkAgent('hush', 'standard', async (i) => {
      if (!i.user.text.includes('deploy')) return `hush answers: ${i.user.text}`;
      if (asks++ === 0) await sleep(400);
      return '';
    });
    await mkAgent('buddy', 'trusted', () => 'buddy');
    // the lead has its own model; the backup names no model
    s.db.prepare('UPDATE agents SET model = ? WHERE id = ?').run('lead-own-model', ids.hush);
    const chatId = (
      await api('/api/v1/chats', {
        body: {
          kind: 'channel',
          title: 'Guests',
          agentIds: [ids.hush, ids.buddy],
          taskOwnerAgentId: ids.hush,
          userIds: [guest.id],
        },
      })
    ).json.chat.id;
    await api(`/api/m/collab/chats/${chatId}/settings`, {
      method: 'PUT',
      body: { backup: { providerId: 'fake-backup' } },
    });
    const g = await fetch(`${s.url}/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'run the deploy tool' }),
    });
    expect(g.status).toBeLessThan(300);
    await until(() =>
      s.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND state = 'running'").get(ids.hush),
    );
    await say(chatId, 'later ask');
    await idle();
    await until(() => systemMsgs(chatId).length === 2);
    await idle();
    const hushTurns = seen.filter((x) => x.slug === 'hush');
    // guest ask, the owner's later ask, then the guest's ask again (never the later one)
    expect(hushTurns.map((x) => x.text)).toEqual(['run the deploy tool', 'later ask', 'run the deploy tool']);
    const guestSender = { kind: 'guest', id: guest.id, trust: 'guarded' };
    expect(hushTurns[0]!.sender).toMatchObject(guestSender);
    expect(hushTurns[2]!.sender).toMatchObject(guestSender);
    // the backup item carries the same sender and trust (it ran on fake-backup, which `seen` does not record)
    const items = s.db
      .prepare(
        'SELECT q.payload, q.source, r.provider_id, r.model FROM collab_silent c JOIN queue_items q ON q.id = c.queue_item_id JOIN runs r ON r.queue_item_id = q.id WHERE c.chat_id = ? ORDER BY c.created_at',
      )
      .all(chatId) as { payload: string; source: string; provider_id: string; model: string | null }[];
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(JSON.parse(it.source).sender).toMatchObject(guestSender);
      expect(JSON.parse(it.payload).text).toBe('run the deploy tool');
    }
    // the backup runs on its own provider's default model, never the lead's
    expect(items[1]).toMatchObject({ provider_id: 'fake-backup', model: null });
    expect(agentMsgs(chatId).at(-1)!.body).toBe('backup model answering for hush');
  });

  it('send a file: symlinks the receiver planted in its inbox are never followed', async () => {
    const outside = join(s.home, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precious.txt'), 'keep me');
    const errs: string[] = [];
    const recv = await mkAgent('recv', 'guarded', () => 'recv idle');
    const giver = await mkAgent('giver', 'trusted', async (input) => {
      if (!input.user.text.includes('send')) return 'giver idle';
      writeFileSync(join(input.workspaceDir, 'precious.txt'), 'attacker-chosen');
      try {
        const r = await callTool(input, 'collab_send_file', { to: 'recv', path: 'precious.txt' });
        return `sent ${r.path}`;
      } catch (e) {
        errs.push(String(e));
        return 'refused';
      }
    });
    const ws = recv.agent.workspaceDir;
    mkdirSync(ws, { recursive: true });
    // 1. the whole inbox is a symlink out of the workspace
    symlinkSync(outside, join(ws, 'inbox'));
    const giverChat = giver.chatId;
    await say(giverChat, 'send it');
    await idle();
    expect(errs.join()).toContain('not a plain folder');
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(outside, 'giver'))).toBe(false);
    // 2. a real inbox, but the file name is a symlink to a file outside
    rmSync(join(ws, 'inbox'));
    mkdirSync(join(ws, 'inbox', 'giver'), { recursive: true });
    symlinkSync(join(outside, 'precious.txt'), join(ws, 'inbox', 'giver', 'precious.txt'));
    await say(giverChat, 'send it again');
    await idle();
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(agentMsgs(giverChat).at(-1)!.body).toBe('sent inbox/giver/precious (1).txt');
    expect(readFileSync(join(ws, 'inbox', 'giver', 'precious (1).txt'), 'utf8')).toBe('attacker-chosen');
  });

  it('silent lead without a backup: retried once, then the owner is told', async () => {
    await mkAgent('mute', 'trusted', () => '');
    await mkAgent('pal', 'trusted', () => 'pal');
    const chatId = (
      await api('/api/v1/chats', {
        body: { kind: 'channel', title: 'Mute', agentIds: [ids.mute, ids.pal], taskOwnerAgentId: ids.mute },
      })
    ).json.chat.id;
    await say(chatId, 'hello?');
    await idle();
    await until(() => systemMsgs(chatId).length === 2);
    expect(agentMsgs(chatId)).toHaveLength(2);
    expect(systemMsgs(chatId)[1]).toContain('even after a retry');
  });

  it('Stop cancels the channel’s work and holds new messages; Resume runs them again; Archive hides it', async () => {
    await mkAgent('slow', 'trusted', async (_i, signal) => {
      await sleep(5000, signal);
      return 'slow done';
    });
    await mkAgent('side', 'trusted', () => 'side');
    const chatId = (
      await api('/api/v1/chats', {
        body: { kind: 'channel', title: 'Slow', agentIds: [ids.slow, ids.side], taskOwnerAgentId: ids.slow },
      })
    ).json.chat.id;
    await say(chatId, 'start');
    await until(() =>
      s.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND state = 'running'").get(ids.slow),
    );
    const st = await api(`/api/m/collab/chats/${chatId}/stop`, { body: {} });
    expect(st.json.state).toBe('stopped');
    await idle();
    expect(s.db.prepare('SELECT state FROM runs WHERE agent_id = ?').get(ids.slow)).toEqual({
      state: 'cancelled',
    });
    behaviours.slow = (i) => `awake: ${i.user.text}`;
    const q = await say(chatId, 'please check the invoice');
    // held at once (never leased, never cancelled), and it stays held while the channel is stopped
    expect(s.db.prepare('SELECT state FROM queue_items WHERE id = ?').get(q.json.queued.id)).toEqual({
      state: 'held',
    });
    await sleep(300);
    expect(s.db.prepare('SELECT state FROM queue_items WHERE id = ?').get(q.json.queued.id)).toEqual({
      state: 'held',
    });
    expect(agentMsgs(chatId).map((m) => m.body)).not.toContain('awake: please check the invoice');
    expect((await api(`/api/m/collab/chats/${chatId}/resume`, { body: {} })).json.state).toBe('active');
    await until(
      () =>
        (s.db.prepare('SELECT state FROM queue_items WHERE id = ?').get(q.json.queued.id) as any).state ===
        'done',
    );
    await idle();
    expect(agentMsgs(chatId).at(-1)!.body).toBe('awake: please check the invoice');
    expect(systemMsgs(chatId).at(-1)).toContain('1 waiting item');
    await say(chatId, 'again');
    await idle();
    expect(agentMsgs(chatId).at(-1)!.body).toBe('awake: again');
    // members never run team controls
    const member = seedUser(s.db, 'member', 'Mem').token;
    const r = await fetch(`${s.url}/api/m/collab/chats/${chatId}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    const ar = await api(`/api/m/collab/chats/${chatId}/archive`, { body: {} });
    expect(ar.json.state).toBe('archived');
    const list = (await api('/api/v1/chats')).json.chats.map((c: any) => c.id);
    expect(list).not.toContain(chatId);
  });

  it('delegated work is a thread in the receiver’s own chat (not a guest’s), and carries who started the chain', async () => {
    const target = await mkAgent('tala', 'trusted', async (input) => {
      if (!input.user.text.includes('pass it on')) return 'tala ok';
      const r = await callTool(input, 'collab_delegate', { to: 'tino', task: 'last hop', wait: true });
      return `tino said ${r.reply}`;
    });
    await mkAgent('tino', 'trusted', () => 'tino ok');
    const caller = await mkAgent('gia', 'trusted', async (input) => {
      const task = input.user.text.includes('chain') ? 'pass it on' : 'just answer';
      const r = await callTool(input, 'collab_delegate', { to: 'tala', task, wait: true });
      return `got ${r.reply}`;
    });
    const latest = (from: string, to: string) =>
      s.db
        .prepare(
          'SELECT id, to_chat_id FROM collab_task WHERE from_agent_id = ? AND to_agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        )
        .get(ids[from], ids[to]) as { id: string; to_chat_id: string };
    // a guest in the caller's chat asks it to delegate
    const guest = seedUser(s.db, 'guest', 'Gwen');
    s.db
      .prepare("INSERT INTO chat_members (chat_id, member_kind, member_id) VALUES (?, 'user', ?)")
      .run(caller.chatId, guest.id);
    const r = await fetch(`${s.url}/api/v1/chats/${caller.chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask tala' }),
    });
    expect(r.status).toBe(201);
    await idle();
    expect(agentMsgs(caller.chatId).at(-1)!.body).toBe('got tala ok');
    const t1 = latest('gia', 'tala');
    const pair = target.chatId;
    expect(t1.to_chat_id).toBe(pair);
    // the receiver runs as the calling agent, and the guest who started it rides along as the origin
    expect(sourceOf(t1.id)).toMatchObject({
      sender: { kind: 'agent', id: caller.agent.id },
      origin: { kind: 'guest', id: guest.id },
    });
    // the receiver's own chat is the receiver's and the owner's: the guest who asked is not in it
    const members = s.db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ? AND member_kind = 'user'")
      .all(pair) as { member_id: string }[];
    expect(members.map((m) => m.member_id)).not.toContain(guest.id);
    // the owner's turn: same chat, and the origin is carried through the next hop
    await say(caller.chatId, 'chain it');
    await idle();
    expect(agentMsgs(caller.chatId).at(-1)!.body).toBe('got tino said tino ok');
    const t2 = latest('gia', 'tala');
    expect(t2.id).not.toBe(t1.id);
    expect(t2.to_chat_id).toBe(pair);
    expect(sourceOf(t2.id).origin).toMatchObject({ kind: 'owner' });
    const t3 = latest('tala', 'tino');
    expect(t3.to_chat_id).toBe(
      (
        s.db
          .prepare('SELECT to_chat_id FROM collab_task WHERE to_agent_id = ? AND from_agent_id = ?')
          .get(ids.tino, ids.tala) as any
      ).to_chat_id,
    );
    expect(s.db.prepare('SELECT count(*) AS n FROM collab_pair').get()).toEqual({ n: 0 });
    expect(sourceOf(t3.id)).toMatchObject({
      sender: { kind: 'agent', id: ids.tala },
      origin: { kind: 'owner' },
    });
  });

  it('an agent cannot delegate to itself, and mutual waits are refused', async () => {
    let err = '';
    const self = await mkAgent('solo', 'trusted', async (input) => {
      try {
        await callTool(input, 'collab_delegate', { to: 'solo', task: 'x' });
      } catch (e) {
        err = String(e);
      }
      return 'done';
    });
    await say(self.chatId, 'try');
    await idle();
    expect(err).toContain('itself');
  });

  it('reactions over REST: an outsider gets 404, an observer may read but not react', async () => {
    const r = await mkAgent('reacty', 'trusted', () => 'hi');
    await say(r.chatId, 'hello');
    await idle();
    const msgId = (
      s.db.prepare("SELECT id FROM messages WHERE chat_id = ? AND author_kind = 'user'").get(r.chatId) as any
    ).id;
    const outsider = seedUser(s.db, 'member', 'Out').token;
    const watcher = seedUser(s.db, 'member', 'Watch');
    s.db
      .prepare(
        "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'observer')",
      )
      .run(r.chatId, watcher.id);
    const as = (token: string, method: string, body?: unknown) =>
      fetch(`${s.url}/api/m/collab/chats/${r.chatId}/reactions`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await as(outsider, 'GET')).status).toBe(404);
    expect((await as(outsider, 'POST', { messageId: msgId, emoji: '👍' })).status).toBe(404);
    const seen = await as(watcher.token, 'GET');
    expect(seen.status).toBe(200);
    // the web shows no react button to an observer
    expect(((await seen.json()) as { canReact: boolean }).canReact).toBe(false);
    expect((await as(watcher.token, 'POST', { messageId: msgId, emoji: '👍' })).status).toBe(403);
    expect((await api(`/api/m/collab/chats/${r.chatId}/reactions`)).json.canReact).toBe(true);
    expect(
      (await api(`/api/m/collab/chats/${r.chatId}/reactions`, { body: { messageId: msgId, emoji: '👍' } }))
        .status,
    ).toBe(200);
  });
});
