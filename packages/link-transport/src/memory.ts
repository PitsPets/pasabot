/** In-process transport for tests: several servers in one process share one `MemoryNetwork`. */
import { randomBytes } from 'node:crypto';
import { type Duplex, duplexPair } from 'node:stream';
import type { LinkKeys } from './keys.js';
import { type LinkPeer, type LinkTransport, LinkTransportError } from './types.js';

export interface MemoryNetwork {
  transport(keys: LinkKeys): LinkTransport;
}

export function createMemoryNetwork(): MemoryNetwork {
  const listeners = new Map<string, { publicKey: string; onPeer: (s: Duplex, p: LinkPeer) => void }>();
  return {
    transport(keys) {
      const address = `memory:${randomBytes(12).toString('base64url')}`;
      const open = new Set<Duplex>();
      return {
        id: 'memory',
        async identity() {
          return { publicKey: keys.publicKey, address };
        },
        async available() {
          return { ok: true };
        },
        async listen(onPeer) {
          listeners.set(address, {
            publicKey: keys.publicKey,
            onPeer: (s, p) => {
              open.add(s);
              s.once('close', () => open.delete(s));
              onPeer(s, p);
            },
          });
          return {
            async close() {
              listeners.delete(address);
              for (const s of open) s.destroy();
            },
          };
        },
        async dial(to) {
          const l = listeners.get(to);
          if (!l) throw new LinkTransportError('unreachable', 'link peer unreachable');
          const [mine, theirs] = duplexPair();
          setImmediate(() => l.onPeer(theirs, { publicKey: keys.publicKey }));
          return { stream: mine, peer: { publicKey: l.publicKey } };
        },
      };
    },
  };
}
