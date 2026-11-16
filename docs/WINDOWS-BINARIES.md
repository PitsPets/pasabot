# Windows package: every file Windows may run or load

The list a code-signing review needs (docs/SIGNING.md): every file in the Windows package that Windows itself may
start or load, where it comes from, and what a signed release does with it. JavaScript is not listed: only the
bundled `node.exe` runs it, and Windows' application control (Smart App Control) checks programs, libraries and
scripts it starts itself, not the JavaScript a signed program reads.

Made by `scripts/windows-binaries.mjs`, which `build-windows.ps1` runs on every Windows build
(`apps\desktop\out\windows-binaries.md` and `.json` in the CI artifact; `--strict` fails the build when an
executable file is not in the policy, so a new binary can never slip into a release unseen). The tables below come
from a payload assembled on a Mac on 2026-11-16 the way `build-windows.ps1` assembles it: the production
dependencies for `win32`/`x64` from `pnpm-lock.yaml` (pnpm 12.18.0, `--os win32 --cpu x64 --ignore-scripts`,
hoisted; nothing was run). The real list of each release is the one its CI run writes; sizes and hashes of the
better-sqlite3 engine change there, because CI compiles it from source. The list attached to a signed release is
made again after signing, so its hashes are those of the signed files that ship. The engine is marked "sign" only when
that build compiled it from source (the record `build-windows.ps1 -SqliteFromSource` writes); without that record it
is the upstream prebuild and is listed as "upstream, shipped unsigned".

Added at build or install time, so not in the tables:

