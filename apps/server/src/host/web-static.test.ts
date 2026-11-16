import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { serveWebApp } from './web-static.js';

describe('web app CSP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pasabot-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('may frame the sites origin only (HTML blocks), and nothing when there is none', async () => {
    const app = Fastify();
    let origins: string[] = [];
    serveWebApp(app, dir, () => origins);
    const csp = async () => (await app.inject({ url: '/' })).headers['content-security-policy'] as string;
    expect(await csp()).toContain("frame-src 'none'");
    origins = ['http://127.0.0.1:4321'];
    const c = await csp();
    expect(c).toContain('frame-src http://127.0.0.1:4321;');
    expect(c).not.toMatch(/frame-src[^;]*'self'/);
    expect(c).toContain("frame-ancestors 'none'");
    await app.close();
  });
});
