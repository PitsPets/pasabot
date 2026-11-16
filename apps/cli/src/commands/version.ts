/** `pasabot version`: CLI version (and the server's when reachable). */
import { readFileSync } from 'node:fs';
import { api, defineCommand } from '../command.js';

export default defineCommand({
  name: 'version',
  summary: 'print the CLI and server versions',
  async run() {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    process.stdout.write(`cli ${pkg.version}\n`);
    try {
      const h = await api('/api/v1/health');
      process.stdout.write(`server ${h.json.version}\n`);
    } catch {
      process.stdout.write('server not reachable\n');
    }
    return 0;
  },
});
