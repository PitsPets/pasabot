// A stand-in for the server's one-shot setup-link minter (apps/server/src/host/mint-setup-link.ts). Knobs (env):
//   FAKE_MINT=1   no owner: print a fresh link on argv[2] (else nothing, as with an owner)
//   FAKE_MINT_LOG write PASABOT_HOME and the base here, so a test sees which data dir was asked
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_MINT_LOG)
  appendFileSync(process.env.FAKE_MINT_LOG, `${process.env.PASABOT_HOME} ${process.argv[2]}\n`);
if (process.env.FAKE_MINT === '1') process.stdout.write(`${process.argv[2]}/#/setup?token=minted\n`);
