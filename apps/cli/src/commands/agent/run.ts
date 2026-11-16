/** `pasabot run <agent> <text> [--wait | --stream] [--json] [--timeout s]`: start work on an agent with its automation token. */
import { defineCommand } from '../../command.js';
import { automationApi, parseFlags, refusal, tokenFor } from './shared.js';

const TERMINAL = ['done', 'failed', 'cancelled', 'interrupted'];
const USAGE = 'usage: pasabot run <agent> <text> [--wait | --stream] [--json] [--timeout <seconds>]';

export default defineCommand({
  name: 'run',
  summary: "start work on an agent with its automation token (--wait prints the agent's reply)",
  async run(args) {
    const f = parseFlags(args, ['wait', 'stream', 'json']);
    const [slug, ...words] = f._;
    const text = words.join(' ').trim();
    if (!slug || !text) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const t = tokenFor(slug);
    if (!t)
      throw new Error(`no automation token for "${slug}" here; run \`pasabot token create ${slug}\` first`);
    const started = await automationApi(t, '/runs', { body: { text, agent: slug } });
    if (started.status !== 202) {
      process.stderr.write(`pasabot run: ${refusal(started.status, started.json)}\n`);
      return started.status === 429 ? 3 : 1;
    }
    let run = started.json.run as { id: string; state: string; reply: string | null; error: string | null };
    const timeoutMs = Number(f.timeout ?? 600) * 1000;
    const deadline = Date.now() + timeoutMs;

    if (f.stream) {
      const r = await fetch(`${t.url}/api/m/automation/runs/${run.id}/stream`, {
        headers: { authorization: `Bearer ${t.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status !== 200 || !r.body) {
        process.stderr.write(`pasabot run: ${refusal(r.status, null)}\n`);
        return 1;
      }
      let shown = '';
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'delta' && typeof d.text === 'string' && d.text.startsWith(shown)) {
            process.stdout.write(d.text.slice(shown.length));
            shown = d.text;
          } else if (ev === 'done') run = d;
        }
      }
      if (shown && !shown.endsWith('\n')) process.stdout.write('\n');
      if (!shown && run.reply) process.stdout.write(`${run.reply}\n`);
      return run.state === 'done' ? 0 : 1;
    }

    if (f.wait) {
      while (!TERMINAL.includes(run.state) && Date.now() < deadline) {
        const wait = Math.min(30_000, Math.max(1000, deadline - Date.now()));
        const r = await automationApi(t, `/runs/${run.id}?wait=${wait}`);
        if (r.status !== 200) {
          process.stderr.write(`pasabot run: ${refusal(r.status, r.json)}\n`);
          return 1;
        }
        run = r.json.run;
      }
    }
    if (f.json) process.stdout.write(`${JSON.stringify(run)}\n`);
    else if (!f.wait) process.stdout.write(`${run.id} ${run.state}\n`);
    else if (run.state === 'done') process.stdout.write(`${run.reply ?? ''}\n`);
    else
      process.stderr.write(
        `pasabot run: run ${run.id} ended ${run.state}${run.error ? `: ${run.error}` : ''}\n`,
      );
    if (!f.wait) return 0;
    return run.state === 'done' ? 0 : 1;
  },
});
