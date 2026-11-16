/** `pasabot stop`: stop the server. */
import { defineCommand } from '../../command.js';
import { stopServer } from './lifecycle.js';
import { defaultCtx } from './shared.js';

export default defineCommand({
  name: 'stop',
  summary: 'stop the server',
  async run() {
    const ctx = defaultCtx();
    ctx.out(`pasabot: ${await stopServer(ctx)}\n`);
    return 0;
  },
});
