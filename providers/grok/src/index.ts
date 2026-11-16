/**
 * Grok adapter: the Grok CLI run as an Agent Client Protocol agent over stdio (`grok agent stdio`), driven by the
 * generic ACP adapter (permission bridge, `session/load` resume, the MCP gateway over HTTP with a header bearer).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AcpOptions, type AcpProvider, createAcpProvider } from '@pasabot/provider-acp';

export const GROK_DEFAULTS: AcpOptions = {
  id: 'grok',
  displayName: 'Grok',
  command: ['grok', 'agent', 'stdio'],
  signInHint: 'run `grok` once to sign in',
  signInHintKey: { key: 'core:provider.hint.runToSignIn', params: { cmd: 'grok' } },
  statePaths: (env) => [join(env.HOME || homedir(), '.grok')],
  signedIn: grokSignedIn,
  // the Brains page's route for Grok: the owner saves the xAI key in the vault; the runner passes it to the CLI
  keyEnv: ['XAI_API_KEY'],
};

/**
 * Signed in? Without reading a credential: an xAI key variable in the env the CLI gets (the adapter's own env; a vault
 * entry is counted by withVaultKeys) = yes; the CLI's own settings file may or may not
 * hold a key (not read) = cannot tell; neither = not signed in.
 */
export function grokSignedIn(env: Record<string, string | undefined>): boolean | 'unknown' {
  if (env.XAI_API_KEY || env.GROK_API_KEY) return true;
  return existsSync(join(env.HOME || homedir(), '.grok', 'user-settings.json')) ? 'unknown' : false;
}

/** `command` overrides the CLI (tests point it at a stand-in agent). */
export function createGrokProvider(o: Partial<AcpOptions> = {}): AcpProvider {
  return createAcpProvider({ ...GROK_DEFAULTS, ...o, id: 'grok' });
}

export default createGrokProvider();
