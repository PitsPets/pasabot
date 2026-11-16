/**
 * `runLinkTransportContract`: the suite every LinkTransport passes (ARCHITECTURE 11.5). A subject is two transports
 * of the same kind with their own keys; `a` listens, `b` dials. No network beyond loopback, no accounts.
 */
import { describe, expect, it } from 'vitest';
import { isLinkPublicKey } from './keys.js';
import type { LinkStream, LinkTransport } from './types.js';

export interface LinkTransportSubject {
  a: LinkTransport;
  b: LinkTransport;
  /** an address of this kind that nobody listens on */
  deadAddress: string;
  cleanup?(): Promise<void> | void;
}

/** resolves when the stream is done, however it ends (end, close or error) */
const finished = (s: LinkStream) =>
  new Promise<void>((res) => {
    if (s.readableEnded || s.destroyed) return res();
    s.once('end', () => res());
    s.once('close', () => res());
    s.once('error', () => res());
    s.resume();
  });
const readExactly = async (s: LinkStream, n: number): Promise<Buffer> => {
  const parts: Buffer[] = [];
  let got = 0;
  while (got < n) {
    const c = s.read() as Buffer | null;
    if (c) {
      parts.push(c);
      got += c.length;
      continue;
    }
    if (s.readableEnded || s.destroyed) break;
    await new Promise<void>((res) => {
      const done = () => {
        s.off('readable', done);
        s.off('end', done);
        s.off('close', done);
        s.off('error', done);
        res();
      };
      s.once('readable', done);
      s.once('end', done);
      s.once('close', done);
      s.once('error', done);
    });
  }
  return Buffer.concat(parts);
};

export function runLinkTransportContract(name: string, make: () => Promise<LinkTransportSubject>) {
  describe(`LinkTransport contract: ${name}`, () => {
    const withSubject = (fn: (s: LinkTransportSubject) => Promise<void>) => async () => {
      const s = await make();
      try {
        await fn(s);
      } finally {
        await s.cleanup?.();
      }
    };
    const accept = (t: LinkTransport) => {
      const peers: { stream: LinkStream; publicKey: string }[] = [];
      let wake: (() => void) | null = null;
      const next = () =>
        new Promise<{ stream: LinkStream; publicKey: string }>((res) => {
          const check = () => {
            const p = peers.shift();
            if (p) return res(p);
            wake = check;
          };
          check();
        });
      const listening = t.listen((stream, peer) => {
        peers.push({ stream, publicKey: peer.publicKey });
        wake?.();
      });
      return { listening, next };
    };

    it(
      'is available and names an Ed25519 key; the address is set once listening',
      withSubject(async ({ a }) => {
        expect(await a.available()).toEqual({ ok: true });
        const { listening } = accept(a);
        const l = await listening;
        const id = await a.identity();
        expect(isLinkPublicKey(id.publicKey)).toBe(true);
        expect(id.address.length).toBeGreaterThan(0);
        await l.close();
      }),
    );

    it(
      'dial reaches the listener; bytes flow both ways in order; each side sees the other key',
      withSubject(async ({ a, b }) => {
        const { listening, next } = accept(a);
        const l = await listening;
        const { address, publicKey: aKey } = await a.identity();
        const bKey = (await b.identity()).publicKey;
        const d = await b.dial(address);
        expect(d.peer.publicKey).toBe(aKey);
        d.stream.write('hello from b\n');
        const inbound = await next();
        expect(inbound.publicKey).toBe(bKey);
        expect((await readExactly(inbound.stream, 13)).toString()).toBe('hello from b\n');
        inbound.stream.write('hi b');
        expect((await readExactly(d.stream, 4)).toString()).toBe('hi b');
        d.stream.end();
        await finished(inbound.stream);
        inbound.stream.destroy();
        d.stream.destroy();
        await l.close();
      }),
    );

    it(
      'carries 1 MiB intact and keeps concurrent streams apart',
      withSubject(async ({ a, b }) => {
        const { listening, next } = accept(a);
        const l = await listening;
        const { address } = await a.identity();
        const big = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
        const [d1, d2] = await Promise.all([b.dial(address), b.dial(address)]);
        d1.stream.write('one:');
        d2.stream.write('two:');
        const got = [await next(), await next()];
        const tags = await Promise.all(got.map(async (g) => (await readExactly(g.stream, 4)).toString()));
        expect([...tags].sort()).toEqual(['one:', 'two:']);
        const one = got[tags.indexOf('one:')]!;
        d1.stream.write(big);
        const echoed = await readExactly(one.stream, big.length);
        expect(echoed.equals(big)).toBe(true);
        for (const s of [d1.stream, d2.stream, ...got.map((g) => g.stream)]) s.destroy();
        await l.close();
      }),
    );

    it(
      'dialing an address nobody listens on rejects, and the error does not echo the address',
      withSubject(async ({ b, deadAddress }) => {
        const err = await b.dial(deadAddress).then(
          () => null,
          (e: Error) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect(String(err?.message)).not.toContain(deadAddress);
      }),
    );

    it(
      'after the listener closes, dialing it rejects',
      withSubject(async ({ a, b }) => {
        const { listening } = accept(a);
        const l = await listening;
        const { address } = await a.identity();
        await l.close();
        await expect(b.dial(address)).rejects.toBeInstanceOf(Error);
      }),
    );
  });
}
