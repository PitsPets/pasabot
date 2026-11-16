/**
 * `ChannelStateStore` over the vault port (ARCHITECTURE 5.2): one sealed entry per binding in the `module:channels`
 * scope, shared by the binding runtime (connect) and the channels module, so both read the same state. A pairing
 * writes into its own staging entry, which is promoted to the live entry only when the pairing is done: an
 * aborted, expired or failed pairing never touches a working session.
 */
import type { ChannelStateStore, SecretVault } from './ports.js';

export const CHANNEL_VAULT_SCOPE = 'module:channels';
export const channelStateName = (bindingId: string) => `binding:${bindingId}:state`;
export const channelPairingStateName = (bindingId: string) => `binding:${bindingId}:pairing`;

function vaultEntry(vault: SecretVault, name: string, bindingId: string, actor: string): ChannelStateStore {
  return {
    async load() {
      const meta = (await vault.list(CHANNEL_VAULT_SCOPE)).find((m) => m.name === name);
      if (!meta) return null;
      const v = await vault.get(meta, { actor, purpose: `channel state ${bindingId}` });
      return v ? v : null;
    },
    async save(value: string) {
      await vault.put(CHANNEL_VAULT_SCOPE, name, value);
    },
  };
}

/** the live state the binding runtime connects with */
export function vaultChannelState(vault: SecretVault, bindingId: string, actor: string): ChannelStateStore {
  return vaultEntry(vault, channelStateName(bindingId), bindingId, actor);
}

/** the staging state a pairing writes into; see `promotePairingState` */
export function vaultPairingState(vault: SecretVault, bindingId: string, actor: string): ChannelStateStore {
  return vaultEntry(vault, channelPairingStateName(bindingId), bindingId, actor);
}

/**
 * A finished pairing: move the staged session into the live entry and clear the staging entry. Returns false (and
 * changes nothing) when nothing was staged.
 */
export async function promotePairingState(
  vault: SecretVault,
  bindingId: string,
  actor: string,
): Promise<boolean> {
  const staged = vaultPairingState(vault, bindingId, actor);
  const value = await staged.load();
  if (!value) return false;
  await vaultChannelState(vault, bindingId, actor).save(value);
  await staged.save('');
  return true;
}
