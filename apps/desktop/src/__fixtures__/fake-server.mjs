// A stand-in for pasabot-server that speaks the parent channel (ARCHITECTURE 4.3). Knobs (env):
//   FAKE_PID_FILE      write our pid here
//   FAKE_STUBBORN=1    ignore SIGTERM and the channel closing (only SIGKILL ends it)
//   FAKE_CRASH=1       exit 3 before ready
//   FAKE_SETUP=1       no owner: ready carries a setup link, and each `pasabot:setup-link` ask gets a new one
//   FAKE_LINK_MUTE=1   never answer a `pasabot:setup-link` ask
//   FAKE_OWNER_FILE    once this file exists an owner has claimed the server: a `pasabot:setup-link` ask gets null
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_CRASH === '1') process.exit(3);

const listen = (port) =>
  new Promise((resolve, reject) => {
    const s = createServer((_req, res) => res.end('{"ok":true}'));
    s.once('error', reject);
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(s));
  });

let state = { stopped: false, since: null };
let asks = 0;
try {
  const web = await listen(Number(process.env.PASABOT_PORT ?? 0));
  const sites = await listen(Number(process.env.PASABOT_SITES_PORT ?? 0));
  const stubborn = process.env.FAKE_STUBBORN === '1';
  const bye = () => {
    if (!stubborn) process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('disconnect', bye);
  process.on('message', (m) => {
    if (m?.type === 'pasabot:state') process.send({ type: 'pasabot:state', ...state });
    if (m?.type === 'pasabot:stop-all') {
      state = { stopped: true, since: Date.now() };
      process.send({ type: 'pasabot:state', ...state });
    }
    if (m?.type === 'pasabot:setup-link' && process.env.FAKE_LINK_MUTE !== '1') {
      asks += 1;
      process.send({
        type: 'pasabot:setup-link',
        setupLink:
          process.env.FAKE_SETUP === '1' &&
          !(process.env.FAKE_OWNER_FILE && existsSync(process.env.FAKE_OWNER_FILE))
            ? `http://127.0.0.1:${web.address().port}/#/setup?token=t${asks}`
            : null,
      });
    }
  });
  process.send({
    type: 'pasabot:ready',
    url: `http://127.0.0.1:${web.address().port}`,
    sitesUrl: `http://127.0.0.1:${sites.address().port}`,
    setupLink:
      process.env.FAKE_SETUP === '1' ? `http://127.0.0.1:${web.address().port}/#/setup?token=t` : null,
    stopped: false,
  });
  setInterval(() => {}, 1 << 30);
} catch (e) {
  process.stderr.write(`fake server: ${e.message}\n`);
  process.exit(2);
}
