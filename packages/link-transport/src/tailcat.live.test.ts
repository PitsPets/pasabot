/**
 * Live check against the REAL tailcat CLI (v0.7.x) on this machine: skipped unless PASABOT_LIVE=tailcat (never in CI).
 * Two identities in temp dirs, each serving with --allow of the other's client key; our peer proof both ways over
 * real tailcat (DERP relays, maybe a direct path); a key not in --allow is refused; no tailcat process is left.
 *
 *   PASABOT_LIVE=tailcat npx vitest run packages/link-transport/src/tailcat.live.test.ts
 *
 * Uses $PASABOT_TAILCAT_BIN or `tailcat` on PATH. Needs outbound internet (the public tailcat DERP relays).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateLinkKeys } from './keys.js';
import { createTailcatTransport } from './tailcat.js';
import type { LinkPeer, LinkStream, LinkTransport } from './types.js';

const live = process.env.PASABOT_LIVE === 'tailcat';
const root = live ? mkdtempSync(join(tmpdir(), 'bk-tclive-')) : '';
const made: LinkTransport[] = [];
const mk = (name: string) => {
  const t = createTailcatTransport({
    keys: generateLinkKeys(),
    stateDir: join(root, name),
    timeoutMs: 15_000,
  });
  made.push(t);
  return t;
};
const ours = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(root) || l.includes('PASABOT_TC_PORT'));
const lines = (s: LinkStream) => {
  let buf = '';
  const waiting: ((l: string) => void)[] = [];
  const ready: string[] = [];
  s.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(l);
      else ready.push(l);
    }
  });
  return () => new Promise<string>((res) => (ready.length ? res(ready.shift()!) : waiting.push(res)));
};

describe.skipIf(!live)('tailcat LIVE (real CLI, real relays)', () => {
  afterAll(async () => {
    await Promise.all(made.map((t) => t.close?.()));
    let left = ours();
    for (let i = 0; i < 60 && left.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      left = ours();
    }
    expect(left).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('serve + dial both ways over real tailcat; a key not in --allow is refused', {
    timeout: 120_000,
  }, async () => {
    const a = mk('a');
    const b = mk('b');
    const c = mk('c'); // never allowed anywhere
    expect(await a.available()).toEqual({ ok: true });
    const [ia, ib] = [await a.identity(), await b.identity()];
    await a.setAllowed!([ib.transportKey!]);
    await b.setAllowed!([ia.transportKey!]);
    const inbound: { at: string; stream: LinkStream; peer: LinkPeer }[] = [];
    const la = await a.listen((stream, peer) => inbound.push({ at: 'a', stream, peer }));
    const lb = await b.listen((stream, peer) => inbound.push({ at: 'b', stream, peer }));
    const addrA = (await a.identity()).address;
    const addrB = (await b.identity()).address;
    expect(addrA.startsWith('tc')).toBe(true);

    for (const [from, to, toAddr, fromKey] of [
      [b, 'a', addrA, ib.publicKey],
      [a, 'b', addrB, ia.publicKey],
    ] as const) {
      const t0 = Date.now();
      const d = await from.dial(toAddr);
      const next = lines(d.stream);
      for (let i = 0; i < 200 && !inbound.some((x) => x.at === to); i++)
        await new Promise((r) => setTimeout(r, 25));
      const got = inbound.splice(
        inbound.findIndex((x) => x.at === to),
        1,
      )[0]!;
      expect(got.peer.publicKey).toBe(fromKey);
      const nextIn = lines(got.stream);
      const rtts: number[] = [];
      for (let i = 0; i < 10; i++) {
        const s = Date.now();
        d.stream.write(`ping ${i}\n`);
        expect(await nextIn()).toBe(`ping ${i}`);
        got.stream.write(`pong ${i}\n`);
        expect(await next()).toBe(`pong ${i}`);
        rtts.push(Date.now() - s);
      }
      console.log(
        `[live] ${to === 'a' ? 'b→a' : 'a→b'}: connected+proved in ${Date.now() - t0 - rtts.reduce((x, y) => x + y, 0)} ms; 10 round trips, median ${rtts.sort((x, y) => x - y)[5]} ms`,
      );
      d.stream.destroy();
      got.stream.destroy();
    }

    const t0 = Date.now();
    const refused = await c.dial(addrA).catch((e: Error & { code?: string }) => e);
    console.log(
      `[live] key not in --allow: ${(refused as { code?: string }).code} after ${Date.now() - t0} ms`,
    );
    expect(refused).toMatchObject({ code: 'unreachable' });
    expect(inbound.filter((x) => x.at === 'a')).toEqual([]);

    // unlink: dropping b's key refuses b from then on
    await a.setAllowed!([]);
    await expect(b.dial(addrA)).rejects.toMatchObject({ code: 'unreachable' });
    await la.close();
    await lb.close();
  });
});
