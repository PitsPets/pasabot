/**
 * `pasabot providers install <id>` against a fake PasaBot server on 127.0.0.1 port 0 (temp config dir, no network,
 * no real installer): it shows what/where/from, sends consent only after a `y` or `--yes`, refuses without a
 * terminal, and is listed in --help.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeSession } from '../command.js';
import { main } from '../main.js';
import { providersCommand } from './providers.js';

const dir = mkdtempSync(join(tmpdir(), 'pasabot-cli-providers-'));
const posts: { path: string; body: any; auth: string | undefined }[] = [];
let srv: Server;
const env = { ...process.env };

beforeAll(async () => {
  srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer owner-token') {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.method === 'GET' && req.url === '/api/m/templates/providers/installable')
        return res.end(
          JSON.stringify({
            providers: [
              {
                id: 'opencode',
                what: 'OpenCode CLI',
                where: '/home/x/.local/bin/opencode',
                from: 'https://example.invalid/release',
                checksum: 'sha256',
                installed: null,
              },
            ],
          }),
        );
      if (req.method === 'POST' && req.url === '/api/m/templates/providers/opencode/install') {
        posts.push({ path: req.url, body: JSON.parse(b), auth: req.headers.authorization });
        return res.end(
          JSON.stringify({ installed: { binPath: '/home/x/.local/bin/opencode', version: 'v1.2.3' } }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  process.env.XDG_CONFIG_HOME = dir;
  writeSession({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, token: 'owner-token' });
});
afterAll(async () => {
  process.env = env;
  await new Promise<void>((r) => srv.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  posts.length = 0;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    restore() {
      o.mockRestore();
      e.mockRestore();
    },
  };
}

describe('pasabot providers install', () => {
  it('is listed in --help', async () => {
    const c = capture();
    try {
      expect(await main(['--help'])).toBe(0);
      expect(c.out()).toMatch(/\n {2}providers +install <id>/);
    } finally {
      c.restore();
    }
  });

  it('shows what, where and from where, and installs only after the owner says yes', async () => {
    const asked: string[] = [];
    const cmd = providersCommand({ ask: async (q) => (asked.push(q), 'y'), isTTY: () => true });
    const c = capture();
    try {
      expect(await cmd.run(['install', 'opencode'])).toBe(0);
    } finally {
      c.restore();
    }
    expect(c.out()).toContain('This installs OpenCode CLI');
    expect(c.out()).toContain('to:   /home/x/.local/bin/opencode');
    expect(c.out()).toContain('from: https://example.invalid/release');
    expect(c.out()).toContain('SHA256');
    expect(c.out()).toContain('installed OpenCode CLI v1.2.3');
    expect(asked).toHaveLength(1);
    expect(posts).toEqual([
      {
        path: '/api/m/templates/providers/opencode/install',
        body: { consent: true },
        auth: 'Bearer owner-token',
      },
    ]);
  });

  it('a "no" installs nothing; no terminal and no --yes installs nothing; --yes skips the question', async () => {
    const c = capture();
    try {
      expect(
        await providersCommand({ ask: async () => 'n', isTTY: () => true }).run(['install', 'opencode']),
      ).toBe(1);
      await expect(providersCommand({ isTTY: () => false }).run(['install', 'opencode'])).rejects.toThrow(
        /add --yes/,
      );
      expect(posts).toEqual([]);
      const never = vi.fn(async () => 'n');
      expect(
        await providersCommand({ ask: never, isTTY: () => false }).run(['install', 'opencode', '--yes']),
      ).toBe(0);
      expect(never).not.toHaveBeenCalled();
      expect(posts).toHaveLength(1);
    } finally {
      c.restore();
    }
  });

  it('an unknown id names what can be installed; a bad call prints the usage', async () => {
    const c = capture();
    try {
      await expect(providersCommand().run(['install', 'nope', '--yes'])).rejects.toThrow(
        'no installer for "nope" (installable: opencode)',
      );
      expect(await providersCommand().run(['install'])).toBe(2);
      expect(c.err()).toContain('usage: pasabot providers install <id>');
      expect(await providersCommand().run(['list'])).toBe(0);
      expect(c.out()).toContain('opencode     OpenCode CLI');
    } finally {
      c.restore();
    }
    expect(posts).toEqual([]);
  });
});
