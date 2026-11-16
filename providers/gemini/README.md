# @pasabot/provider-gemini

`ProviderAdapter` for the Gemini CLI in its Agent Client Protocol mode: `gemini --acp`, driven by `@pasabot/provider-acp` (permission bridge, `session/load` resume, the PasaBot MCP gateway over HTTP with a header bearer). See that package's README for the mapping and the safety rules.

- Install hint: `npm install -g @google/gemini-cli`; sign in by running `gemini` once (or give the agent a `GEMINI_API_KEY` vault grant).
- Runner sandbox: `~/.gemini` stays writable (login, sessions). `skillsDir` = `<workspace>/.gemini/skills`.
- Older Gemini CLI releases spell the flag `--experimental-acp`: `createGeminiProvider({ command: ['gemini', '--experimental-acp'] })`.

Tests replay a recorded-format ACP session (`src/__fixtures__/session.jsonl`) through the test echo agent, so they need no network or account. Live run on a developer machine: `PASABOT_LIVE=gemini pnpm test:live`.
