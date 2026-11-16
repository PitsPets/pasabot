/** `pasabot list`: the agents, whether automation is on for each, and which ones this computer holds a token for. */
import { api, defineCommand } from '../../command.js';
import { baseUrl, readTokens } from './shared.js';

export default defineCommand({
  name: 'list',
  summary: 'list agents with their automation switch and local tokens',
  async run() {
    const r = await api('/api/m/automation/agents');
    if (r.status === 401) throw new Error('not signed in; run `pasabot login` first');
    if (r.status !== 200) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    const url = baseUrl();
    const local = new Set(
      readTokens()
        .filter((t) => t.url === url)
        .map((t) => t.slug),
    );
    const agents = r.json.agents as { slug: string; name: string; enabled: boolean; activeTokens: number }[];
    if (agents.length === 0) process.stdout.write('no agents yet\n');
    for (const a of agents)
      process.stdout.write(
        `${a.slug.padEnd(16)} ${a.name.padEnd(20)} automation ${a.enabled ? 'on ' : 'off'}  tokens ${a.activeTokens}${local.has(a.slug) ? '  (token saved here)' : ''}\n`,
      );
    return 0;
  },
});
