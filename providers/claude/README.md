# @pasabot/provider-claude

`ProviderAdapter` for the Claude Code CLI (`claude -p`, stream-json in and out).

- Maps the stream to ProviderEvents: session, text deltas, thinking, tool calls/results, sub-agent spans (`Task`), final text, usage, classified errors, exactly one `done`.
- Steering: stdin stays open during the turn; `steer(runId, text)` writes another user message.
- MCP: the run bearer goes into a 0600 temp `--mcp-config` file (never argv); the CLI's own tool permissions go to PasaBot through `--permission-prompt-tool mcp__pasabot__core_permission_prompt`.
- Every spawn goes through `TurnInput.sandbox` (runner mode) and runs in its own process group, killed on abort.

Tests replay a recorded-format stream (`src/__fixtures__/stream.jsonl`) through a stand-in CLI, so they need no network or account. Live run on a developer machine: `PASABOT_LIVE=claude pnpm test:live`.
