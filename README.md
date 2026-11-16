<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/ui/assets/logo/lockup-dark.svg">
    <img src="packages/ui/assets/logo/lockup.svg" alt="PasaBot" height="64">
  </picture>
</p>

# PasaBot

**Sabihin mo lang. Ako na bahala.**<br>
_Just say it. I'll take care of it._

A self-hosted, local-first workspace for a team of AI agents. Each agent has a name, its own instructions and workspace, and an AI "brain" supplied by an agent CLI you already use (Claude Code, Codex, Gemini, Grok, OpenCode or any ACP agent). Agents chat with you and with each other, answer from Telegram, Discord, Slack and WhatsApp, run on schedules and webhooks, and use tools through MCP and skills. It runs on your own machine or server; there is no vendor account and no relay service. Your phone connects over your own network or Tailscale after pairing with a QR code.

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

## Licence

Copyright 2026 PitsPets. Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
