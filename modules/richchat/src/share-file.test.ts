/** W40: a helper hands over only a regular file inside its own workspace (symlinks resolved), never anything else. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRichchatModule, workspaceFile } from './server.js';

describe('W40 richchat_share_file on a server: a result card the chat can open and download', () => {
  let s: TestServer;
  let owner = '';
  let chatId = '';
  const fake = new FakeProvider();
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, text: await r.text() };
  };
  beforeAll(async () => {
    s = await bootTestServer({ providers: [fake], modules: [createRichchatModule()] });
    owner = seedUser(s.db, 'owner', 'Owner').token;
    const r = JSON.parse(
      (await api('/api/v1/agents', { name: 'Tala', providerId: 'fake', trustLevel: 'trusted' })).text,
    );
    chatId = r.chatId;
    const id = r.agent?.id ?? r.id ?? r.agentId;
    const ws = (
      s.db.prepare('SELECT workspace_dir FROM agents WHERE id = ?').get(id) as { workspace_dir: string }
    ).workspace_dir;
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'list.csv'), 'item,qty\nrice,2\n');
  });
  afterAll(() => s.cleanup());

  it('the helper hands over a file: a card with Open / Download; the bytes come from the blob route', async () => {
    await api(`/api/v1/chats/${chatId}/messages`, {
      text: JSON.stringify({ probe: { name: 'richchat_share_file', args: { path: 'list.csv' } } }),
    });
    let card: any;
    for (let i = 0; i < 250 && !card; i++) {
      const msgs = JSON.parse((await api(`/api/v1/chats/${chatId}/messages`)).text).messages as any[];
      card = msgs.flatMap((m) => m.blocks).find((b: any) => b.kind === 'core.card')?.data;
      if (!card) await new Promise((r) => setTimeout(r, 20));
    }
    const dump = JSON.parse((await api(`/api/v1/chats/${chatId}/messages`)).text).messages.map(
      (m: any) => m.body,
    );
    expect(card, JSON.stringify(dump)).toMatchObject({ variant: 'result', source: 'richchat' });
    expect(card.title).toEqual({ key: 'richchat:card.file.title', params: { name: 'list.csv' } });
    expect(card.visual).toMatchObject({ kind: 'file', name: 'list.csv', mime: 'text/csv', size: 16 });
    const got = await api(card.visual.url);
    expect(got.status).toBe(200);
    expect(got.text).toBe('item,qty\nrice,2\n');
  });
});

describe('W40 richchat_share_file: workspaceFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'pasabot-share-'));
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'out'), { recursive: true });
  writeFileSync(join(ws, 'out', 'report.csv'), 'a,b\n1,2\n');
  writeFileSync(join(root, 'secret.txt'), 'not yours');
  symlinkSync(join(root, 'secret.txt'), join(ws, 'link.txt'));
  symlinkSync(join(ws, 'out', 'report.csv'), join(ws, 'inside.csv'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a file in the workspace is handed over with its size', () => {
    expect(workspaceFile(ws, 'out/report.csv').size).toBe(8);
    // a link that stays inside the workspace is fine
    expect(workspaceFile(ws, 'inside.csv').size).toBe(8);
  });
  it('anything outside, absolute, up a level, missing or a folder is refused', () => {
    expect(() => workspaceFile(ws, join(root, 'secret.txt'))).toThrow(/relative/);
    expect(() => workspaceFile(ws, '../secret.txt')).toThrow(/relative/);
    expect(() => workspaceFile(ws, 'link.txt')).toThrow(/outside/);
    expect(() => workspaceFile(ws, 'nope.txt')).toThrow(/no such file/);
    expect(() => workspaceFile(ws, 'out')).toThrow(/not a file/);
  });
});
