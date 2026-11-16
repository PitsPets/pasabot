/** `pasabot restart`: restart the server. */
import { defineCommand } from '../../command.js';
import { restartServer } from './lifecycle.js';
import { defaultCtx } from './shared.js';

export default defineCommand({
  name: 'restart',
  summary: 'restart the server',
  async run() {
    const ctx = defaultCtx();
    ctx.out(`pasabot: ${await restartServer(ctx)}\n`);
    return 0;
  },
});
