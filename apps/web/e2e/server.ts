/**
 * A throwaway PasaBot server for one Playwright test (and for QA scripts): temp $PASABOT_HOME, port 0, the built web
 * app at `/`, and every module, plugin and channel package of the workspace, found by the same discovery the real
 * server uses (sample modules `modules/_*` stay out, as in a production web build). The brain is the FakeProvider,
 * which echoes, runs `{"fakeScript": [...]}` and calls gateway tools for `{"probe": {"name", "args"}}`. Channels:
 * the reference FakeChannel with a loopback control port that plays the chat platform (deliver / inject messages,
 * read what the bot sent), the WhatsApp adapter on a mocked linked-device socket (`/wa/qr` rotates the QR code,
 * `/wa/scan` plays the phone scanning it), and the other discovered channels as they ship (they connect only once
 * bound). Prints `{ url, sitesUrl, setupLink, channelControl, modules }` as one JSON line, then runs until stdin
 * closes or SIGTERM.
 * Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhatsAppAdapter, type WaSocket, type WaSocketFactory } from '@pasabot/channel-whatsapp';
import type { ChannelAdapter, InboundMessage, PasaBotModule } from '@pasabot/core';
import { FakeProvider } from '@pasabot/provider-fake';
import { discoverPackages, findWorkspaceRoot, loadEntry, startServer } from '@pasabot/server';
import { type ContractActor, type ContractPlace, FakeChannel, FakeChannelPlatform } from '@pasabot/testkit';

/** The FakeChannel platform, plus redelivery of a message (what a real platform does after a restart). */
class E2EPlatform extends FakeChannelPlatform {
  readonly seen: InboundMessage[] = [];
  private mine = new Set<(m: InboundMessage) => void>();
  override listen(fn: (m: InboundMessage) => void) {
    this.mine.add(fn);
    const off = super.listen((m) => {
      this.seen.push(m);
      fn(m);
    });
    return () => {
      this.mine.delete(fn);
      return off();
    };
  }
  inject(m: InboundMessage) {
    for (const l of this.mine) l(m);
  }
}
const platform = new E2EPlatform();

/** WhatsApp: a mocked linked-device socket; the newest one is the "phone" the control port talks to. */
const wa = { seq: 0, emit: (_ev: string, _a?: unknown) => {}, sent: [] as { jid: string; text: string }[] };
const waSocket: WaSocketFactory = async ({ state }) => {
  const h: Record<string, ((a: unknown) => void)[]> = {};
  let ended = false;
  const emit = (ev: string, a?: unknown) => {
    if (!ended) for (const f of h[ev] ?? []) f(a);
  };
  wa.emit = emit;
  setTimeout(() => {
    if (state === null) emit('qr', `pasabot-e2e-qr-${++wa.seq}`);
    else emit('open', { jid: '639170000000:7@s.whatsapp.net', name: 'PasaBot' });
  }, 20);
  return {
    on(ev: string, fn: (a: unknown) => void) {
      h[ev] = [...(h[ev] ?? []), fn];
    },
    async sendText(jid: string, text: string) {
      wa.sent.push({ jid, text });
      return { id: `W${++wa.seq}` };
    },
    async editText() {},
    end() {
      ended = true;
    },
  } as WaSocket;
};

// every module/plugin/channel package of the workspace, from its TypeScript source (no stale dist)
process.env.PASABOT_SOURCE = '1';
// never the real tailcat CLI (it would run on any machine that has it on PATH, and touch the public relays): machine
// linking runs over TCP+TLS on loopback port 0 here, unless the live gate asks for the real thing
if (process.env.PASABOT_LIVE !== 'tailcat') {
  process.env.PASABOT_LINK_TRANSPORT = 'tcp-tls';
  process.env.PASABOT_LINK_HOST = '127.0.0.1';
  process.env.PASABOT_LINK_PORT = '0';
  delete process.env.PASABOT_LINK_ADVERTISE;
}
// never the real Ollama / LM Studio of the machine running the tests: the Local model brain finds no app here
process.env.PASABOT_LOCAL_FIND = '0';
const root = findWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)));
if (!root) throw new Error('e2e server: no workspace root');
const mocked: ChannelAdapter<any>[] = [
  new FakeChannel(platform),
  createWhatsAppAdapter({ socket: waSocket }),
];
const modules: PasaBotModule[] = [];
const channels: ChannelAdapter<any>[] = [...mocked];
for (const p of discoverPackages(root)) {
  if (p.id.startsWith('_')) continue; // samples: shown in dev and slot tests only
  if (p.pasabot.kind === 'module' || p.pasabot.kind === 'plugin')
    modules.push(await loadEntry<PasaBotModule>(p));
  else if (p.pasabot.kind === 'channel') {
    const c = await loadEntry<ChannelAdapter<any>>(p);
    if (!mocked.some((m) => m.kind === c.kind)) channels.push(c);
  }
}

// a test that restarts the server on the same data dir passes PASABOT_E2E_HOME (and removes it itself)
const fixedHome = process.env.PASABOT_E2E_HOME;
const home = fixedHome ?? mkdtempSync(join(tmpdir(), 'pasabot-e2e-'));
// "Found on this computer" (connectors) reads other apps' config files under a home folder: the temp home here,
// never the real one, unless a spec hands it a fake home of its own
process.env.PASABOT_CONNECTORS_SCAN_HOME ??= home;
const s = await startServer({
  home,
  root: null,
  host: '127.0.0.1',
  port: 0,
  sitesPort: 0,
  logLevel: 'silent',
  printSetupLink: false,
  vault: { source: 'passphrase', passphrase: 'pasabot-e2e-passphrase' },
  runnerMode: 'host-unsandboxed',
  providers: [new FakeProvider({ deltaMs: 30 })],
  modules,
  channels,
  // previews stay under the fake platform's 100-character limit
  channelRuntime: { previewMax: 90, editMs: 200 },
  webDir: fileURLToPath(new URL('../dist', import.meta.url)),
});

// the "chat platform" side for tests: loopback only, port 0
const control = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', async () => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const j = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      let out: unknown = { ok: true };
      if (req.method === 'POST' && u.pathname === '/deliver')
        await platform.deliver(
          j as { from: ContractActor; place: ContractPlace; text: string; mention?: boolean },
        );
      else if (req.method === 'POST' && u.pathname === '/inject')
        platform.inject(j as unknown as InboundMessage);
      else if (u.pathname === '/seen') out = platform.seen;
      else if (req.method === 'POST' && u.pathname === '/wa/qr') wa.emit('qr', `pasabot-e2e-qr-${++wa.seq}`);
      else if (req.method === 'POST' && u.pathname === '/wa/scan') {
        wa.emit('state', '{"session":"e2e-linked"}');
        wa.emit('close', { loggedOut: false, restartRequired: true });
      } else if (u.pathname === '/bot')
        out = platform.botTexts(platform.places[(u.searchParams.get('place') ?? 'dm') as ContractPlace]);
      else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
});
await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
const port = (control.address() as { port: number }).port;
process.stdout.write(
  `${JSON.stringify({
    url: s.url,
    sitesUrl: s.sitesUrl,
    setupLink: s.setupLink,
    channelControl: `http://127.0.0.1:${port}`,
    modules: s.modules,
  })}\n`,
);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  control.close();
  await s.close().catch(() => {});
  if (!fixedHome) rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
