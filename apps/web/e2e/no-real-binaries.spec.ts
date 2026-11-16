/**
 * The throwaway e2e server never drives a real external binary: machine linking runs over loopback TCP+TLS, not the
 * tailcat CLI (which would start on any machine that has it on PATH and reach the public relays). PASABOT_LIVE=tailcat
 * is the only way to get the real CLI.
 */
import { claimServer, expect, test } from './fixtures.js';

test.skip(process.env.PASABOT_LIVE === 'tailcat', 'live tailcat run');

test('e2e server: machine linking uses loopback TCP+TLS, never the real tailcat CLI', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  // from the page itself (same origin, the owner's session), as the Machines screen asks for it
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/m/link/status', { credentials: 'same-origin' });
    return { code: r.status, body: (await r.json().catch(() => null)) as { transport?: string } | null };
  });
  expect(status.code).toBe(200);
  expect(status.body?.transport).toBe('tcp-tls');
});
