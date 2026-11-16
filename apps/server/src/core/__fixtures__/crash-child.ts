/**
 * Child process for test:crash. Boots a server on $1 (PASABOT_HOME) whose FakeProvider runs never finish, enqueues
 * the scenario from $2 (JSON), prints RUNNING once the expected items are running, then waits to be SIGKILLed (crash) or SIGTERMed (graceful shutdown, as in main.ts).
 */
import { FakeProvider } from '@pasabot/provider-fake';
import { startServer } from '../../host/server.js';

const [home, scenarioJson] = process.argv.slice(2);
const scenario = JSON.parse(scenarioJson!) as {
  items: { agentId: string; chatId: string | null; kind: string; label: string }[];
  expectRunning: number;
};
const slow = new FakeProvider({
  script: [
    { event: { type: 'session', nativeRef: 'crash-session' } },
    { event: { type: 'text.delta', text: 'working' } },
    { after: 600_000, event: { type: 'text.final', text: 'never' } },
  ],
});
const s = await startServer({
  home: home!,
  root: null,
  logLevel: 'silent',
  providers: [slow],
  dispatcher: { renewMs: 50 },
});
// same graceful shutdown as main.ts
const stop = () => {
  void s.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const it of scenario.items) {
  s.queue.enqueue({
    agentId: it.agentId,
    chatId: it.chatId,
    kind: it.kind,
    payload: { text: it.label, label: it.label },
    source: { sender: { kind: 'owner', id: 'o', name: 'Owner', trust: 'trusted' } },
  });
}
const poll = setInterval(() => {
  const n = (
    s.db.prepare("SELECT count(*) AS n FROM queue_items WHERE state = 'running'").get() as { n: number }
  ).n;
  const runs = (
    s.db.prepare("SELECT count(*) AS n FROM run_events WHERE type = 'session'").get() as { n: number }
  ).n;
  // every in-flight reply has saved its first text, so a crash always has a partial to keep
  const bare = (
    s.db.prepare("SELECT count(*) AS n FROM messages WHERE status = 'streaming' AND body = ''").get() as {
      n: number;
    }
  ).n;
  if (n >= scenario.expectRunning && runs >= scenario.expectRunning && bare === 0) {
    clearInterval(poll);
    process.stdout.write('RUNNING\n');
  }
}, 20);
