/** @pasabot/core — domain types, ports and the Module SDK. Ports only: no implementations of server services. */
import { randomBytes } from 'node:crypto';

export * from './action-class.js';
export * from './brain-keys.js';
export * from './channel-policy.js';
export * from './channel-state.js';
export * from './clean-home.js';
export * from './cli-path.js';
export * from './module.js';
export * from './ports.js';
export * from './private-fs.js';
export * from './provider.js';
export * from './untrusted.js';
export * from './win.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom: number[] = [];

/** ULID (time-sortable, 26 chars, Crockford base32); monotonic within one millisecond. */
export function ulid(now = Date.now()): string {
  let t = now;
  const time: string[] = [];
  for (let i = 0; i < 10; i++) {
    time.unshift(CROCKFORD[t % 32]!);
    t = Math.floor(t / 32);
  }
  if (now === lastTime) {
    // increment the random part so ids made in the same ms still sort in creation order
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    lastRandom = Array.from(bytes, (b) => b % 32);
    lastTime = now;
  }
  return time.join('') + lastRandom.map((n) => CROCKFORD[n]).join('');
}

/** Thrown when a module touches a port whose implementation has not landed yet (e.g. vault before W0b). */
export class PortUnavailableError extends Error {
  constructor(readonly port: string) {
    super(`port "${port}" is not available in this server build`);
  }
}
