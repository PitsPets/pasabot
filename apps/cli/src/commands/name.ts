/** `pasabot name [new name]`: show or set this server's display name (owner session). */
import { api, defineCommand } from '../command.js';

export default defineCommand({
  name: 'name',
  summary: "show or set the server's display name",
  async run(args) {
    if (args.length === 0) {
      const r = await api('/api/v1/server');
      process.stdout.write(`${r.json.name ?? '(unnamed)'}\n`);
      return r.status === 200 ? 0 : 1;
    }
    const r = await api('/api/v1/server/name', { method: 'PUT', body: { name: args.join(' ') } });
    if (r.status !== 200) throw new Error(r.json?.error ?? `failed (${r.status})`);
    process.stdout.write(`Server is now called ${r.json.name}.\n`);
    return 0;
  },
});
