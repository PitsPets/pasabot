## PasaBot for Windows 10 and 11

Download `PasaBot-Setup-<version>.exe` below and double-click it. It installs for you only (no admin password).

**Is it signed?** Check before you install (docs/SIGNING.md, "Check a download yourself"):

- `Get-FileHash .\PasaBot-Setup-<version>.exe -Algorithm SHA256` must match the line in `SHA256SUMS`.
- Right-click › Properties › Digital Signatures must show a valid signature. A release without one is an unsigned
  preview: on a PC with Smart App Control turned on, Windows blocks it ("An Application Control policy has blocked
  this file"). Do not turn Smart App Control off for it; wait for a signed release instead.

`windows-binaries.md` lists every program, library and script in the package, where it comes from and whether it
is signed.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/). (Keep this line only on releases that SignPath actually signed.)

## What changed

<!-- the maintainer writes this part -->
