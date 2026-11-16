/** Serve the built PWA (apps/web/dist) at `/`; unknown paths fall back to index.html (client routing). */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
/** `frame-src` names the sites origin only: agent HTML is framed from there, never from the app origin (8, "Exposure"). */
const cspFor = (frameOrigins: string[]) =>
  `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src ${frameOrigins.length ? frameOrigins.join(' ') : "'none'"}; frame-ancestors 'none'; base-uri 'none'`;

/** `frameOrigins`: origins the app may frame (the sites origin, read per request because it is known after listen). */
export function serveWebApp(app: FastifyInstance, dir: string, frameOrigins: () => string[] = () => []) {
  const root = normalize(dir + sep);
  if (!existsSync(join(root, 'index.html'))) return;
  app.get('/*', async (req, reply) => {
    const url = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
    if (/^(api|ws|mcp|hooks)(\/|$)/.test(url)) return reply.code(404).send({ error: 'not_found' });
    let file = normalize(join(root, url || 'index.html'));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
      file = join(root, 'index.html');
    return reply
      .header('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
      .header('content-security-policy', cspFor(frameOrigins()))
      .header('x-content-type-options', 'nosniff')
      .header(
        'cache-control',
        file.endsWith('index.html') || file.endsWith('sw.js')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      )
      .send(readFileSync(file));
  });
}
