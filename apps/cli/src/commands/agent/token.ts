/**
 * `pasabot token create <agent> | list | revoke <id>`: per-agent automation tokens (owner session from `pasabot login`).
 * A created token is saved 0600 for `pasabot run`; `--print` also writes it to stdout for a script elsewhere.
 */
import { api, defineCommand } from '../../command.js';
import { baseUrl, forgetToken, parseFlags, saveToken } from './shared.js';

const USAGE = `usage:
  pasabot token create <agent> [--label <name>] [--days <n> | --no-expiry] [--remote] [--rate <n>] [--guarded] [--enable] [--print]
  pasabot token list
  pasabot token revoke <id>`;

interface Agent {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
}
async function agentBySlug(slug: string): Promise<Agent> {
  const r = await api('/api/m/automation/agents');
  if (r.status === 401) throw new Error('not signed in; run `pasabot login` first');
  if (r.status !== 200) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
  const a = (r.json.agents as Agent[]).find((x) => x.slug === slug || x.id === slug);
  if (!a) throw new Error(`no agent "${slug}"`);
  return a;
}
const when = (ms: number | null) =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'never';

export default defineCommand({
  name: 'token',
  summary: 'create, list or revoke per-agent automation tokens',
  async run(args) {
    const f = parseFlags(args, ['remote', 'guarded', 'enable', 'print', 'no-expiry']);
    const [sub, arg] = f._;
    if (sub === 'create' && arg) {
      const agent = await agentBySlug(arg);
      if (!agent.enabled) {
        if (!f.enable)
          throw new Error(
            `automation is off for ${agent.slug}; turn it on in Settings → Automation or pass --enable`,
          );
        const on = await api(`/api/m/automation/agents/${agent.id}`, {
          method: 'PUT',
          body: { enabled: true },
        });
        if (on.status !== 200) throw new Error(on.json?.message ?? `HTTP ${on.status}`);
      }
      const r = await api('/api/m/automation/tokens', {
        body: {
          agentId: agent.id,
          label:
            typeof f.label === 'string'
              ? f.label
              : `cli on ${process.env.HOSTNAME ?? 'this computer'}`.slice(0, 60),
          trust: f.guarded ? 'guarded' : 'standard',
          remoteOk: !!f.remote,
          ...(typeof f.rate === 'string' ? { ratePerHour: Number(f.rate) } : {}),
          expiresInDays: f['no-expiry'] ? null : typeof f.days === 'string' ? Number(f.days) : 90,
        },
      });
      if (r.status !== 201) throw new Error(r.json?.message ?? r.json?.error ?? `HTTP ${r.status}`);
      saveToken({ url: baseUrl(), slug: agent.slug, id: r.json.info.id, token: r.json.token });
      process.stderr.write(
        `Token ${r.json.info.id} for ${agent.slug} saved (expires ${when(r.json.info.expiresAt)}). Try: pasabot run ${agent.slug} "hello" --wait\n`,
      );
      if (f.print) process.stdout.write(`${r.json.token}\n`);
      return 0;
    }
    if (sub === 'list') {
      const r = await api('/api/m/automation/tokens');
      if (r.status !== 200)
        throw new Error(r.status === 401 ? 'not signed in; run `pasabot login` first' : `HTTP ${r.status}`);
      const rows = r.json.tokens as {
        id: string;
        label: string;
        agentName: string | null;
        active: boolean;
        trust: string;
        remoteOk: boolean;
        expiresAt: number | null;
        lastUsedAt: number | null;
      }[];
      if (rows.length === 0) process.stdout.write('no automation tokens\n');
      for (const t of rows)
        process.stdout.write(
          `${t.id}  ${(t.agentName ?? '?').padEnd(14)} ${t.label.padEnd(20)} ${t.active ? 'active ' : 'revoked'} ${t.trust}${t.remoteOk ? ' remote' : ''}  expires ${when(t.expiresAt)}  last used ${when(t.lastUsedAt)}\n`,
        );
      return 0;
    }
    if (sub === 'revoke' && arg) {
      const r = await api(`/api/m/automation/tokens/${encodeURIComponent(arg)}/revoke`, {
        method: 'POST',
        body: {},
      });
      if (r.status !== 200) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
      forgetToken(arg);
      process.stdout.write(`revoked ${arg}\n`);
      return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  },
});
