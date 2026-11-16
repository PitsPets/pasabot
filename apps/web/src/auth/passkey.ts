/** WebAuthn helpers: the server picks the RP ID from this page's origin (passkeys work on `localhost` or a host name). */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { post } from '../app/api.js';

export const passkeysSupported = () => browserSupportsWebAuthn();

/**
 * A signed assertion: `{ challengeId, response }`. `reauth` asks for user verification (PIN/biometric) and is bound
 * to the signed-in user; a sign-in assertion is not accepted as a re-auth.
 */
export async function passkeyAssertion(purpose: 'login' | 'reauth' = 'login') {
  const { challengeId, options } = await post<{ challengeId: string; options: any }>(
    `/api/v1/auth/passkey/${purpose}/options`,
  );
  const response = await startAuthentication({ optionsJSON: options });
  return { challengeId, response };
}

export async function signInWithPasskey() {
  return post('/api/v1/auth/passkey/login/verify', await passkeyAssertion());
}

export async function registerPasskey() {
  const { challengeId, options } = await post<{ challengeId: string; options: any }>(
    '/api/v1/auth/passkey/register/options',
  );
  const response = await startRegistration({ optionsJSON: options });
  return post('/api/v1/auth/passkey/register/verify', { challengeId, response });
}
