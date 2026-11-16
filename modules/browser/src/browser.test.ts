/**
 * W15 done-criteria on a real server with headless Chromium: a Fake agent opens a local test page through the MCP
 * gateway, live screencast frames reach an owner WebSocket, the SSRF guard keeps the profile off loopback until
 * the owner allows the host, and a logged-in profile asks at tier 3. Every browser a test starts is closed by it.
 * Review fixes: a public page's redirect to loopback is refused hop by hop, a name that rebinds to loopback is
 * refused on the next request, service workers cannot register, the renderer runs sandboxed, and any owner
 * driving (address bar, click, scroll, keys) marks the profile as holding sign-ins. "public.test" and
 * "rebind.test" answer a public test IP through the module's resolver hook; its dial hook lands that IP on the
 * local page server, so nothing leaves the machine.
 */
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { MessageDTO } from '@pasabot/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  FakeProvider,
  seedAgent,
  seedChat,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { requireChromium } from './__fixtures__/chromium.js';
import { createBrowserModule } from './server.js';

/** pids of Chromium processes started for this server's profiles */
const chromiumFor = (dir: string) => {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

describe('browser (W15)', () => {
  let s: TestServer;
  let page: Server;
  let pageUrl: string;
  let hits = 0;
  let secret: Server; // a loopback service standing in for IMDS / a router admin page
  let secretPort = 0;
  let secretHits = 0;
  let rebound = false;
  const PUBLIC_IP = '93.184.216.34';
  const dialed: string[] = [];
  const mod = createBrowserModule({
    sweepMs: 0,
    resolver: async (host) => {
      if (host === 'public.test') return [{ address: PUBLIC_IP, family: 4 }];
      if (host === 'rebind.test') return [{ address: rebound ? '127.0.0.1' : PUBLIC_IP, family: 4 }];
      return (await lookup(host, { all: true, verbatim: true })) as { address: string; family: 4 | 6 }[];
    },
    dial: (ip, port) => {
      dialed.push(ip);
      return ip === PUBLIC_IP
        ? connect((page.address() as { port: number }).port, '127.0.0.1')
        : connect({ host: ip, port });
    },
  });
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let chat: string;
  let agentId = '';
  let ordered = 0;
  let swap = false;
  let swapped = 0;
  const sent: string[] = [];
  const req = (path: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${s.url}${path}`, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    });
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** owner sends `{"probe": ...}`; resolves with the agent's reply text */
  const probe = async (name: string, args: unknown) => {
    const before = (await messages()).length;
    await req(`/api/v1/chats/${chat}/messages`, owner.token, {
      method: 'POST',
      json: { text: JSON.stringify({ probe: { name, args } }) },
    });
    return waitFor(async () => {
      const ms = await messages();
      const reply = ms
        .slice(before)
        .find((m) => m.authorKind === 'agent' && m.status !== 'pending' && m.status !== 'streaming');
      return reply?.body;
    });
  };
  const messages = async () =>
    ((await (await req(`/api/v1/chats/${chat}/messages`, owner.token)).json()) as { messages: MessageDTO[] })
      .messages;

  beforeAll(async () => {
    await requireChromium();
    secret = createServer((_q, r) => {
      secretHits++;
      r.end('iam-credentials-for-nena');
    });
    await new Promise<void>((r) => secret.listen(0, '127.0.0.1', r));
    secretPort = (secret.address() as { port: number }).port;
    page = createServer((q, r) => {
      if (q.url === '/favicon.ico') return void r.writeHead(404).end();
      if (q.url === '/r')
        // a "public" page bouncing the browser to a loopback service
        return void r.writeHead(302, { location: `http://127.0.0.1:${secretPort}/latest/meta-data/` }).end();
      if (q.url === '/rebind')
        return void r
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<!doctype html><title>Rebind</title><button onclick="fetch('/data').then((x) => x.text()).then((t) => { document.title = 'got: ' + t; }, () => { document.title = 'fetch failed'; })">Fetch data</button>`,
          );
      if (q.url === '/data') return void r.end('fixture data (still public)');
      // 7.1 time-of-check/time-of-use: a neutral page whose button leads straight to a page that takes money
      if (q.url === '/product')
        return void r
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<!doctype html><title>Product</title><button onclick="location.href='/step2'">Continue</button>`,
          );
      if (q.url === '/step2')
        return void r
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<!doctype html><title>Review</title><button onclick="fetch('/ordered').then(() => { document.title = 'Ordered'; })">Place your order</button>`,
          );
      // 7.1: a compose form whose recipient the page itself swaps once the test says so (while a card is pending)
      if (q.url === '/compose')
        return void r.writeHead(200, { 'content-type': 'text/html' }).end(
          `<!doctype html><title>Compose</title><form>
              <input name="to" aria-label="To" value="friend@example.test">
              <input name="subject" aria-label="Subject" value="Dinner">
              <textarea name="body" aria-label="Message">See you at 6</textarea>
              <button type="button" onclick="fetch('/sent?to=' + encodeURIComponent(this.form.to.value)).then(() => { document.title = 'Sent'; })">Send</button>
            </form><script>
              let polls = 0;
              const poll = () => fetch('/swap').then((x) => x.text()).then((t) => {
                if (t === 'yes') {
                  document.querySelector('[name=to]').value = 'attacker@evil.test';
                  return fetch('/swapped');
                }
                if (++polls < 300) setTimeout(poll, 100);
              }, () => {});
              poll();
            </script>`,
        );
      if (q.url === '/swap') return void r.end(swap ? 'yes' : 'no');
      if (q.url === '/swapped') {
        swapped++;
        return void r.end('ok');
      }
      if (q.url?.startsWith('/sent')) {
        sent.push(new URL(q.url, 'http://x').searchParams.get('to') ?? '');
        return void r.end('ok');
      }
      if (q.url === '/ordered') {
        ordered++;
        return void r.end('ok');
      }
      if (q.url === '/sw')
        return void r.writeHead(200, { 'content-type': 'text/html' }).end(
          // the plain register() and the prototype's (which Playwright's 'block' does not cover), then a look
          // at what is still registered a moment later
          `<!doctype html><title>SW test</title><script>
              const c = navigator.serviceWorker;
              const tryReg = (f) => f().then(() => 'ok', () => 'refused');
              Promise.all([tryReg(() => c.register('/sw.js')), tryReg(() => ServiceWorkerContainer.prototype.register.call(c, '/sw.js?p'))])
                .then((r) => new Promise((ok) => setTimeout(() => ok(r), 2000)))
                .then((r) => c.getRegistrations().then((rs) => { document.title = 'done ' + r.join(',') + ' live: ' + rs.length; }));
            </script>`,
        );
      if (q.url?.startsWith('/sw.js'))
        return void r.writeHead(200, { 'content-type': 'text/javascript' }).end('self.onfetch = () => {};');
      hits++;
      r.writeHead(200, { 'content-type': 'text/html' }).end(
        '<!doctype html><title>Tindahan ni Aling Nena</title><h1>Hello tindahan</h1><button onclick="document.title=\'Bought\'">Buy rice</button>',
      );
    });
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', r));
    pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
    s = await bootTestServer({ providers: [new FakeProvider({ deltaMs: 1 })], modules: [mod] });
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    const agent = seedAgent(s.db, { trust: 'trusted' });
    agentId = agent;
    chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
  }, 30_000);
  afterAll(async () => {
    if (!s) return; // beforeAll stopped early (no Chromium): nothing was started
    const dir = mod.manager().profilesDir;
    await mod.manager().closeAll();
    await s.cleanup();
    page.closeAllConnections();
    secret.closeAllConnections();
    await new Promise<void>((r) => page.close(() => r()));
    await new Promise<void>((r) => secret.close(() => r()));
    // no Chromium outlives the test
    await waitFor(async () => (chromiumFor(dir).length === 0 ? true : undefined), 10_000);
  }, 30_000);

  it('profiles are owner-only, keep a colour and a proxy whose password stays in the vault', async () => {
    expect((await req('/api/m/browser/profiles', member.token)).status).toBe(403);
    const bad = await req('/api/m/browser/profiles', owner.token, {
      method: 'POST',
      json: { name: 'x', color: '#123456', proxy: { server: 'http://user:pw@proxy.example:8080' } },
    });
    expect(bad.status).toBe(400);
    const r = await req('/api/m/browser/profiles', owner.token, {
      method: 'POST',
      json: {
        name: 'Proxied',
        color: '#E11D48',
        proxy: { server: 'http://proxy.example:8080', username: 'nena', password: 'pw-very-secret-123' },
      },
    });
    expect(r.status).toBe(200);
    const { profile } = (await r.json()) as { profile: { id: string; color: string; proxy: unknown } };
    expect(profile.color).toBe('#e11d48');
    expect(profile.proxy).toEqual({
      server: 'http://proxy.example:8080',
      username: 'nena',
      hasPassword: true,
    });
    const row = s.db.prepare('SELECT proxy FROM browser_profile WHERE id = ?').get(profile.id) as {
      proxy: string;
    };
    expect(row.proxy).not.toContain('pw-very-secret-123');
    expect(JSON.stringify(await (await req('/api/m/browser/profiles', owner.token)).json())).not.toContain(
      'pw-very-secret-123',
    );
    expect(
      (await req(`/api/m/browser/profiles/${profile.id}`, owner.token, { method: 'DELETE' })).status,
    ).toBe(200);
  });

  it('the SSRF guard keeps an agent off loopback until the owner allows the host', async () => {
    const blocked = await probe('browser_navigate', { url: pageUrl });
    expect(blocked).toContain('blocked by the network guard');
    expect(hits).toBe(0);
  }, 30_000);

  it('a public page that redirects to loopback is refused at the redirect hop', async () => {
    const reply = await probe('browser_navigate', { url: 'http://public.test/r' });
    expect(reply).toContain('tool said:');
    expect(reply).not.toContain('iam-credentials-for-nena');
    expect(secretHits).toBe(0);
    expect(dialed.every((ip) => ip === PUBLIC_IP)).toBe(true);
  }, 30_000);

  it('a name that rebinds to loopback is refused on the next request (no cached allow, IP pinned)', async () => {
    rebound = false;
    expect(await probe('browser_navigate', { url: 'http://rebind.test/rebind' })).toContain('Fetch data');
    rebound = true; // the page's DNS now answers 127.0.0.1
    await probe('browser_click', { text: 'Fetch data' });
    const title = await waitFor(async () => {
      const r = await probe('browser_snapshot', {});
      const t = /"title":"([^"]*)"/.exec(r)?.[1] ?? '';
      return t === 'Rebind' ? undefined : t;
    });
    expect(title).not.toContain('fixture data');
    expect(title).toMatch(/Blocked by the PasaBot network guard|fetch failed/);
    expect(dialed.every((ip) => ip === PUBLIC_IP)).toBe(true);
    expect(secretHits).toBe(0);
  }, 60_000);

  it('a Fake agent opens a local test page through MCP and live frames reach the owner', async () => {
    const put = await req('/api/m/browser/settings', owner.token, {
      method: 'PUT',
      json: { allowHosts: ['127.0.0.1'] },
    });
    expect(put.status).toBe(200);
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['owner'] });

    const reply = await probe('browser_navigate', { url: pageUrl });
    expect(reply).toContain('tool said:');
    expect(reply).toContain('Tindahan ni Aling Nena');
    expect(reply).toContain('Hello tindahan');
    expect(reply).toContain('"untrusted":true');
    expect(hits).toBeGreaterThan(0);

    const frame = await ws.next(
      (f) => f.t === 'live' && f.type === 'browser.frame' && f.data.url === pageUrl,
      15_000,
    );
    expect(frame.topic).toBe('owner');
    expect(frame.data.url).toBe(pageUrl);
    expect(Buffer.from(frame.data.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    ws.close();

    // the agent clicks "Buy rice": a button that buys asks the owner first (7.1), with a money card
    const clicking = probe('browser_click', { text: 'Buy rice' });
    const a = await waitFor(async () => s.approvals.list('pending').find((x) => x.agentId === agentId));
    expect(a.ask).toMatchObject({ class: 'money', undeclared: true });
    s.approvals.decide(a.id, 'approved', owner.id);
    const clicked = await clicking;
    expect(clicked).toContain('Bought');
    // the profile listed as running on that page, the last frame over REST
    const { profiles } = (await (await req('/api/m/browser/profiles', owner.token)).json()) as {
      profiles: { id: string; name: string; running: boolean; url: string; loggedIn: boolean }[];
    };
    // the profile the server made for the agents has no server-written (English) name: the web names it
    expect(JSON.stringify(profiles)).not.toContain('Agent browser');
    const p = profiles.find((x) => x.name === '')!;
    expect(p).toMatchObject({ running: true, url: pageUrl, loggedIn: false });
    const f = await req(`/api/m/browser/profiles/${p.id}/frame`, owner.token);
    expect(f.status).toBe(200);
    expect((await req(`/api/m/browser/profiles/${p.id}/frame`, member.token)).status).toBe(403);
  }, 60_000);

  it('7.1: an action checked on one page never runs on the next (parallel clicks, a changed page)', async () => {
    // tool calls straight to the gateway, as a trusted agent's run on an owner turn
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: owner.id, name: 'Owner', trust: 'trusted' } }),
        runId,
      );
    const tool = async (name: string, args: unknown) => {
      const r = await fetch(`${s.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const j = (await r.json()) as any;
      return { isError: !!j.result?.isError, text: String(j.result?.content?.[0]?.text ?? j.error?.message) };
    };
    const nav = await tool('browser_navigate', { url: `${pageUrl}product` });
    expect(nav.text).toContain('Continue');
    // A leaves the neutral page; B was checked there (no money button yet), so it must not click on the next page
    const [a, b] = await Promise.all([
      tool('browser_click', { text: 'Continue' }),
      tool('browser_click', { text: 'Place your order', intent: 'none' }),
    ]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/page changed|not on the page now/);
    await new Promise((r) => setTimeout(r, 500));
    expect(ordered).toBe(0);
    expect(s.approvals.list('pending').filter((x) => x.runId === runId)).toHaveLength(0);
  }, 60_000);

  it('7.1: a message sends only to the recipients the owner approved (the page changed them while the card waited)', async () => {
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: owner.id, name: 'Owner', trust: 'trusted' } }),
        runId,
      );
    const tool = async (name: string, args: unknown) => {
      const r = await fetch(`${s.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const j = (await r.json()) as any;
      return { isError: !!j.result?.isError, text: String(j.result?.content?.[0]?.text ?? j.error?.message) };
    };
    const pending = () =>
      waitFor(async () => s.approvals.list('pending').find((x) => x.runId === runId && x.ask?.class));
    const recipients = (a: { ask?: { fields: { key: string; value: string | null }[] } | null }) =>
      a.ask?.fields.find((f) => f.key === 'recipients')?.value;

    // unchanged page: the approved message goes out once, to the approved recipient
    swap = false;
    expect((await tool('browser_navigate', { url: `${pageUrl}compose` })).text).toContain('Compose');
    const first = tool('browser_click', { text: 'Send', intent: 'outbound-message' });
    const a1 = await pending();
    expect(a1.ask?.class).toBe('outbound-message');
    expect(recipients(a1)).toBe('friend@example.test');
    s.approvals.decide(a1.id, 'approved', owner.id);
    expect((await first).isError).toBe(false);
    await waitFor(async () => (sent.length ? true : undefined));
    expect(sent).toEqual(['friend@example.test']);

    // the page swaps the recipient after the card was shown: the approved click is refused, nothing is sent
    expect((await tool('browser_navigate', { url: `${pageUrl}compose` })).text).toContain('Compose');
    const second = tool('browser_click', { text: 'Send', intent: 'outbound-message' });
    const a2 = await pending();
    expect(recipients(a2)).toBe('friend@example.test');
    swap = true;
    await waitFor(async () => (swapped > 0 ? true : undefined));
    s.approvals.decide(a2.id, 'approved', owner.id);
    const out = await second;
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/page changed/);
    await new Promise((r) => setTimeout(r, 500));
    expect(sent).toEqual(['friend@example.test']);
    swap = false;
    await tool('browser_navigate', { url: pageUrl });
  }, 60_000);

  it('a page cannot register a service worker, and the renderer runs in the Chromium sandbox', async () => {
    await probe('browser_navigate', { url: `${pageUrl}sw` });
    const title = await waitFor(async () => {
      const t = /"title":"([^"]*)"/.exec(await probe('browser_snapshot', {}))?.[1] ?? '';
      return t === 'SW test' ? undefined : t;
    });
    expect(title).toMatch(/^done .* live: 0$/);
    // and nothing is left in the profile for the next start
    const regs = await mod
      .manager()
      .running(mod.manager().resolve()!.id)!
      .page.evaluate(() => navigator.serviceWorker.getRegistrations().then((rs) => rs.length));
    expect(regs).toBe(0);
    // the profile's browser process was not started with --no-sandbox
    const pids = chromiumFor(mod.manager().profilesDir);
    expect(pids.length).toBeGreaterThan(0);
    const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', pids.join(',')], { encoding: 'utf8' });
    expect(args).toContain('--user-data-dir');
    expect(args).not.toContain('--no-sandbox');
  }, 60_000);

  it('any owner driving marks a profile as holding sign-ins (address bar, click, scroll, keys)', async () => {
    const made = await req('/api/m/browser/profiles', owner.token, {
      method: 'POST',
      json: { name: 'Magic link', color: '#16a34a' },
    });
    const { profile } = (await made.json()) as { profile: { id: string } };
    const loggedIn = async () =>
      (
        (await (await req('/api/m/browser/profiles', owner.token)).json()) as {
          profiles: { id: string; loggedIn: boolean }[];
        }
      ).profiles.find((x) => x.id === profile.id)!.loggedIn;
    const clear = () =>
      req(`/api/m/browser/profiles/${profile.id}`, owner.token, {
        method: 'PATCH',
        json: { loggedIn: false },
      });
    try {
      // the owner pastes a magic link into the address bar: no typing into the page at all
      const nav = await req(`/api/m/browser/profiles/${profile.id}/navigate`, owner.token, {
        method: 'POST',
        json: { url: pageUrl },
      });
      expect(nav.status).toBe(200);
      expect(await loggedIn()).toBe(true);
      for (const input of [
        { kind: 'click', x: 0.1, y: 0.1 },
        { kind: 'scroll', dy: 100 },
        { kind: 'key', key: 'Enter' },
      ]) {
        await clear();
        expect(await loggedIn()).toBe(false);
        const r = await req(`/api/m/browser/profiles/${profile.id}/input`, owner.token, {
          method: 'POST',
          json: input,
        });
        expect(r.status).toBe(200);
        expect(await loggedIn()).toBe(true);
      }
      // a refused key changes nothing
      await clear();
      const bad = await req(`/api/m/browser/profiles/${profile.id}/input`, owner.token, {
        method: 'POST',
        json: { kind: 'key', key: 'F12' },
      });
      expect(bad.status).toBe(400);
      expect(await loggedIn()).toBe(false);
    } finally {
      await req(`/api/m/browser/profiles/${profile.id}`, owner.token, { method: 'DELETE' });
    }
  }, 60_000);

  it('a logged-in profile asks at tier 3; owner typing in the live view marks a profile logged in', async () => {
    const { profiles } = (await (await req('/api/m/browser/profiles', owner.token)).json()) as {
      profiles: { id: string; name: string }[];
    };
    const p = profiles.find((x) => x.name === '')!;
    // the owner types into the page from the live view: sign-ins live here now
    const typed = await req(`/api/m/browser/profiles/${p.id}/input`, owner.token, {
      method: 'POST',
      json: { kind: 'type', text: 'nena@example.com' },
    });
    expect(typed.status).toBe(200);
    const after = (await (await req('/api/m/browser/profiles', owner.token)).json()) as {
      profiles: { id: string; loggedIn: boolean }[];
    };
    expect(after.profiles.find((x) => x.id === p.id)!.loggedIn).toBe(true);

    const replyP = probe('browser_snapshot', { profile: p.id });
    const approval = await waitFor(async () => {
      const j = (await (await req('/api/v1/approvals', owner.token)).json()) as {
        approvals: { id: string; tier: number; state: string }[];
      };
      return j.approvals.find((a) => a.state === 'pending');
    });
    expect(approval.tier).toBe(3);
    const deny = await req(`/api/v1/approvals/${approval.id}/deny`, owner.token, { method: 'POST' });
    expect(deny.status).toBe(200);
    expect(await replyP).toContain('not approved (denied)');

    // the owner clears the flag: back to tier 2 (trusted agent, owner turn: runs without asking)
    await req(`/api/m/browser/profiles/${p.id}`, owner.token, { method: 'PATCH', json: { loggedIn: false } });
    expect(await probe('browser_navigate', { url: pageUrl, profile: p.id })).toContain('Hello tindahan');
  }, 60_000);

  it('stopping a profile ends its Chromium', async () => {
    const { profiles } = (await (await req('/api/m/browser/profiles', owner.token)).json()) as {
      profiles: { id: string; running: boolean }[];
    };
    const p = profiles.find((x) => x.running)!;
    expect(chromiumFor(mod.manager().profilesDir).length).toBeGreaterThan(0);
    await req(`/api/m/browser/profiles/${p.id}/stop`, owner.token, { method: 'POST' });
    await waitFor(
      async () => (chromiumFor(mod.manager().profilesDir).length === 0 ? true : undefined),
      10_000,
    );
  }, 30_000);
});
