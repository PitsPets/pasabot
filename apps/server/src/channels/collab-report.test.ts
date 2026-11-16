/**
 * ws/threads review: a person on a chat app (Telegram, Discord) asks a helper something it hands to another helper.
 * The answer comes back as the asker's report turn, later: that report (or the server's own card when the asker
 * cannot give one) goes out to the chat app too, never only to the web app.
 */
import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelsModule } from '../../../../modules/channels/src/server.js';
import collab from '../../../../modules/collab/src/server.js';
import {
  bootTestServer,
  FakeChannel,
  FakeChannelPlatform,
  seedAgent,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

type Behave = (input: TurnInput) => Promise<string> | string;
const behaviours: Record<string, Behave> = {};
class Scripted implements ProviderAdapter {
  readonly id = 'fake' as never;
  readonly displayName = 'Scripted (tests)';
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
  async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    let text: string;
    try {
      text = await (behaviours[input.agent.slug] ?? (() => 'ok'))(input);
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: String(e) };
      yield { type: 'done', stop: 'error' };
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
const isWake = (i: TurnInput) => i.user.text.startsWith('The work you gave other helpers');
const until = async <T>(f: () => T | undefined | null | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup().catch(() => {});
  open = [];
});

async function setup() {
  const p = new FakeChannelPlatform();
  const s = await bootTestServer({
    modules: [createChannelsModule(), collab],
    providers: [new Scripted()],
    channels: [new FakeChannel(p)],
    channelRuntime: { backoffBaseMs: 20, backoffMaxMs: 100, editMs: 5, statusPollMs: 20, previewMax: 60 },
    dispatcher: { pollMs: 5 },
  });
  open.push(s);
  const owner = seedUser(s.db);
  const mayumi = seedAgent(s.db, { slug: 'mayumi', trust: 'trusted' });
  seedAgent(s.db, { slug: 'ligaya', trust: 'trusted' });
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${s.url}/api/m/channels${path}`, {
      method,
      headers: {
        authorization: `Bearer ${owner.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const r = await api('POST', '/bindings', { kind: 'fake', agentId: mayumi, secrets: { token: p.token } });
  expect(r.status, await r.clone().text()).toBe(201);
  const binding = ((await r.json()) as { binding: { id: string } }).binding.id;
  await until(
    () =>
      (s.db.prepare('SELECT status FROM channels_binding WHERE id = ?').get(binding) as { status: string })
        .status === 'connected',
  );
  const { code } = (await (await api('POST', `/bindings/${binding}/link`)).json()) as { code: string };
  await p.deliver({ from: 'owner', place: 'dm', text: `/link ${code}` });
  await until(() => p.botTexts(p.places.dm).some((t) => t.startsWith('Linked.')));
  return { s, p };
}

describe('a helper’s report reaches the chat app the question came from', () => {
  it('the report turn of a chat-app question answers in the chat app', async () => {
    const { p } = await setup();
    behaviours.ligaya = () => 'twelve pens';
    behaviours.mayumi = async (i) => {
      if (isWake(i)) return 'Sabi ni Ligaya: twelve pens';
      if (i.user.from.kind === 'agent') return 'idle';
      await callTool(i, 'collab_delegate', { to: 'ligaya', task: 'Count the pens' });
      return 'Tatanungin ko si Ligaya.';
    };
    await p.deliver({ from: 'owner', place: 'dm', text: 'ilan ang ballpen?' });
    await until(() => p.botTexts(p.places.dm).some((t) => t.includes('Sabi ni Ligaya: twelve pens')));
    expect(p.botTexts(p.places.dm).filter((t) => t.includes('Sabi ni Ligaya'))).toHaveLength(1);
  });

  it('the server’s own card goes out too when the asker cannot report', async () => {
    const { p } = await setup();
    behaviours.ligaya = () => 'twelve pens';
    behaviours.mayumi = async (i) => {
      if (isWake(i)) throw new Error('no brain right now');
      if (i.user.from.kind === 'agent') return 'idle';
      await callTool(i, 'collab_delegate', { to: 'ligaya', task: 'Count the pens' });
      return 'Tatanungin ko si Ligaya.';
    };
    await p.deliver({ from: 'owner', place: 'dm', text: 'ilan ang ballpen?' });
    await until(() => p.botTexts(p.places.dm).some((t) => t.includes('finished: twelve pens')));
    expect(p.botTexts(p.places.dm).filter((t) => t.includes('finished: twelve pens'))).toHaveLength(1);
  });
});
