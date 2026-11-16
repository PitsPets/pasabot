/** `pasabot status`: is the server up, which version, who am I. */
import { api, defineCommand, readSession, serverUrl } from '../command.js';

export default defineCommand({
  name: 'status',
  summary: 'show server health and the signed-in user',
  async run() {
    const url = readSession()?.url ?? serverUrl();
    let health: { status: number; json: any };
    try {
      health = await api('/api/v1/health');
    } catch {
      process.stdout.write(`server: not reachable at ${url}\n`);
      return 1;
    }
    process.stdout.write(`server: ${url} up (version ${health.json.version}, id ${health.json.serverId})\n`);
    const setup = await api('/api/v1/setup', { token: '' });
    if (setup.json?.needsSetup) process.stdout.write('owner:  none yet (run `pasabot setup-link`)\n');
    const me = await api('/api/v1/me');
    process.stdout.write(
      me.status === 200
        ? `user:   ${me.json.user.displayName} (${me.json.user.kind})\n`
        : 'user:   not signed in\n',
    );
    return 0;
  },
});
