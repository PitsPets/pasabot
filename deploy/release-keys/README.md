# Pinned release keys

`pasabot update` trusts only the Ed25519 public keys (`*.pub`, PEM/SPKI) in this folder **of the installed copy**.
A tarball's own keys are never used to check that tarball.

This folder is empty until the first signed release: no update can be installed before a maintainer adds the
project's release key here (`node deploy/release/sign.mjs keygen <dir>`, commit only `release.pub`). The private
key never enters the repo. Rotating a key = a release signed by the old key that ships the new `.pub`.
