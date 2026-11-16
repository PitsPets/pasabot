// @vitest-environment happy-dom
/**
 * Done-criterion proof for W10: the review screen (real React page, real server with the memory module) forgets
 * an item, and the agent's memory_search tool no longer returns it. HTTP goes through node:http so nothing
 * depends on the DOM environment's fetch.
 */
import { request } from 'node:http';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryPage } from '../web/index.js';
import memoryModule from './server.js';

function http(base: string, path: string, init: { method?: string; body?: string; bearer: string }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(path, base);
    const req = request(
      u,
      {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${init.bearer}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

async function until<T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('W10 review screen', () => {
  let s: TestServer;
  let owner: string;
  let runToken: string;
  const tool = async (name: string, args: unknown) => {
    const r = await http(s.url, '/mcp', {
      method: 'POST',
      bearer: runToken,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return JSON.parse(JSON.parse(r.text).result.content[0].text);
  };
  beforeAll(async () => {
    s = await bootTestServer({ modules: [memoryModule] });
    owner = seedUser(s.db).token;
    // an owner turn: own remember auto-approves only there (a non-owner turn asks first)
    const run = seedRunToken(s.db, seedAgent(s.db, { slug: 'tala' }));
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: 'o', name: 'Owner', trust: 'trusted' } }),
        run.runId,
      );
    runToken = run.token;
    // the page's fetch: same paths, sent to the test server with the owner's session
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const r = await http(s.url, path, {
        method: init?.method,
        body: init?.body as string | undefined,
        bearer: owner,
      });
      return new Response(r.status === 204 ? null : r.text, {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });
  afterAll(() => s.cleanup());

  it('forgets an item from the screen and memory_search no longer returns it', async () => {
    const { id } = await tool('memory_remember', { text: 'Lola birthday is on 12 March' });
    await tool('memory_remember', { text: 'Lola likes ensaymada' });
    expect(
      (await tool('memory_search', { query: 'Lola birthday' })).items.map((i: { id: string }) => i.id),
    ).toContain(id);

    const host = document.createElement('div');
    document.body.append(host);
    createRoot(host).render(<MemoryPage />);
    const row = await until(() => host.querySelector(`[data-memory-item="${id}"]`));
    expect(row.textContent).toContain('Lola birthday is on 12 March');
    expect(host.textContent).toContain('2 items');

    const button = (label: string) =>
      [...row.querySelectorAll('button')].find((b) => b.textContent === label) as
        | HTMLButtonElement
        | undefined;
    (await until(() => button('Forget'))).click();
    (await until(() => button('Forget for good'))).click();
    await until(() => !host.querySelector(`[data-memory-item="${id}"]`));
    expect(host.textContent).toContain('1 item');

    const after = await tool('memory_search', { query: 'Lola birthday' });
    expect(after.items.map((i: { id: string }) => i.id)).not.toContain(id);
    expect(after.items.map((i: { text: string }) => i.text)).toEqual(['Lola likes ensaymada']);
  });
});
