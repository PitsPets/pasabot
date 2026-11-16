/** Port choice: keep the preferred port while it is free (paired phones and bookmarks keep working), else ask for 0. */
import { createServer } from 'node:net';

export const LOOPBACK = '127.0.0.1';

/** true when nothing listens on `port` at `host` right now (a probe: bind, then release at once) */
export function portFree(port: number, host = LOOPBACK): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * The port to hand the server: `preferred` when it is free, else 0 so the OS picks one and the server reports it back
 * (ARCHITECTURE 4.3 `pasabot:ready`). Between the probe and the server's bind another process may take the port; the
 * launcher then retries once with 0.
 */
export async function pickPort(preferred: number, host = LOOPBACK): Promise<number> {
  if (!Number.isInteger(preferred) || preferred <= 0 || preferred >= 65536) return 0;
  return (await portFree(preferred, host)) ? preferred : 0;
}

export const portOf = (url: string): number => {
  const u = new URL(url);
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
};
