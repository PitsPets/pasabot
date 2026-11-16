# @pasabot/mod-channels (W4b)

Channel bindings: the `channels_*` tables (ARCHITECTURE 3.2) and **Settings → Channels**.

- **REST** (`/api/m/channels/*`, owner session only): `GET /bindings`, `POST /bindings` (`kind`, `agentId`,
  `secrets` = the adapter's `secretFields`, optional `label` and `allowedSenders`), `PATCH /bindings/:id`
  (label, agent, on/off, allowed senders, a replacement token), `DELETE /bindings/:id`, `POST /bindings/:id/restart`,
  `POST /bindings/:id/link` (one-time owner link code, 10 min, shown once, only its hash is stored),
  `DELETE /bindings/:id/owner`, and (W5) `POST|GET|DELETE /bindings/:id/pairing` (QR link; starting needs
  `{ acknowledgeRisk: true }` and an unlinked or disabled binding, else 409 `already_linked`; the pairing writes a
  staging vault entry that replaces the live session only on `done`). `options` (create/patch) set an adapter's non-secret settings. Public:
  `POST /hooks/channels/:bindingId/events` hands push events (Slack) to the live connection. Tokens go straight into the vault (`module:channels` scope) and are never returned.
  Every change is audited and published as `channels.changed` on `module:channels`.
- **Runtime**: lives in the server (`apps/server/src/channels/runtime.ts`) because it writes core chat rows. It
  starts one connection per enabled binding from the ChannelRegistry (backoff 1 s → 60 s, status in
  `channels_binding.status`/`last_error`/`last_event_at`), applies `decideChannelInbound` from `@pasabot/core`,
  writes the inbound text as an `external` message in the place's chat (kind `channel`) and enqueues a quoted turn
  with `idem_key = channel:<binding>:<externalId>`; replies go out as a placeholder that is edited while the run
  streams; approval prompts go out with `/approve <id>` for tier ≤ 2 (owner only) and a device-only note for tier 3.
  `channels_delivery` keeps one row per mirrored reply so a restart finishes, never repeats, a send.
- **Web**: `web/index.tsx` fills the `settingsSections` slot; strings in `locales/{en,fil}.json`.

Proof: `pnpm vitest run apps/server/src/channels` (FakeChannel) and `apps/web/e2e/channels.spec.ts` +
`apps/web/e2e/whatsapp.spec.ts` (Playwright).
