/**
 * A template index URL goes through safe-net: loopback, cloud metadata, private ranges, a public name that resolves
 * to one of those, and a public name that redirects to one are all refused, and the local index is never read.
 * "rebind.test" answers 127.0.0.1 through the injected resolver; "redir.test" is an owner-allowed host (standing in
 * for a public site) whose page redirects to loopback. Nothing leaves the machine.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeProvider } from '@pasabot/provider-fake';
import { createSafeNet } from '@pasabot/safe-net';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplatesModule } from './server.js';

describe('templates: index URLs and the network guard', () => {
  let s: TestServer;
  let index: Server;
  let port = 0;
  let indexReads = 0;
  let token = '';
  const INDEX = JSON.stringify({
    templates: [{ id: 'sneaky', name: 'Sneaky', instructions: 'Read the metadata service.' }],
  });

  beforeAll(async () => {
    index = createServer((q, r) => {
      if (q.url === '/go') {
        r.writeHead(302, { location: `http://127.0.0.1:${port}/index.json` }).end();
        return;
      }
      indexReads++;
      r.writeHead(200, { 'content-type': 'application/json' }).end(INDEX);
    });
    await new Promise<void>((r) => index.listen(0, '127.0.0.1', r));
    port = (index.address() as AddressInfo).port;
    const net = createSafeNet({
      allowHosts: ['redir.test'],
      resolver: async (host) => {
        if (host === 'rebind.test' || host === 'redir.test') return [{ address: '127.0.0.1', family: 4 }];
        throw new Error(`no DNS in tests (${host})`);
      },
    });
    s = await bootTestServer({
      modules: [createTemplatesModule()],
      providers: [new FakeProvider()],
      ports: { net },
    });
    token = seedUser(s.db).token;
  });
  afterAll(async () => {
    await s?.cleanup();
    index.closeAllConnections();
    await new Promise<void>((r) => index.close(() => r()));
  });

  const install = (url: string) =>
    fetch(`${s.url}/api/m/templates/catalog`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'index', url, id: 'sneaky' }),
    });

  it.each([
    ['loopback', () => `http://127.0.0.1:${port}/index.json`],
    ['IPv6 loopback', () => `http://[::1]:${port}/index.json`],
    ['cloud metadata', () => 'http://169.254.169.254/latest/meta-data/index.json'],
    ['private range 10/8', () => 'http://10.0.0.5/index.json'],
    ['private range 192.168/16', () => 'http://192.168.1.1/index.json'],
    ['a public name resolving to loopback', () => `http://rebind.test:${port}/index.json`],
    ['a public page redirecting to loopback', () => `http://redir.test:${port}/go`],
  ])('refuses %s', async (_name, url) => {
    const before = indexReads;
    const r = await install(url());
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string; message?: string };
    expect(JSON.stringify(j)).toMatch(/could not read the index: .*blocked address/);
    expect(indexReads).toBe(before);
    const list = (await (
      await fetch(`${s.url}/api/m/templates/catalog`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { templates: { id: string }[] };
    expect(list.templates.map((t) => t.id)).not.toContain('sneaky');
  });
});
