/** `pasabot start`: start the server through its service manager, or as a background process when none is installed. */
import { defineCommand } from '../../command.js';
import { startServer } from './lifecycle.js';
import { defaultCtx } from './shared.js';

export default defineCommand({
  name: 'start',
  summary: 'start the server (service if installed, else a background process)',
  async run() {
    const ctx = defaultCtx();
    ctx.out(`pasabot: ${await startServer(ctx)}\n`);
    return 0;
  },
});
