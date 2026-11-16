<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/ui/assets/logo/lockup-dark.svg">
    <img src="packages/ui/assets/logo/lockup.svg" alt="PasaBot" height="64">
  </picture>
</p>

# PasaBot

**Sabihin mo lang. Ako na bahala.**<br>
_Just say it. I'll take care of it._

A self-hosted, local-first workspace for a team of AI agents. Each agent has a name, its own instructions and workspace, and an AI "brain" supplied by an agent CLI you already use (Claude Code, Codex, Gemini, Grok, OpenCode or any ACP agent). Agents chat with you and with each other, answer from Telegram, Discord, Slack and WhatsApp, run on schedules and webhooks, and use tools through MCP and skills. It runs on your own machine or server; there is no vendor account and no PasaBot relay service. Your phone connects over your own network or Tailscale after pairing with a QR code.

## Status

**Early. Expect rough edges.** Built and used on macOS. The checks below run clean on the maintainer's Mac; the rest has not been verified by hand yet.

Not yet verified:

- **Windows and Linux.** The installers, tray and starter scripts exist and have a CI workflow (`.github/workflows/desktop.yml`), but they have not been tried by hand on real machines. Linux has no tray icon.
- **Real accounts and services.** Connectors (GitHub, Bitwarden, 1Password, Gmail, Outlook, Yahoo, iCloud, Telegram, Discord, Slack, WhatsApp) are tested against fakes and stubs, not against the real services. WhatsApp is not an official API: the account can be limited or banned.
- **Computer use** is tested with a fake screen helper, not on a real Xvfb or macOS screen.
- **Unsigned apps.** The macOS and Windows packages are not signed or notarized, so the OS warns before the first open.
- **Agent CLIs** (Claude Code, Codex, Gemini, Grok, OpenCode) are driven through recorded fixtures in the tests; live runs are opt-in.

## Run it

You need Node.js 22 or newer.

```sh
corepack enable            # or run every command as: npx pnpm@12.18.0 <cmd>
pnpm install
pnpm check                 # typecheck, i18n, lint (biome + dependency-cruiser), tests, build
pnpm dev                   # web app + server for local work
```

To install it as a login service, use Docker, or build the desktop app, see [docs/INSTALL.md](docs/INSTALL.md), [deploy/README.md](deploy/README.md) and [apps/desktop/README.md](apps/desktop/README.md).

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Feature checklist](docs/FEATURES.md)
- [Roadmap and workstreams](docs/ROADMAP.md)

- [Install](docs/INSTALL.md)
- [Contributing](CONTRIBUTING.md) and [Security policy](SECURITY.md)

PasaBot is an independent project, written from scratch. It is not affiliated with or endorsed by any other product or company.

## Code signing policy

Windows releases are being set up for signing through the SignPath Foundation's free programme for open-source
projects ([docs/SIGNING.md](docs/SIGNING.md)); until that is in place, Windows builds are unsigned previews. Once it
is: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [PitsPets](https://github.com/PitsPets)
- Approvers: [PitsPets](https://github.com/PitsPets)

What is signed: PasaBot's own PowerShell scripts, the Inno Setup installer and uninstaller that package them, and
the better-sqlite3 database engine compiled in our CI from its pinned source. Third-party prebuilt binaries are never
signed with the project certificate. [docs/WINDOWS-BINARIES.md](docs/WINDOWS-BINARIES.md) lists every program,
library and script in the Windows package and what is signed. Releases:
<https://github.com/PitsPets/pasabot/releases>.

**Privacy.** This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. Exactly what that means:

- PasaBot has no telemetry, no analytics and no crash reporting, and it downloads nothing on its own. The update
  check is off until you turn it on; when it is on, it reads one small file from the address set for it, at start
  and once a day, and never downloads anything.
- The web app loads nothing from other sites (no fonts, scripts or images from the internet). Pages a helper makes
  for you are shown in a sandbox and can load things from the web when you open them.
- It connects to what you set up, and keeps those connections going while it runs:
  - the AI brains you choose, each its own program with its own privacy terms. To show which ones are installed and
    signed in, PasaBot runs each brain's own version and sign-in check when you open the app; what those programs
    send is up to them;
  - the chat channels you connect (reconnected at every start), the mail accounts you add (checked every 5
    minutes), and memory or message boards you point it at;
  - the connectors you install: installing one can download its pinned package (from npm, PyPI or GitHub's
    container registry), and an account you signed in through one has its sign-in renewed in the background;
  - browser notifications you turn on (sent through your browser's push service), the machines you link, catalogue
    addresses you add, and the websites a helper opens for you.
- Downloads happen only when you start them: a speech model, the free starter brain, a template, a skill or an
  agent you pick.
- On Windows and Linux, PasaBot's window is a browser you already have (Microsoft Edge, Chrome, Brave or Chromium)
  in app mode with a profile of its own; that browser keeps its own settings for what it sends to its maker. On
  macOS the window is PasaBot's own.

The full list, with where each one is in the code: [docs/SIGNING.md](docs/SIGNING.md#privacy-every-outbound-connection).
A test (`apps/server/src/host/outbound-hosts.test.ts`) fails when a new web address appears in the shipped code
until it is added to that list with its reason.

## Licence

Copyright 2026 PitsPets. Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
