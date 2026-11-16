import { bootTestServer, runMemoryContract, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockHindsight } from './__fixtures__/mock-hindsight.js';
import { HindsightBackend } from './backend.js';
import hindsightPlugin from './server.js';

runMemoryContract('hindsight (mock server)', async () => {
  const mock = await startMockHindsight({ apiKey: 'test-key' });
  const backend = new HindsightBackend({
    url: mock.url,
    bankPrefix: 'bk',
    fetch: (u, i) => fetch(u, i),
    apiKey: async () => 'test-key',
  });
  return { backend, cleanup: () => mock.close() };
});

describe('hindsight plugin wiring', () => {
  let s: TestServer;
  let owner: string;
  let mock: Awaited<ReturnType<typeof startMockHindsight>>;
  beforeAll(async () => {
    mock = await startMockHindsight();
    s = await bootTestServer({ modules: [hindsightPlugin] });
    owner = seedUser(s.db).token;
  });
  afterAll(async () => {
    await s.cleanup();
    await mock.close();
  });

  const put = (body: unknown, token = owner) =>
    fetch(`${s.url}/api/m/hindsight/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it('registers the backend; unconfigured it refuses instead of guessing', async () => {
    const b = s.memory.get('hindsight')!;
    expect(b).toBeDefined();
    await expect(b.list({})).rejects.toThrow(/not configured/);
  });

  it('owner config routes the backend through safe-net to the configured host (banks per scope)', async () => {
    expect((await put({ url: 'ftp://nope' })).status).toBe(400);
    expect((await put({ url: mock.url }, seedUser(s.db, 'member', 'M').token)).status).toBe(403);
    expect((await put({ url: mock.url, bankPrefix: 'home' })).status).toBe(200);
    const b = s.memory.get('hindsight')!;
    const id = await b.remember({ agentId: '01ABC', text: 'carabao mango from Guimaras' });
    await b.remember({ agentId: null, text: 'mango shared note' });
    expect([...mock.banks.keys()].sort()).toEqual(['home-agent-01ABC', 'home-shared']);
    expect((await b.search({ agentId: '01ABC', text: 'mango' })).length).toBe(2);
    expect((await b.list({ agentId: '01ABC' })).map((i) => i.agentId)).toEqual(['01ABC']);
    await b.forget(id);
    expect((await b.search({ agentId: '01ABC', text: 'carabao' })).map((h) => h.id)).toEqual([]);
    expect(mock.requests.every((r) => r.path.startsWith('/v1/default/banks'))).toBe(true);
  });

  it('an API key needs https, except to this machine', async () => {
    const lan = await put({ url: 'http://hindsight.lan:8888', apiKeySecret: 'hs_key' });
    expect(lan.status).toBe(400);
    expect((await put({ url: 'https://hindsight.lan:8888', apiKeySecret: 'hs_key' })).status).toBe(200);
    expect((await put({ url: mock.url, apiKeySecret: 'hs_key' })).status).toBe(200); // 127.0.0.1
    expect((await put({ url: 'http://hindsight.lan:8888' })).status).toBe(200); // no key, nothing to leak
    expect((await put({ url: mock.url })).status).toBe(200);
  });
});
