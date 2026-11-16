# `hindsight` — Hindsight memory backend (W10 plugin)

Registers the `hindsight` `MemoryBackend` in `ModuleHost.memory`, so the owner can keep agent memory in a
Hindsight server instead of this server's SQLite (`local`).

- **Configure** (owner session): `PUT /api/m/hindsight/config` `{ url, bankPrefix = "pasabot", apiKeySecret = null }`;
  `apiKeySecret` names a vault secret in scope `module:hindsight`. Then pick "hindsight" with
  `PUT /api/m/memory/settings { "backend": "hindsight" }` (or Settings → Memory). Unconfigured, every call fails with
  "not configured" rather than writing anywhere else.
- **Mapping**: bank `<prefix>-shared` for shared items, `<prefix>-agent-<agent id>` per agent; one document per
  PasaBot item; PasaBot id = `<scope>.<document id>`; tags and source ride in document metadata.
- **Network**: every call goes through safe-net with only the configured host allowlisted (Hindsight usually sits on
  the LAN or tailnet), with a 15 s timeout.

Proof: `vitest run plugins/hindsight` — `runMemoryContract('hindsight (mock server)')` against
`src/__fixtures__/mock-hindsight.ts` (127.0.0.1, port 0, bearer check), plus the plugin wiring through safe-net.

**Not verified**: the wire paths and payloads (see the header of `src/backend.ts`) are checked only against our own
mock. Run the contract against a real Hindsight server before relying on it; recall that returns fact text without a
`document_id`, or documents listed under a different shape, would need a small adapter change there. No web form for
the config yet (REST only).
