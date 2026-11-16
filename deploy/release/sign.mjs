#!/usr/bin/env node
/**
 * Release signing for maintainers (never run on a user's server).
 *   node deploy/release/sign.mjs keygen <out-dir>        -> <out-dir>/release.key (0600, keep OFF the repo)
 *                                                           <out-dir>/release.pub (commit into deploy/release-keys/)
 *   node deploy/release/sign.mjs sign <release.key> <pasabot-x.y.z.tar.gz>   -> <tarball>.sig (base64 Ed25519)
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'keygen' && a) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(a, { recursive: true, mode: 0o700 });
  writeFileSync(join(a, 'release.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(a, 'release.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  process.stdout.write(`wrote ${join(a, 'release.key')} (secret) and ${join(a, 'release.pub')}\n`);
} else if (cmd === 'sign' && a && b) {
  const key = createPrivateKey(readFileSync(a));
  const sig = sign(null, readFileSync(b), key).toString('base64');
  writeFileSync(`${b}.sig`, `${sig}\n`);
  process.stdout.write(`wrote ${b}.sig\n`);
} else {
  process.stderr.write('usage: sign.mjs keygen <out-dir> | sign <release.key> <tarball>\n');
  process.exit(2);
}
