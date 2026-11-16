import { describe, expect, it } from 'vitest';
import {
  CHANNEL_VAULT_SCOPE,
  channelPairingStateName,
  channelStateName,
  promotePairingState,
  vaultChannelState,
  vaultPairingState,
} from './channel-state.js';
import type { SecretMeta, SecretVault } from './ports.js';

/** in-memory SecretVault, written for this test */
function memoryVault(): SecretVault & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const meta = (key: string): SecretMeta => {
    const [scope, name] = key.split('\0') as [string, string];
    return { id: key, scope, name, backend: 'local', createdAt: 0, rotatedAt: null };
  };
  return {
    rows,
    async put(scope, name, value) {
      rows.set(`${scope}\0${name}`, value);
      return { id: `${scope}\0${name}`, scope, name };
    },
    async get(ref) {
      return rows.get(ref.id) ?? '';
    },
    async list(scope) {
      return [...rows.keys()].map(meta).filter((m) => !scope || m.scope === scope);
    },
    async putRef(scope, name) {
      return { id: `${scope}\0${name}`, scope, name };
    },
    async remove(id) {
      return rows.delete(id);
    },
    async rotateKey() {},
    knownValues: () => rows.values(),
    addBackend() {},
  };
}

describe('channel state: a pairing stages its session and promotes it only when done', () => {
  it('a pairing never writes the live entry; promotion moves the staged session and clears the staging', async () => {
    const vault = memoryVault();
    const live = vaultChannelState(vault, 'b1', 't');
    const staging = vaultPairingState(vault, 'b1', 't');
    await live.save('{"session":"working"}');

    // an unfinished pairing (aborted, expired) writes only the staging entry
    await staging.save('{"session":"half-made"}');
    expect(await live.load()).toBe('{"session":"working"}');
    await staging.save('');
    expect(await promotePairingState(vault, 'b1', 't')).toBe(false);
    expect(await live.load()).toBe('{"session":"working"}');

    // a finished pairing replaces the live session
    await staging.save('{"session":"new-scan"}');
    expect(await promotePairingState(vault, 'b1', 't')).toBe(true);
    expect(await live.load()).toBe('{"session":"new-scan"}');
    expect(await staging.load()).toBeNull();
    expect(vault.rows.get(`${CHANNEL_VAULT_SCOPE}\0${channelStateName('b1')}`)).toBe(
      '{"session":"new-scan"}',
    );
    expect(vault.rows.get(`${CHANNEL_VAULT_SCOPE}\0${channelPairingStateName('b1')}`)).toBe('');
  });
});
