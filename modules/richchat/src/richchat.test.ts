import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import type { MessageDTO } from '@pasabot/protocol';
import { bootTestServer, seedAgent, seedChat, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK } from './blocks.js';
import { createRichchatModule } from './server.js';

const MB = 1024 * 1024;

/** A provider that, mid-turn, calls one gateway tool with its run bearer and replies with the result. */
class ToolProbe implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'probe';
  next: { name: string; args: unknown } = { name: 'richchat_ask', args: {} };
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
      subagentEvents: false,
      contextReport: false,
    };
  }
  async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    const r = await fetch(input.mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: this.next.name, arguments: this.next.args },
      }),
    });
    const j = (await r.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    yield { type: 'text.final', text: `tool said: ${j.result?.content[0]?.text ?? JSON.stringify(j)}` };
    yield { type: 'done', stop: 'end' };
  }
}

describe('richchat + search (W7)', () => {
  let s: TestServer;
  const probe = new ToolProbe();
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let agent: string;
  let chat: string;
  const req = (path: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${s.url}${path}`, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  const messages = async (chatId: string) =>
    (
      (await (await req(`/api/v1/chats/${chatId}/messages`, owner.token)).json()) as {
        messages: MessageDTO[];
      }
    ).messages;
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [probe], modules: [createRichchatModule()] });
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    agent = seedAgent(s.db, { trust: 'standard' });
    chat = seedChat(s.db, { userIds: [owner.id, member.id], agentIds: [agent] });
  });
  afterAll(() => s.cleanup());

  it('an agent asks a 3-option question; the owner taps one; the answer returns to the run', async () => {
    probe.next = {
      name: 'richchat_ask',
      args: { question: 'Which plan?', options: ['Basic', 'Plus', 'Max'] },
    };
    expect(
      (await req(`/api/v1/chats/${chat}/messages`, owner.token, { method: 'POST', json: { text: 'go' } }))
        .status,
    ).toBe(201);
    const card = await waitFor(async () =>
      (await messages(chat)).find((m) => m.blocks[0]?.kind === 'richchat.ask'),
    );
    const data = card.blocks[0]!.data as {
      promptId: string;
      state: string;
      options: { id: string; label: string }[];
    };
    expect(data.state).toBe('open');
    expect(data.options.map((o) => o.label)).toEqual(['Basic', 'Plus', 'Max']);
    // a wrong option is refused; the right one is delivered to the waiting tool
    expect(
      (
        await req(`/api/m/richchat/prompts/${data.promptId}/answer`, owner.token, {
          method: 'POST',
          json: { optionIds: ['o9'] },
        })
      ).status,
    ).toBe(400);
    const ok = await req(`/api/m/richchat/prompts/${data.promptId}/answer`, owner.token, {
      method: 'POST',
      json: { optionIds: [data.options[1]!.id] },
    });
    expect(await ok.json()).toEqual({ ok: true, delivered: true });
    const reply = await waitFor(async () =>
      (await messages(chat)).find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said')),
    );
    expect(reply.body).toContain('"choices":["Plus"]');
    const after = (await messages(chat)).find((m) => m.id === card.id)!;
    expect(after.blocks[0]!.data).toMatchObject({ state: 'answered', answer: { labels: ['Plus'] } });
    // a second tap is refused
    const again = await req(`/api/m/richchat/prompts/${data.promptId}/answer`, owner.token, {
      method: 'POST',
      json: { optionIds: ['o1'] },
    });
    expect(again.status).toBe(409);
  });

  it('a form is validated against its fields and the values return to the run', async () => {
    probe.next = {
      name: 'richchat_form',
      args: {
        title: 'Trip',
        fields: [
          { name: 'city', label: 'City', type: 'select', options: ['Cebu', 'Davao'], required: true },
          { name: 'nights', label: 'Nights', type: 'number', min: 1, max: 14 },
        ],
      },
    };
    await req(`/api/v1/chats/${chat}/messages`, member.token, { method: 'POST', json: { text: 'plan' } });
    const card = await waitFor(async () =>
      (await messages(chat)).find(
        (m) =>
          m.blocks[0]?.kind === 'richchat.form' && (m.blocks[0].data as { state: string }).state === 'open',
      ),
    );
    const id = (card.blocks[0]!.data as { promptId: string }).promptId;
    const answer = (values: unknown) =>
      req(`/api/m/richchat/prompts/${id}/answer`, member.token, { method: 'POST', json: { values } });
    expect((await answer({ city: 'Manila' })).status).toBe(400);
    expect((await answer({ city: 'Cebu', nights: 99 })).status).toBe(400);
    expect((await answer({ city: 'Cebu', nights: '3' })).status).toBe(200);
    const reply = await waitFor(async () =>
      (await messages(chat)).find((m) => m.body.includes('"values":{"city":"Cebu","nights":3}')),
    );
    expect(reply.authorKind).toBe('agent');
    // typed values reach the run labelled as untrusted data, with who submitted them
    expect(reply.body).toContain('"untrusted":true');
    expect(reply.body).toContain(`"by":{"id":"${member.id}","kind":"member","trust":"standard"}`);
  });

  it("a member cannot answer the owner's run; observers cannot answer at all; the owner can", async () => {
    const watcher = seedUser(s.db, 'member', 'Watcher');
    s.db
      .prepare(
        "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'observer')",
      )
      .run(chat, watcher.id);
    probe.next = {
      name: 'richchat_ask',
      args: { question: 'Delete the old backups?', options: ['Yes', 'No'] },
    };
    const before = (await messages(chat)).length;
    await req(`/api/v1/chats/${chat}/messages`, owner.token, { method: 'POST', json: { text: 'clean up' } });
    const card = await waitFor(async () =>
      (await messages(chat)).slice(before).find((m) => m.blocks[0]?.kind === 'richchat.ask'),
    );
    const id = (card.blocks[0]!.data as { promptId: string }).promptId;
    const tap = (token: string, optionId: string) =>
      req(`/api/m/richchat/prompts/${id}/answer`, token, { method: 'POST', json: { optionIds: [optionId] } });
    const byMember = await tap(member.token, 'o1');
    expect(byMember.status).toBe(403);
    expect(((await byMember.json()) as { error: string }).error).toBe('not_your_prompt');
    const byObserver = await tap(watcher.token, 'o1');
    expect(byObserver.status).toBe(403);
    expect(((await byObserver.json()) as { error: string }).error).toBe('read_only');
    // still open: nothing reached the run
    expect(
      ((await (await req(`/api/m/richchat/prompts/${id}`, owner.token)).json()) as { state: string }).state,
    ).toBe('open');
    expect((await tap(owner.token, 'o2')).status).toBe(200);
    const reply = await waitFor(async () =>
      (await messages(chat))
        .slice(before)
        .find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said')),
    );
    expect(reply.body).toContain('"choices":["No"]');
    expect(reply.body).toContain(`"by":{"id":"${owner.id}","kind":"owner","trust":"trusted"}`);
  });

  it('an HTML block is served only from the sites origin, sandboxed, and the app refuses that origin', async () => {
    probe.next = {
      name: 'richchat_html',
      args: { title: 'Chart', html: '<script>fetch("/api/v1/chats")</script>' },
    };
    await req(`/api/v1/chats/${chat}/messages`, owner.token, { method: 'POST', json: { text: 'chart' } });
    const card = await waitFor(async () =>
      (await messages(chat)).find((m) => m.blocks[0]?.kind === 'richchat.html'),
    );
    const url = (card.blocks[0]!.data as { url: string }).url;
    expect(new URL(url).origin).toBe(new URL(s.sitesUrl).origin);
    expect(new URL(url).origin).not.toBe(new URL(s.url).origin);
    const page = await fetch(url);
    expect(page.headers.get('content-security-policy')).toMatch(/sandbox allow-scripts/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    // a credentialed write from the sites origin is refused (Origin check), even with a valid session
    const sitesOrigin = new URL(s.sitesUrl).origin;
    const forged = await fetch(`${s.url}/api/v1/chats/${chat}/messages`, {
      method: 'POST',
      headers: {
        origin: sitesOrigin,
        cookie: `pasabot_session=${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'from the iframe' }),
    });
    expect(forged.status).toBe(403);
  });

  it('resumable upload: 120 MB is refused up front, a chunked file survives a wrong offset and lands in the BlobStore', async () => {
    const big = await req('/api/m/richchat/uploads', owner.token, {
      method: 'POST',
      json: { name: 'big.zip', size: 120 * MB },
    });
    expect(big.status).toBe(413);
    const size = CHUNK * 2 + 1234;
    const bytes = Buffer.alloc(size, 3);
    const start = (await (
      await req('/api/m/richchat/uploads', owner.token, {
        method: 'POST',
        json: { name: 'clip.mp4', mime: 'video/mp4', size },
      })
    ).json()) as { id: string; chunk: number };
    const put = (offset: number, chunk: Buffer, token = owner.token) =>
      req(`/api/m/richchat/uploads/${start.id}`, token, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset) },
        body: new Uint8Array(chunk),
      });
    expect((await put(0, bytes.subarray(0, CHUNK))).status).toBe(200);
    // a resend at the wrong offset tells the client where to continue
    const wrong = await put(0, bytes.subarray(0, CHUNK));
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { received: number }).received).toBe(CHUNK);
    // someone else cannot touch the upload
    expect((await put(CHUNK, bytes.subarray(CHUNK, 2 * CHUNK), member.token)).status).toBe(404);
    expect((await put(CHUNK, bytes.subarray(CHUNK, 2 * CHUNK))).status).toBe(200);
    expect(
      (await req(`/api/m/richchat/uploads/${start.id}/complete`, owner.token, { method: 'POST' })).status,
    ).toBe(409);
    expect((await put(2 * CHUNK, bytes.subarray(2 * CHUNK))).status).toBe(200);
    const done = await req(`/api/m/richchat/uploads/${start.id}/complete`, owner.token, { method: 'POST' });
    expect(done.status).toBe(201);
    const ref = (await done.json()) as { sha256: string; size: number; name: string; mime: string };
    expect(ref.size).toBe(size);
    // the file goes on a message with its preview block, then downloads for a member of the chat
    const sent = await req(`/api/v1/chats/${chat}/messages`, owner.token, {
      method: 'POST',
      json: {
        text: 'clip',
        attachments: [{ sha256: ref.sha256, name: ref.name, mime: ref.mime }],
        blocks: [{ kind: 'richchat.files', v: 1, data: { files: [ref] } }],
      },
    });
    expect(sent.status).toBe(201);
    const dl = await req(`/api/v1/blobs/${ref.sha256}`, member.token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('video/mp4');
    // a preview card that relabels the file, or points at it from a message without it, is refused
    const relabelled = await req(`/api/v1/chats/${chat}/messages`, member.token, {
      method: 'POST',
      json: {
        text: 'invoice',
        blocks: [{ kind: 'richchat.files', v: 1, data: { files: [{ ...ref, name: 'invoice.pdf' }] } }],
      },
    });
    expect(relabelled.status).toBe(400);
    // an ask card cannot be forged by a person
    const forged = await req(`/api/v1/chats/${chat}/messages`, member.token, {
      method: 'POST',
      json: {
        text: 'x',
        blocks: [
          {
            kind: 'richchat.ask',
            v: 1,
            data: {
              promptId: 'p',
              question: 'q',
              options: [
                { id: 'a', label: 'a' },
                { id: 'b', label: 'b' },
              ],
              multi: false,
              state: 'open',
            },
          },
        ],
      },
    });
    expect(forged.status).toBe(400);
  });
});
