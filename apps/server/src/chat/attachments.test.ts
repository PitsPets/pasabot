import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { asSystem } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { createChatPort } from './port.js';

const MB = 1024 * 1024;

describe('attachments, user blocks and the ChatPort message API (iface for W7)', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let agent: string;
  let shared: string;
  let secret: string;
  const req = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${s.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, token: string, body: unknown) =>
    req(path, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const upload = async (bytes: Buffer, token = owner.token) =>
    (await (
      await req('/api/v1/blobs', token, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      })
    ).json()) as { sha256: string; size: number };

  beforeAll(async () => {
    s = await bootTestServer();
    s.blocks.register('testmod.files', z.object({ n: z.number() }), { userAuthored: true });
    s.blocks.register('testmod.card', z.object({ n: z.number() }));
    const ref = z.object({ sha256: z.string(), name: z.string(), mime: z.string(), size: z.number() });
    s.blocks.register('testmod.previews', z.object({ files: z.array(ref) }), {
      userAuthored: true,
      attachmentRefs: (d) => d.files,
    });
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    agent = seedAgent(s.db);
    shared = seedChat(s.db, { userIds: [owner.id, member.id] });
    secret = seedChat(s.db, { userIds: [owner.id] });
  });
  afterAll(() => s.cleanup());

  it('stores attachments on a message; members of the chat download them with safe headers', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const ref = await upload(svg, member.token);
    const r = await post(`/api/v1/chats/${shared}/messages`, member.token, {
      text: 'see file',
      attachments: [{ sha256: ref.sha256, name: 'pic.svg', mime: 'image/svg+xml' }],
      blocks: [{ kind: 'testmod.files', v: 1, data: { n: 1 } }],
    });
    expect(r.status).toBe(201);
    const { message } = (await r.json()) as { message: { id: string; blocks: unknown[] } };
    expect(message.blocks).toEqual([{ kind: 'testmod.files', v: 1, data: { n: 1 } }]);
    const dl = await req(`/api/v1/blobs/${ref.sha256}`, member.token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(dl.headers.get('content-type')).toBe('image/svg+xml');
    expect(Buffer.from(await dl.arrayBuffer()).equals(svg)).toBe(true);
  });

  it('html and unknown types download as octet-stream attachments', async () => {
    const ref = await upload(Buffer.from('<script>steal()</script>'));
    await post(`/api/v1/chats/${shared}/messages`, owner.token, {
      text: 'x',
      attachments: [{ sha256: ref.sha256, name: 'x.html', mime: 'text/html' }],
    });
    const dl = await req(`/api/v1/blobs/${ref.sha256}`, member.token);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('a member cannot download a blob attached only in a chat they are not in', async () => {
    const ref = await upload(randomBytes(64));
    await post(`/api/v1/chats/${secret}/messages`, owner.token, { text: 'mine', attachments: [ref.sha256] });
    expect((await req(`/api/v1/blobs/${ref.sha256}`, member.token)).status).toBe(404);
    expect((await req(`/api/v1/blobs/${ref.sha256}`, owner.token)).status).toBe(200);
  });

  it('refuses unknown blobs, more than 250 MB per message, and blocks that are not user-authored', async () => {
    const fake = (n: number) => {
      const sha = randomBytes(32).toString('hex');
      s.db
        .prepare('INSERT INTO blobs (sha256, size, refcount, created_at) VALUES (?, ?, 1, ?)')
        .run(sha, n, Date.now());
      s.db
        .prepare('INSERT INTO blob_uploads (sha256, user_id, created_at) VALUES (?, ?, ?)')
        .run(sha, owner.id, Date.now());
      return sha;
    };
    expect(
      (
        await post(`/api/v1/chats/${shared}/messages`, owner.token, {
          text: 'a',
          attachments: ['f'.repeat(64)],
        })
      ).status,
    ).toBe(400);
    const big = [fake(90 * MB), fake(90 * MB), fake(90 * MB)];
    const r = await post(`/api/v1/chats/${shared}/messages`, owner.token, { text: 'a', attachments: big });
    expect(r.status).toBe(413);
    expect(
      (
        await post(`/api/v1/chats/${shared}/messages`, owner.token, {
          text: 'a',
          attachments: big.slice(0, 2),
        })
      ).status,
    ).toBe(201);
    const forged = await post(`/api/v1/chats/${shared}/messages`, member.token, {
      text: 'a',
      blocks: [{ kind: 'testmod.card', v: 1, data: { n: 1 } }],
    });
    expect(forged.status).toBe(400);
  });

  it('knowing a sha is not enough: a member cannot attach (and so download) a blob from a chat they cannot read', async () => {
    const ref = await upload(randomBytes(64));
    await post(`/api/v1/chats/${secret}/messages`, owner.token, {
      text: 'private',
      attachments: [ref.sha256],
    });
    const r = await post(`/api/v1/chats/${shared}/messages`, member.token, {
      text: 'grab',
      attachments: [ref.sha256],
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('unknown_blob');
    expect((await req(`/api/v1/blobs/${ref.sha256}`, member.token)).status).toBe(404);
    // a blob nobody attached yet, uploaded by someone else, is refused too
    const loose = await upload(randomBytes(64));
    expect(
      (
        await post(`/api/v1/chats/${shared}/messages`, member.token, {
          text: 'x',
          attachments: [loose.sha256],
        })
      ).status,
    ).toBe(400);
    // re-sharing what the member can already read is fine
    const seen = await upload(randomBytes(64));
    await post(`/api/v1/chats/${shared}/messages`, owner.token, { text: 'here', attachments: [seen.sha256] });
    expect(
      (
        await post(`/api/v1/chats/${shared}/messages`, member.token, {
          text: 'again',
          attachments: [seen.sha256],
        })
      ).status,
    ).toBe(201);
  });

  it('a preview block must describe the message’s own attachments exactly', async () => {
    const mine = await upload(Buffer.from('%PDF-1.4 real'), member.token);
    const other = await upload(Buffer.from('MZ not a pdf'));
    await post(`/api/v1/chats/${shared}/messages`, owner.token, { text: 'exe', attachments: [other.sha256] });
    const card = (sha: string, name: string, size: number) => ({
      kind: 'testmod.previews',
      v: 1,
      data: { files: [{ sha256: sha, name, mime: 'application/pdf', size }] },
    });
    // points at a sha attached elsewhere in the chat, with no attachment of its own
    const forged = await post(`/api/v1/chats/${shared}/messages`, member.token, {
      text: 'invoice',
      blocks: [card(other.sha256, 'invoice.pdf', 1200)],
    });
    expect(forged.status).toBe(400);
    const attach = [{ sha256: mine.sha256, name: 'a.pdf', mime: 'application/pdf' }];
    // relabelled name or size
    for (const bad of [card(mine.sha256, 'b.pdf', mine.size), card(mine.sha256, 'a.pdf', mine.size + 1)])
      expect(
        (
          await post(`/api/v1/chats/${shared}/messages`, member.token, {
            text: 'x',
            attachments: attach,
            blocks: [bad],
          })
        ).status,
      ).toBe(400);
    const ok = await post(`/api/v1/chats/${shared}/messages`, member.token, {
      text: 'x',
      attachments: attach,
      blocks: [card(mine.sha256, 'a.pdf', mine.size)],
    });
    expect(ok.status).toBe(201);
  });

  it('observers are read-only: the message route and ChatPort.canWrite agree', async () => {
    const watcher = seedUser(s.db, 'member', 'Watcher');
    s.db
      .prepare(
        "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'observer')",
      )
      .run(shared, watcher.id);
    const port = createChatPort(s.db, s.bus, { blocks: s.blocks, redact: (t) => t });
    expect(port.canRead(shared, { id: watcher.id, kind: 'member' })).toBe(true);
    expect(port.canWrite(shared, { id: watcher.id, kind: 'member' })).toBe(false);
    expect(port.canWrite(shared, { id: member.id, kind: 'member' })).toBe(true);
    expect(port.canWrite(secret, { id: member.id, kind: 'member' })).toBe(false);
    expect(port.canWrite(secret, { id: owner.id, kind: 'owner' })).toBe(true);
    expect((await post(`/api/v1/chats/${shared}/messages`, watcher.token, { text: 'hi' })).status).toBe(403);
  });

  it('ChatPort: post/updateBlocks validate blocks; search respects membership', async () => {
    const port = createChatPort(s.db, s.bus, { blocks: s.blocks, redact: (t) => t });
    const sys = asSystem('test: seed messages');
    const m = port.post(sys, {
      chatId: secret,
      authorKind: 'agent',
      authorId: agent,
      body: 'zebra crossing',
      blocks: [{ kind: 'testmod.card', v: 1, data: { n: 2 } }],
    });
    expect(port.message(sys, m.id)?.blocks).toHaveLength(1);
    expect(() =>
      port.post(sys, {
        chatId: secret,
        authorKind: 'agent',
        authorId: agent,
        body: 'x',
        blocks: [{ kind: 'testmod.card', v: 1, data: { n: 'no' } }],
      }),
    ).toThrow();
    expect(
      port.updateBlocks(sys, m.id, [{ kind: 'testmod.card', v: 1, data: { n: 3 } }])?.blocks[0],
    ).toMatchObject({ data: { n: 3 } });
    port.post(sys, {
      chatId: shared,
      authorKind: 'agent',
      authorId: agent,
      body: 'zebra in the shared chat',
    });
    const asOwner = port.search({ text: 'zebra', reader: { kind: 'user', id: owner.id, userKind: 'owner' } });
    expect(asOwner.map((h) => h.chatId).sort()).toEqual([secret, shared].sort());
    const asMember = port.search({
      text: 'zeb',
      reader: { kind: 'user', id: member.id, userKind: 'member' },
    });
    expect(asMember.map((h) => h.chatId)).toEqual([shared]);
    expect(
      port.search({ text: '" OR 1', reader: { kind: 'user', id: owner.id, userKind: 'owner' } }),
    ).toEqual([]);
    expect(port.canRead(secret, { id: member.id, kind: 'member' })).toBe(false);
  });

  it('streams a 90 MB upload into the BlobStore and refuses 120 MB (413)', async () => {
    const stream = (n: number) =>
      Readable.toWeb(
        Readable.from(
          (function* () {
            const chunk = Buffer.alloc(MB, 7);
            for (let i = 0; i < n; i++) yield chunk;
          })(),
        ),
      ) as ReadableStream;
    const send = (n: number) =>
      fetch(`${s.url}/api/v1/blobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/octet-stream' },
        body: stream(n),
        duplex: 'half',
      } as RequestInit);
    const ok = await send(90);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { size: number }).size).toBe(90 * MB);
    expect((await send(120)).status).toBe(413);
  }, 60_000);
});
