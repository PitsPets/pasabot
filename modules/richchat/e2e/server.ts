/**
 * A throwaway PasaBot server for the W7 Playwright specs: temp $PASABOT_HOME, port 0 (app and sites origin), the
 * built web app, the richchat module and a probe provider. A message whose text is
 * `{"probe":{"name":"<tool>","args":{...}}}` makes the probe call that gateway tool over `/mcp` with its run bearer
 * and reply `tool said: <result>`; any other text is echoed. Prints `{ url, sitesUrl, setupLink }` as one JSON line.
 * Run with: node --import tsx --conditions=source e2e/server.ts
 */
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import { bootTestServer } from '@pasabot/testkit';
import { createRichchatModule } from '../src/server.js';

class Probe implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'Fake';
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
    let call: { name: string; args: unknown } | undefined;
    try {
      call = (JSON.parse(input.user.text) as { probe?: { name: string; args: unknown } }).probe;
    } catch {}
    if (!call) {
      yield { type: 'text.final', text: `echo: ${input.user.text}` };
      yield { type: 'done', stop: 'end' };
      return;
    }
    const r = await fetch(input.mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: call.name, arguments: call.args },
      }),
    });
    const j = (await r.json()) as { result?: { content: { text: string }[] } };
    yield { type: 'text.final', text: `tool said: ${j.result?.content[0]?.text ?? JSON.stringify(j)}` };
    yield { type: 'done', stop: 'end' };
  }
}

// temp $PASABOT_HOME, 127.0.0.1 port 0 for the app and the sites origin, passphrase vault (testkit defaults)
const s = await bootTestServer({
  printSetupLink: false,
  providers: [new Probe()],
  modules: [createRichchatModule()],
  webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
});
process.stdout.write(`${JSON.stringify({ url: s.url, sitesUrl: s.sitesUrl, setupLink: s.setupLink })}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await s.cleanup().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
