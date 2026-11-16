/**
 * Gemini adapter: the Gemini CLI in its Agent Client Protocol mode (`gemini --acp`), driven by the generic ACP
 * adapter. ACP gives PasaBot a real permission bridge (`session/request_permission`), resume (`session/load`) and the
 * MCP gateway as an HTTP server with the run bearer in a header (never argv or env).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AcpOptions, type AcpProvider, createAcpProvider } from '@pasabot/provider-acp';

export const GEMINI_DEFAULTS: AcpOptions = {
  id: 'gemini',
  displayName: 'Gemini',
  command: ['gemini', '--acp'],
  installCmd: ['npm', 'install', '-g', '@google/gemini-cli'],
  signInHint: 'run `gemini` once to sign in (or set GEMINI_API_KEY through the vault)',
  signInHintKey: {
    key: 'core:provider.hint.runToSignInOrKey',
    params: { cmd: 'gemini', env: 'GEMINI_API_KEY' },
  },
  skillsSubdir: join('.gemini', 'skills'),
  statePaths: (env) => [join(env.HOME || homedir(), '.gemini')],
  signedIn: geminiSignedIn,
  keyEnv: ['GEMINI_API_KEY'],
};

/**
 * Signed in? Without reading a credential: a Google sign-in leaves `~/.gemini/oauth_creds.json`; a key variable may
 * be set in the env the CLI gets (never the server's own env, which is scrubbed); a settings file alone (another auth type, e.g. Vertex) cannot be confirmed. Nothing at all = not signed in.
 */
export function geminiSignedIn(env: Record<string, string | undefined>): boolean | 'unknown' {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return true;
  const dir = join(env.HOME || homedir(), '.gemini');
  if (existsSync(join(dir, 'oauth_creds.json'))) return true;
  return existsSync(join(dir, 'settings.json')) ? 'unknown' : false;
}

/** `command` overrides the CLI (tests point it at a stand-in agent; older CLIs need `--experimental-acp`). */
export function createGeminiProvider(o: Partial<AcpOptions> = {}): AcpProvider {
  return createAcpProvider({ ...GEMINI_DEFAULTS, ...o, id: 'gemini' });
}

export default createGeminiProvider();