| File                          | From                                                                                                    | Release                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `node.exe`                    | the Node.js 22.23.5 runtime `actions/setup-node` installs on the build runner (pinned in the workflows) | already signed by its publisher (OpenJS Foundation); verified, never re-signed |
| `unins000.exe`                | written by the installer (Inno Setup)                                                                   | signed in the release flow (Inno Setup's signed-uninstaller step)              |
| `PasaBot-Setup-<version>.exe` | the installer itself                                                                                    | signed in the release flow, after the inner files                              |

## The set to sign (ours)

- `PasaBotTray.ps1`, `PasaBotIcon.ps1` (the optional tray), `selftest.ps1` (a thin wrapper of the self-test).
- `pasabot/node_modules/better-sqlite3/prebuilds/win32-x64.node`: the database engine, compiled in the Windows CI job
  from better-sqlite3's own pinned source (SQLite included) with node-gyp and MSVC (`build-windows.ps1
  -SqliteFromSource`), so it is a binary of our build, not the upstream prebuild. Whether SignPath accepts a binary
  we compile from a dependency's source as ours is one of the open questions in docs/SIGNPATH-APPLICATION.md.
- The uninstaller and the installer (above).

## Shipped unsigned, on purpose

- The optional voice engine (`sherpa-onnx-win-x64`: `sherpa-onnx.node` and four DLLs): prebuilt by its upstream
  project, only loaded when someone turns voice on. Third-party binaries are never signed with PasaBot's certificate.
  On a PC with Smart App Control they may be blocked; then voice does not start and everything else works.
- `PasaBot.cmd`: open-at-login's starter. Batch files cannot carry a signature; it only runs `node.exe`.

## What ships (besides node.exe and the uninstaller)

| File                                                                        | Kind   | CPU |     Size | SHA-256             | From                      | Release                     | Why                                                                                                                         |
| --------------------------------------------------------------------------- | ------ | --- | -------: | ------------------- | ------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PasaBot.cmd`                                                               | script |     |      104 | `518a11d5e5cec538…` | ours                      | ours, no signature possible | ours: open-at-login starter; batch files carry no signature                                                                 |
| `PasaBotIcon.ps1`                                                           | script |     |     4726 | `e945095a247a81d1…` | ours                      | sign (ours)                 | ours: optional tray (Full Language only) and the self-test wrapper                                                          |
| `PasaBotTray.ps1`                                                           | script |     |    10603 | `866264458481a328…` | ours                      | sign (ours)                 | ours: optional tray (Full Language only) and the self-test wrapper                                                          |
| `pasabot/node_modules/better-sqlite3/prebuilds/win32-x64.node`              | pe     | x64 |  2021888 | `d527af8fe1706a91…` | better-sqlite3@13.1.1     | sign (ours)                 | database engine, compiled from the pinned better-sqlite3 source in our Windows CI job (build-windows.ps1 -SqliteFromSource) |
| `pasabot/node_modules/sherpa-onnx-win-x64/onnxruntime.dll`                  | pe     | x64 | 17799168 | `7f66f939a881baf4…` | sherpa-onnx-win-x64@2.0.1 | upstream, shipped unsigned  | optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used                     |
| `pasabot/node_modules/sherpa-onnx-win-x64/onnxruntime_providers_shared.dll` | pe     | x64 |   104960 | `551d0e1fe4c227d8…` | sherpa-onnx-win-x64@2.0.1 | upstream, shipped unsigned  | optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used                     |
| `pasabot/node_modules/sherpa-onnx-win-x64/sherpa-onnx-c-api.dll`            | pe     | x64 |  4294656 | `97dab91a51a9ae27…` | sherpa-onnx-win-x64@2.0.1 | upstream, shipped unsigned  | optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used                     |
| `pasabot/node_modules/sherpa-onnx-win-x64/sherpa-onnx-cxx-api.dll`          | pe     | x64 |   264192 | `869d7c22ddc788f1…` | sherpa-onnx-win-x64@2.0.1 | upstream, shipped unsigned  | optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used                     |
| `pasabot/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node`                 | pe     | x64 |   697344 | `62fdf07d99ecb560…` | sherpa-onnx-win-x64@2.0.1 | upstream, shipped unsigned  | optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used                     |
| `selftest.ps1`                                                              | script |     |      899 | `dcc69fdeccf57e2b…` | ours                      | sign (ours)                 | ours: optional tray (Full Language only) and the self-test wrapper                                                          |

## What the build removes

Also every package manager command shim (`node_modules\.bin\*.cmd` and `.ps1`), in any `node_modules`: the top one
and a workspace package's own, such as `packages\testkit\node_modules\.bin`. pnpm writes them on Windows only, so
they are not in the table below, which was assembled on a Mac.

| File                                                                                         | Kind   | CPU            |     Size | SHA-256             | From                                    | Release       | Why                                                                        |
| -------------------------------------------------------------------------------------------- | ------ | -------------- | -------: | ------------------- | --------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `pasabot/node_modules/@esbuild/win32-x64/esbuild.exe`                                        | pe     | x64            | 11694592 | `c7bee37877d0aa6a…` | @esbuild/win32-x64@0.28.2               | must not ship | build and test tools pulled in as optional peers; never loaded at run time |
| `pasabot/node_modules/@rolldown/binding-win32-x64-msvc/rolldown-binding.win32-x64-msvc.node` | pe     | x64            | 23150080 | `e0a939498db49f58…` | @rolldown/binding-win32-x64-msvc@1.2.19 | must not ship | build and test tools pulled in as optional peers; never loaded at run time |
| `pasabot/node_modules/better-sqlite3/prebuilds/darwin-arm64.node`                            | pe     | not a PE image |  1981744 | `353ce47176778273…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/darwin-x64.node`                              | pe     | not a PE image |  2000184 | `4bfa96b9c221b3ed…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/linux-arm64.node`                             | pe     | not a PE image |  2091576 | `63e96d09e2cc4e98…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/linux-x64.node`                               | pe     | not a PE image |  2251416 | `27dedc301602dc32…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node`                         | pe     | not a PE image |  2312976 | `1dc13362d98e59c4…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node`                           | pe     | not a PE image |  2457368 | `2c4f7fc706e8edf2…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/better-sqlite3/prebuilds/win32-arm64.node`                             | pe     | arm64          |  1966592 | `2a5954c4ca385f87…` | better-sqlite3@13.1.1                   | must not ship | prebuilds for other systems, or build leftovers                            |
| `pasabot/node_modules/lightningcss-win32-x64-msvc/lightningcss.win32-x64-msvc.node`          | pe     | x64            |  9484800 | `d043df0f0675e7ff…` | lightningcss-win32-x64-msvc@1.33.0      | must not ship | build and test tools pulled in as optional peers; never loaded at run time |
| `pasabot/node_modules/playwright-core/bin/install_media_pack.ps1`                            | script |                |      174 | `bc20f049badf021e…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/install_webkit_wsl.ps1`                            | script |                |     1464 | `bc61beda37a808ee…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/reinstall_chrome_beta_win.ps1`                     | script |                |      957 | `b6d9e44742feafb9…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/reinstall_chrome_stable_win.ps1`                   | script |                |      923 | `3d96c4e2f4ebbb3f…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/reinstall_msedge_beta_win.ps1`                     | script |                |      874 | `b173c378a59f0cc3…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/reinstall_msedge_dev_win.ps1`                      | script |                |      869 | `46f7f98c81cb0abe…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
| `pasabot/node_modules/playwright-core/bin/reinstall_msedge_stable_win.ps1`                   | script |                |      856 | `40bb5fcbfcebbbe2…` | playwright-core@1.63.0                  | must not ship | Playwright browser installer scripts, never run by PasaBot                 |
