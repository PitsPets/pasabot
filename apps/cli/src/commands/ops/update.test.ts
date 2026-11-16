import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRelease, loadTrustedKeys, ReleaseError, readTarGz } from './release.js';
import type { OpsCtx } from './shared.js';
import { update } from './update.js';

/** Minimal ustar writer for fixtures (type '0' file, '5' dir, '2' symlink, '1' hardlink). */
function tarGz(entries: { name: string; type?: string; data?: string; link?: string; mode?: number }[]) {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const release = (version: string, extra: Parameters<typeof tarGz>[0] = []) =>
  tarGz([
    { name: `pasabot-${version}/`, type: '5' },
    { name: `pasabot-${version}/pasabot-release.json`, data: JSON.stringify({ name: 'pasabot', version }) },
    {
      name: `pasabot-${version}/apps/server/dist/host/main.js`,
      data: `// server ${version}\n`,
      mode: 0o4755,
    },
    ...extra,
  ]);

let dir: string;
let priv: KeyObject;
let keys: KeyObject[];
const sigOf = (b: Buffer, k = priv) => sign(null, b, k).toString('base64');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pasabot-update-'));
  const kp = generateKeyPairSync('ed25519');
  priv = kp.privateKey;
  keys = [kp.publicKey];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('signed release check', () => {
  it('installs a correctly signed release and switches `current`', () => {
    const tb = release('1.0.0');
    const r = applyRelease({ tarball: tb, sig: sigOf(tb), keys, prefix: dir });
    expect(r).toMatchObject({ version: '1.0.0', previous: null });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('releases', '1.0.0'));
    const main = join(dir, 'current', 'apps', 'server', 'dist', 'host', 'main.js');
    expect(readFileSync(main, 'utf8')).toContain('server 1.0.0');
    expect(statSync(main).mode & 0o7777).toBe(0o755); // setuid bit stripped
  });

  it('refuses a tampered tarball and changes nothing', () => {
    const tb = release('1.0.0');
    const sig = sigOf(tb);
    const tampered = Buffer.from(tb);
    const i = tampered.length - 30;
    tampered[i] = tampered[i]! ^ 0xff;
    expect(() => applyRelease({ tarball: tampered, sig, keys, prefix: dir })).toThrow(
      /signature check failed/,
    );
    expect(existsSync(join(dir, 'current'))).toBe(false);
    expect(existsSync(join(dir, 'releases'))).toBe(false);
  });

  it('refuses a release signed by a key that is not pinned', () => {
    const tb = release('1.0.0');
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(() => applyRelease({ tarball: tb, sig: sigOf(tb, other), keys, prefix: dir })).toThrow(
      /not signed by a pinned release key/,
    );
  });

  it('refuses when no key is pinned and when the signature is garbage', () => {
    const tb = release('1.0.0');
    expect(() => applyRelease({ tarball: tb, sig: sigOf(tb), keys: [], prefix: dir })).toThrow(
      /no release signing key/,
    );
    expect(() => applyRelease({ tarball: tb, sig: 'bm9wZQ==', keys, prefix: dir })).toThrow(ReleaseError);
  });

  it('refuses a downgrade or a reinstall unless asked, and rolls back with --allow-downgrade', () => {
    const v2 = release('2.0.0');
    applyRelease({ tarball: v2, sig: sigOf(v2), keys, prefix: dir });
    const v1 = release('1.0.0');
    expect(() => applyRelease({ tarball: v1, sig: sigOf(v1), keys, prefix: dir })).toThrow(/not newer/);
    expect(() => applyRelease({ tarball: v2, sig: sigOf(v2), keys, prefix: dir })).toThrow(/not newer/);
    applyRelease({ tarball: v1, sig: sigOf(v1), keys, prefix: dir, allowDowngrade: true });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('releases', '1.0.0'));
  });

  it('a signed tarball still cannot carry links, absolute paths or `..`', () => {
    const bad = [
      { name: 'pasabot-1.0.0/evil', type: '2', link: '/etc/passwd' },
      { name: 'pasabot-1.0.0/hard', type: '1', link: 'pasabot-1.0.0/pasabot-release.json' },
      { name: 'pasabot-1.0.0/../../escape.js', data: 'x' },
      { name: '/abs/escape.js', data: 'x' },
    ];
    for (const e of bad) {
      const tb = release('1.0.0', [e]);
      expect(() => applyRelease({ tarball: tb, sig: sigOf(tb), keys, prefix: dir })).toThrow(ReleaseError);
    }
    expect(existsSync(join(dir, 'current'))).toBe(false);
  });

  it('rejects a corrupt header checksum and a version mismatch', () => {
    const tb = release('1.0.0');
    const raw = Buffer.from(gunzipSync(tb));
    raw[0] = 'X'.charCodeAt(0);
    expect(() => readTarGz(gzipSync(raw))).toThrow(/checksum/);
    const wrongTop = tarGz([
      {
        name: 'pasabot-9.9.9/pasabot-release.json',
        data: JSON.stringify({ name: 'pasabot', version: '1.0.0' }),
      },
    ]);
    expect(() => applyRelease({ tarball: wrongTop, sig: sigOf(wrongTop), keys, prefix: dir })).toThrow(
      /does not match/,
    );
  });
});

describe('pasabot update (verb)', () => {
  const ctxFor = (root: string): { ctx: OpsCtx; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      ctx: {
        env: {
          HOME: dir,
          PASABOT_HOME: join(dir, 'home'),
          PASABOT_ROOT: root,
          PASABOT_PREFIX: join(dir, 'prefix'),
          PATH: process.env.PATH,
        },
        platform: process.platform,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
      },
      out,
      err,
    };
  };

  it('reads pinned keys from the installed copy, checks, installs, and refuses a tampered file', async () => {
    const root = join(dir, 'installed');
    mkdirSync(join(root, 'deploy', 'release-keys'), { recursive: true });
    writeFileSync(
      join(root, 'deploy', 'release-keys', 'test.pub'),
      keys[0]!.export({ type: 'spki', format: 'pem' }),
    );
    expect(loadTrustedKeys(root)).toHaveLength(1);
    const { ctx } = ctxFor(root);
    const tbPath = join(dir, 'pasabot-1.2.3.tar.gz');
    const tb = release('1.2.3');
    writeFileSync(tbPath, tb);
    writeFileSync(`${tbPath}.sig`, sigOf(tb));
    expect(await update(ctx, tbPath, { check: true })).toMatch(/signature OK: release 1.2.3/);
    expect(existsSync(join(dir, 'prefix', 'current'))).toBe(false);

    const bad = Buffer.from(tb);
    bad[40] = bad[40]! ^ 1;
    writeFileSync(tbPath, bad);
    await expect(update(ctx, tbPath)).rejects.toThrow(/signature check failed/);
    expect(existsSync(join(dir, 'prefix', 'current'))).toBe(false);

    writeFileSync(tbPath, tb);
    expect(await update(ctx, tbPath, { restart: false })).toMatch(/installed 1.2.3/);
    expect(readlinkSync(join(dir, 'prefix', 'current'))).toBe(join('releases', '1.2.3'));
  });

  it('refuses without a .sig file', async () => {
    const root = join(dir, 'installed');
    mkdirSync(join(root, 'deploy', 'release-keys'), { recursive: true });
    const { ctx } = ctxFor(root);
    const tbPath = join(dir, 'pasabot-1.0.0.tar.gz');
    writeFileSync(tbPath, release('1.0.0'));
    await expect(update(ctx, tbPath)).rejects.toThrow(/signature file not found/);
  });
});
