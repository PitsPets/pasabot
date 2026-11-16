# Code signing (Windows)

Why: Windows 11 with **Smart App Control** turned on runs a program only when Microsoft already knows it or when it
is signed with a certificate from a trusted authority. An unsigned PasaBot preview is blocked there outright ("An
Application Control policy has blocked this file"). There is no safe way around that for an unsigned file, and
PasaBot never asks anyone to turn a security feature off (Smart App Control, once off, cannot be turned back on
without reinstalling Windows). The fix is a signed release.

PasaBot is preparing an application for free open-source code signing from the
[SignPath Foundation](https://signpath.org/) (draft answers: docs/SIGNPATH-APPLICATION.md). Until it is sent,
approved and set up, Windows builds are unsigned previews.

## How a release is built and signed

Everything runs on GitHub's own hosted runners (`.github/workflows/release-windows.yml`), from a tag `v*` (or by
hand on `main`, for a trial; any other branch is refused). Nobody's PC is involved, and the signing key never leaves
SignPath's hardware. Every action the workflow uses is pinned to a commit, and Node.js and Inno Setup to exact
versions, so what gets signed changes only with a change in this repository.

1. **Build** the portable folder from the tagged source (`build-windows.ps1 -SqliteFromSource -NoInstaller`): the
   built JavaScript, the production dependencies from `pnpm-lock.yaml`, the Node.js runtime, and the database engine
   (better-sqlite3) compiled on the runner from its own pinned source. Build and test tools, other systems' binaries
   and package-manager shims are removed, and `scripts/windows-binaries.mjs --strict` stops the build if any
   executable file is not in the signing policy ([WINDOWS-BINARIES.md](WINDOWS-BINARIES.md)).
2. **Sign the inner files** of ours through SignPath (artifact configuration `.signpath/artifact-configurations/inner.xml`):
   the tray and self-test PowerShell scripts, the database engine, and Inno Setup's uninstaller. The database engine
   is staged only when this run compiled it from source (a record `build-windows.ps1 -SqliteFromSource` writes, with
   the upstream prebuild's hash to prove it differs); an upstream prebuild is never signed. Each request waits for
   the maintainer to approve it in SignPath. The binaries list is then made again from the signed files, so its
   hashes are those of the files that ship.
3. **Package** them with Inno Setup into `PasaBot-Setup-<version>.exe`.
4. **Sign the installer** through SignPath (`.signpath/artifact-configurations/installer.xml`), approved the same way.
5. **Check**: the runner installs the signed installer, reads the signature of every program, library and script in
   the installed copy (`Get-AuthenticodeSignature`) and fails if any file of ours is not `Valid`, runs the
   self-test, uninstalls, and writes `SHA256SUMS`.
6. A tag run attaches the installer, `SHA256SUMS` and the binaries list to a **draft** GitHub Release. Publishing it
   is a human click. If a release for the tag already exists and is published, the run fails and changes nothing.

The workflow does nothing until the `SIGNPATH_*` repository variables are set (listed at the top of the workflow
file); without them it says so and stops.

### Who can start a signing run

- The signing job runs in the GitHub environment **`release-signing`**. The owner creates it with a **required
  reviewer** (the owner) and **deployment branches and tags** limited to the tag rule `v*` (plus `main`, only for
  trial runs). The `SIGNPATH_API_TOKEN` secret lives only in that environment, never as a repository secret, so a
  workflow pushed on any other branch can neither run the job nor read the token.
- The workflow's own gate also refuses any ref other than a `v*` tag or `main`.
- In SignPath, the signing policy limits the allowed source to the same refs, and every request waits for the
  approver. Approve only a request whose run (linked in SignPath) is from a `v*` tag of this repository.

Step by step for the owner: docs/SIGNPATH-APPLICATION.md, "Owner's checklist".

## What is not signed, and why

- `node.exe` is the official Node.js runtime (an exact 22.x version, pinned in the workflows), already signed by its
  publisher (OpenJS Foundation). It is checked, never re-signed.
- The optional voice engine's libraries (`sherpa-onnx`, prebuilt by that project) are third-party binaries; they
  are never signed with PasaBot's certificate. On a PC with Smart App Control they may be blocked; voice then does
  not start, and the rest of PasaBot works.
- `PasaBot.cmd` (open at sign-in) is a batch file; batch files cannot carry a signature. It only starts `node.exe`.
- AI brains (Claude Code, Codex, Gemini and others), the Chromium a browsing helper uses, and anything else you
  install yourself are separate programs with their own publishers.

## Works without PowerShell

Under an application control policy, PowerShell runs scripts it does not trust in Constrained Language Mode. So
nothing PasaBot needs depends on PowerShell: the Start-menu shortcuts, the installer's setup step and the
uninstaller run the signed `node.exe` with PasaBot's own JavaScript (`windows-shell.js`). The tray icon is the only
part that needs PowerShell (Windows Forms): where PowerShell may run it in Full Language mode, it appears; where it
may not, PasaBot runs from its window without the icon, and **Settings › Quit PasaBot** in the window (or **Start menu › PasaBot › Stop PasaBot**) quits it. When Windows will
not say which program a running PasaBot process is (PowerShell blocked), Stop PasaBot asks it to quit but never
forces it: a reused process number could belong to another program.
**Check this computer** says which of the two this PC does.

Known gaps (not fixed by signing; tracked): the server itself still asks Windows PowerShell for two things, the data
folder's access list and the Windows protection (DPAPI) of the vault key. If PowerShell refuses those on a PC, the
server shows a card and the vault stays closed for that run. Whether Smart App Control makes PowerShell refuse them
has not been tested on a real PC yet.

## Check a download yourself

1. **The checksum.** In PowerShell, in the folder you downloaded to:
   `Get-FileHash .\PasaBot-Setup-<version>.exe -Algorithm SHA256`
   The hash must equal the line for that file in `SHA256SUMS` on the same GitHub Release.
2. **The signature.** Right-click the installer › **Properties** › **Digital Signatures**: the signer is the SignPath
   Foundation certificate named on the release page, and **Details** says "This digital signature is OK". Or in
   PowerShell: `Get-AuthenticodeSignature .\PasaBot-Setup-<version>.exe` must show `Valid`.
3. After installing, every signed file listed in `windows-binaries.md` (attached to the release) can be checked the
   same way in `%LOCALAPPDATA%\Programs\PasaBot`.

Only download PasaBot from its GitHub Releases page: <https://github.com/PitsPets/pasabot/releases>.

## Privacy: every outbound connection

PasaBot sends nothing to other networked systems unless the person using or running it asks for it. This is every
place the shipped code can open a connection to another machine, when, and who starts it (audited for the code
signing policy; `apps/server/src/host/outbound-hosts.test.ts` fails when a new web address appears in shipped code
until it is added here and to its allow-list).

| What                                                                                                                        | Where in the code                                                                     | When                                                            | Who starts it                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| Update check (reads one JSON file, downloads nothing)                                                                       | `apps/desktop/src/update.ts`, `launcher.ts`                                           | at start and once a day, only while on                          | off by default; the person turns it on              |
| Brain detection: runs each installed brain's own `--version` and sign-in check (`claude auth status`, `codex login status`) | `apps/server/src/chat/index.ts` (`GET /api/v1/providers`), `providers/*/src/index.ts` | when the app opens (cached)                                     | automatic, local programs; what they send is theirs |
| Local model servers (Ollama, LM Studio)                                                                                     | `providers/local/src/server.ts`                                                       | same                                                            | automatic, this machine only (127.0.0.1)            |
| A brain's own work (each vendor's service)                                                                                  | `providers/*`                                                                         | a message, routine or workflow                                  | the person (or a schedule they made)                |
| Chat channels (Telegram, Discord, Slack, WhatsApp)                                                                          | `channels/*`, `apps/server/src/channels/runtime.ts`                                   | reconnected at every start while enabled                        | set up by the person                                |
| Mail (IMAP and SMTP hosts the person entered)                                                                               | `modules/inbox/src/server.ts`                                                         | every 5 minutes once a mailbox is added                         | set up by the person                                |
| Connectors: remote MCP servers, sign-in discovery (`/.well-known/...`)                                                      | `modules/connectors`, `modules/mcp`                                                   | on install, on Test, on first use                               | the person                                          |
| Connectors: sign-in renewal for a connected account                                                                         | `modules/connectors/src/server.ts`                                                    | every 5 minutes, only for sign-ins about to expire              | set up by the person                                |
| Connectors run as local programs: their pinned package (npm, PyPI, GitHub's container registry)                             | `modules/mcp/src/client.ts`, `catalog/connectors`                                     | first start after install, if not cached                        | the person (installing the connector)               |
| Browser notifications (the browser's push service)                                                                          | `modules/push/src/server.ts`                                                          | when a notification is sent                                     | the person turns them on                            |
| Memory or message boards (Hindsight, agent board)                                                                           | `plugins/hindsight`, `plugins/agentchat-bridge`                                       | while configured                                                | set up by the person                                |
| Linked machines (the `tailcat` tool and its relays)                                                                         | `modules/link`, `packages/link-transport`                                             | at start, only when a machine is linked                         | set up by the person                                |
| Speech models (github.com, sha256-checked)                                                                                  | `modules/voice/src/models.ts`                                                         | on Install                                                      | the person                                          |
| Free starter brain (api.github.com, github.com)                                                                             | `modules/templates/src/install/installer.ts`                                          | on the person's go                                              | the person                                          |
| Templates, skills, ACP agents (catalogue address, git, npm)                                                                 | `modules/templates`, `modules/skills`, `modules/acp-registry`                         | on install; a catalogue address is read when its page is opened | the person                                          |
| Websites a helper opens, shop searches                                                                                      | `modules/browser`, `modules/shop`                                                     | when the person asks a helper                                   | the person                                          |
| Pages a helper makes (sandboxed)                                                                                            | `apps/server/src/host/module-host.ts`                                                 | when the person opens one; the page can load from the web       | the person                                          |
| The app window on Windows and Linux (Edge, Chrome, Brave or Chromium in app mode, own profile)                              | `apps/desktop/src/app-window.ts`                                                      | at every start                                                  | that browser's own traffic follows its settings     |

Not present anywhere: telemetry, analytics, crash reporting, link previews or unfurling, favicon or avatar fetches,
time or location lookups, web fonts or scripts from a CDN (the web app's content security policy allows its own
origin only), and a Playwright browser download (only the CI workflows install one).
