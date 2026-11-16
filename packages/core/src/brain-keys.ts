/**
 * A brain's API key kept in the vault (`ProviderAdapter.keyEnv`): which entry names exist (never values) and the
 * status that follows from them. The runner reads the values themselves into the turn's env (Orchestrator).
 *
 * A brain key lives in its own scope, `brain:<providerId>`, which only the owner fills (Settings → Vault, "Key for
 * <brain>") and only the runner reads. It is never taken from `global` or an agent's `agent:<id>` scope: those hold
 * `{{secret:NAME}}` references that tool handlers resolve server-side, and an agent never gets their raw value.
 * A brain key does reach the brain's process env, so agents running on that brain can see it (the UI says so).
 */
import type { SecretVault } from './ports.js';
import type { ProviderAdapter, ProviderStatus } from './provider.js';

/** The vault scope holding one brain's API keys. */
export const brainKeyScope = (providerId: string) => `brain:${providerId}`;
const entry = (providerId: string, name: string) => `${brainKeyScope(providerId)}\n${name}`;

/** The brain-key entries the vault holds, as opaque `scope + name` tokens (an unavailable vault = none). */
export async function vaultKeyNames(vault?: Pick<SecretVault, 'list'>): Promise<Set<string>> {
  if (!vault) return new Set();
  try {
    return new Set(
      (await vault.list()).filter((s) => s.scope.startsWith('brain:')).map((s) => `${s.scope}\n${s.name}`),
    );
  } catch {
    return new Set();
  }
}

/**
 * A status with the vault taken into account: an installed brain whose `keyEnv` names an entry in its own
 * `brain:<id>` scope (`names` from `vaultKeyNames`, never values) is signed in, because the runner hands that key
 * to the CLI.
 */
export function withVaultKeys(
  st: ProviderStatus,
  p: Pick<ProviderAdapter, 'id' | 'keyEnv'>,
  names: ReadonlySet<string>,
): ProviderStatus {
  if (!st.installed || st.signedIn === true || !p.keyEnv?.some((n) => names.has(entry(p.id, n)))) return st;
  const { hint: _h, hintKey: _k, ...rest } = st;
  return { ...rest, signedIn: true };
}

/**
 * A fingerprint of one brain's own vault keys (entry ids and save times, never values). A remembered sign-in failure
 * (`ProviderRegistry.signInLost`) only counts while the keys are the ones it failed with: saving a new key ends it.
 */
export async function brainKeyStamp(vault: Pick<SecretVault, 'list'> | undefined, providerId: string) {
  if (!vault) return '';
  try {
    return (await vault.list(brainKeyScope(providerId)))
      .filter((s) => s.scope === brainKeyScope(providerId))
      .map((s) => `${s.id}:${s.rotatedAt ?? s.createdAt}`)
      .sort()
      .join(',');
  } catch {
    return '';
  }
}

/**
 * A status made honest about how a turn really runs (Brains page, agent header): `turn` is the turn-time check
 * (`ProviderRegistry.turnSignIn`) and `lost` the sign-in memory (`signInLost`: the last test or turn failed on
 * sign-in). Either one saying signed out turns an installed brain into "needs sign-in"; nothing else changes.
 */
export function withTurnSignIn(st: ProviderStatus, turn: boolean | 'unknown', lost: boolean): ProviderStatus {
  if (!st.installed || st.reachable === false || (!lost && turn !== false)) return st;
  const { hint: _h, hintKey: _k, ...rest } = st;
  return {
    ...rest,
    signedIn: false,
    hint: 'sign-in did not work the way a turn runs',
    hintKey: { key: 'core:provider.hint.turnSignIn' },
  };
}
