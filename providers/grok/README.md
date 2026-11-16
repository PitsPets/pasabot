# @pasabot/provider-grok

`ProviderAdapter` for the Grok CLI run as an Agent Client Protocol agent over stdio: `grok agent stdio`, driven by `@pasabot/provider-acp` (permission bridge, `session/load` resume, the PasaBot MCP gateway over HTTP with a header bearer). See that package's README for the mapping and the safety rules.

- Sign in by running `grok` once. Runner sandbox: `~/.grok` stays writable.
- The CLI's docs recommend `--no-auto-update` for unattended use; it is not passed yet because its position on the command line is unverified. Override with `createGrokProvider({ command: [...] })` once confirmed.

Tests replay a recorded-format ACP session (`src/__fixtures__/session.jsonl`) through the test echo agent, so they need no network or account. Live run on a developer machine: `PASABOT_LIVE=grok pnpm test:live`.
