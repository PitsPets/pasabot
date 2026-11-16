/** `pasabot logout`: end the CLI session on the server and forget it locally. */
import { api, clearSession, defineCommand, readSession } from '../command.js';

export default defineCommand({
  name: 'logout',
  summary: 'sign out and forget the stored session',
  async run() {
    if (readSession()) await api('/api/v1/auth/logout', { body: {} }).catch(() => undefined);
    clearSession();
    process.stdout.write('Signed out.\n');
    return 0;
  },
});
