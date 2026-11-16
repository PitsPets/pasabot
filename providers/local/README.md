# @pasabot/provider-local (W34)

Local models and the offline fallback. One package covers both **Ollama** (its own API) and **OpenAI-compatible**
local servers (LM Studio, llama.cpp, vLLM). It is a provider package that is also a module: the endpoints are owner
data, so each one the owner adds becomes a runtime provider `local:<id>` (ARCHITECTURE 5.1, 12).

- **Owner-configured only.** Settings → Local models: the page shows Ollama / LM Studio found on their usual loopback
  ports (11434, 1234; never a network scan), checks an address before saving and stores it. Only an owner session
  reaches `/api/m/local/*`; run bearers, automation tokens and members are refused, and no tool exposes the list.
  An address must be a literal IP or `localhost` (no DNS names, so nothing rebinds later) on loopback or the local
  network (private ranges, CGNAT/Tailscale, ULA); a local-network address is stored with a warning.
- **Found by itself.** Without any endpoint added, PasaBot registers Ollama (`local:ollama`, 127.0.0.1:11434) and
  LM Studio (`local:lmstudio`, 127.0.0.1:1234/v1) as brains. The Brains tile says **Ready** when the app's loopback API
  answers with at least one model (the model picker lists them), **Needs a model** when it answers with none, **Not
  running** when the app or its command is installed (`ollama` / `lms` on PATH, or `Ollama.app` / `LM Studio.app`;
  file names only, nothing is read or run) but the API does not answer, and "Not on this computer" otherwise. PasaBot
  never downloads a model. An endpoint the owner adds on the same address replaces the found one.
  `PASABOT_LOCAL_FIND=0` turns this off (the hermetic e2e servers).
- **safe-net exception.** Every request goes through `fetchLocalModel` (`@pasabot/safe-net`), which reaches only the
  exact origins passed to it (this endpoint's own, or the run's PasaBot MCP gateway), follows no redirect and streams
  the body. The ordinary `safeFetch` path that agent tools use still refuses loopback and private addresses.
- **Turns.** Streamed (`text.delta`), with usage. A native session's history is kept in the module's `local_session` table
  (capped, dropped with its endpoint or after 180 idle days), so a restart or a failed turn never forgets the chat;
  the session ref is handed out only once a turn finished and its history is saved. Tools: the run's gateway tools are offered as functions; each call runs
  through the gateway (approval tiers apply) and its result goes back to the model (up to 8 rounds). **Degraded
  mode**: a model that cannot call tools (Ollama `/api/show` says so, the server answers 400 about tools, or the owner
  set the endpoint to chat only) runs chat only, says "Tools are off for this model: chat only." in the run, and the
  endpoint card shows it as "Chat only: tools off".
- **Offline fallback.** An unreachable endpoint (connection refused, no route, or no connection within 5 s) ends the
  turn with error kind `offline`, but only when it fails before the endpoint answered this turn: a stream dropped
  later, or a failure after a tool round, is a `crash` (never rerun over tool side effects); a connected socket that
  goes quiet for the idle timeout (120 s) is a `timeout`. A cloud primary (Claude, Codex, OpenCode, ACP) that lost the
  network counts as `offline` too (the orchestrator reads its network error text). Settings probes answer within 5 s. Put a local model in an agent's W3 fallback chain and mark a routine **Run even offline**: the
  orchestrator retries that item once on the next reachable brain and the routine's activity says
  "Main brain offline: ran on …". An item not marked is held (per W3) and runs again later.

Proofs: `pnpm vitest run providers/local` (stub Ollama and OpenAI-compatible servers on 127.0.0.1 port 0: detect,
models, a streamed turn, a tool call round-trip through the gateway, degraded mode, the safe-net allowlist, owner-only
configuration, offline fallback vs held). `pnpm --filter @pasabot/provider-local test:e2e` (Playwright at 1440 and
390 px; needs `apps/web` built). Live (manual): `PASABOT_LIVE=ollama pnpm vitest run providers/local` against a
running Ollama on 127.0.0.1:11434.
