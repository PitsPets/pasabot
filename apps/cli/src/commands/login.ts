/** `pasabot login`: owner password -> session token stored 0600 for later commands. */
import { api, defineCommand, prompt, serverUrl, writeSession } from '../command.js';

export default defineCommand({
  name: 'login',
  summary: 'sign in to the server as the owner',
  async run() {
    const password = process.env.PASABOT_PASSWORD ?? (await prompt('Password: ', true));
    const r = await api('/api/v1/auth/login', { body: { password }, token: '' });
    if (r.status !== 200) throw new Error(r.json?.error ?? `login failed (${r.status})`);
    writeSession({ url: serverUrl(), token: r.json.token });
    process.stdout.write(`Signed in as ${r.json.user.displayName}.\n`);
    return 0;
  },
});
