/**
 * `pasabot pair [--no-wait] [--url <address phones use>]`: pair a phone from the terminal. Prints a QR code of the
 * pairing link, then waits for the phone to claim THIS code and asks the owner before letting it in.
 *
 * - Only the claim made on the code printed here is ever shown or confirmed (`?codeId=`, ARCHITECTURE 8 "Pairing
 *   hijack"); a pending claim on an older code is never picked up. There is no auto-confirm.
 * - The device name and platform come from an unauthenticated phone: printed with control/format characters made
 *   visible, so they can never redraw the prompt line.
 * - The link uses `--url`, else the server's advertised address (`PASABOT_PUBLIC_URL`), else the CLI's server URL;
 *   a loopback link (unreachable from a phone) gets a warning saying how to fix it.
 */
import QRCode from 'qrcode';
import { api, defineCommand, prompt } from '../../command.js';

type ApiResult = Awaited<ReturnType<typeof api>>;
/**
 * Pairing makes a new long-lived sign-in, so the server asks for a fresh re-auth (ARCHITECTURE 2.4): on
 * `reauth_required` ask for the password (or PASABOT_PASSWORD), confirm it's you, and try the call once more.
 */
async function withReauth(call: () => Promise<ApiResult>): Promise<ApiResult> {
  const r = await call();
  if (r.status !== 401 || r.json?.error !== 'reauth_required') return r;
  const password = process.env.PASABOT_PASSWORD ?? (await prompt('Confirm it is you. Password: ', true));
  const a = await api('/api/v1/auth/reauth', { method: 'POST', body: { password } });
  if (a.status !== 200)
    throw new Error(a.status === 401 ? 'that password did not match' : `HTTP ${a.status}`);
  return call();
}

import { baseUrl, isLoopbackUrl, parseFlags, safeText } from './shared.js';

interface Claim {
  id: string;
  codeId?: string;
  deviceName: string;
  platform: string | null;
}

export default defineCommand({
  name: 'pair',
  summary: 'show a QR code in the terminal to pair a phone',
  async run(args) {
    const f = parseFlags(args, ['no-wait', 'yes']);
    if (f.yes) throw new Error('--yes is not supported: check the phone and confirm it yourself');
    let linkBase: string | null = null;
    if (typeof f.url === 'string') {
      const u = URL.canParse(f.url) ? new URL(f.url) : null;
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:'))
        throw new Error('--url needs an http(s) address, e.g. https://pasabot.example.ts.net');
      linkBase = u.origin;
    }
    const r = await withReauth(() => api('/api/v1/pairing', { method: 'POST', body: {} }));
    if (r.status === 401) throw new Error('not signed in; run `pasabot login` first');
    if (r.status !== 200) throw new Error(r.json?.error ?? `HTTP ${r.status}`);
    const { code, codeId, expiresAt, fingerprint, publicUrl } = r.json as {
      code: string;
      codeId?: string;
      expiresAt: number;
      fingerprint?: string;
      publicUrl?: string | null;
    };
    if (!codeId)
      throw new Error('this server is too old for `pasabot pair`; pair from the web Devices screen');
    if (!linkBase && publicUrl && URL.canParse(publicUrl)) linkBase = new URL(publicUrl).origin;
    linkBase ??= baseUrl().replace(/\/$/, '');
    const link = `${linkBase}/#/pair?code=${encodeURIComponent(code)}`;
    process.stdout.write(
      await QRCode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }),
    );
    process.stdout.write(`\nScan with the phone's camera, or open: ${link}\nCode: ${code}\n`);
    if (fingerprint) process.stdout.write(`Server fingerprint: ${fingerprint}\n`);
    if (isLoopbackUrl(link))
      process.stderr.write(
        `Warning: ${linkBase} is this computer's own address; a phone cannot open it. ` +
          'Run the server with PASABOT_PUBLIC_URL set to an address the phone can reach, or pass --url.\n',
      );
    if (f['no-wait']) return 0;
    process.stdout.write('Waiting for the phone… (Ctrl+C to stop)\n');
    while (Date.now() < expiresAt + 5 * 60_000) {
      const c = await api(`/api/v1/pairing/claims?codeId=${encodeURIComponent(codeId)}`);
      // only the claim made on this code, even if the server ignored the filter
      const mine = ((c.json?.claims ?? []) as Claim[]).filter((x) => x.codeId === codeId);
      const claim = mine[0];
      if (claim) {
        const name = safeText(claim.deviceName);
        const platform = claim.platform ? ` (${safeText(claim.platform)})` : '';
        const check = fingerprint ? ` The phone should show the fingerprint ${fingerprint}.` : '';
        const ok = /^y(es)?$/i.test(
          (
            await prompt(`A phone claimed this code: "${name}"${platform}.${check}\nLet it in as you? [y/N] `)
          ).trim(),
        );
        const d = await withReauth(() =>
          api(`/api/v1/pairing/claims/${encodeURIComponent(claim.id)}/${ok ? 'confirm' : 'reject'}`, {
            method: 'POST',
            body: {},
          }),
        );
        if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
        process.stdout.write(ok ? `Paired "${name}".\n` : 'Rejected.\n');
        return ok ? 0 : 1;
      }
      if (Date.now() > expiresAt) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    process.stderr.write('The code expired; run `pasabot pair` again.\n');
    return 1;
  },
});
