# @pasabot/mod-push (W23)

Web push as the `push` Notifier transport, plus Settings → Notifications on this device.

- **What arrives**: approvals needed, failed runs and other alerts (core notifications, by `category`; one without a
  `userId` reaches only the owner's devices), a finished reply and "still working" progress for a long run (from the
  bus, only for runs a person asked for, to the people who can read that chat; tag `run:<id>` so the reply replaces
  the progress note). Each device chooses its kinds (progress off by default).
- **Delivery**: RFC 8291 `aes128gcm` encryption and RFC 8292 VAPID on `node:crypto` (no push library), sent through
  safe-net, only to known push services (FCM, Mozilla, Apple, Windows; `extraHosts` for tests or a self-hosted
  service). The VAPID private key is in the vault (`module:push`); a 404/410 drops the subscription; endpoints are
  never logged or returned. The service worker (`apps/web/public/sw.js`) shows the push and opens the app at its link.
- **Signed-in devices only**: a subscription belongs to the session that turned it on. Logging out, revoking the
  device, the session expiring or the person being turned off all stop its pushes (checked before every send
  through `ModuleHost.sessions`; the row is dropped); signing in again needs notifications turned on again.
- **Tables**: `push_sub` (per browser), `push_key` (public key + vault reference).

Proofs: `pnpm vitest run modules/push` (a push arrives on an approval and on an agent error at a mock push service
that verifies the VAPID signature and decrypts the payload; per-device choices; owner-only notices; dead endpoints
dropped; nothing after logout, device revoke or expiry; unknown hosts refused) and `pnpm --filter @pasabot/mod-push test:e2e` (1440 + 390 px: turn on with a stub
browser subscription, choices saved; Chrome's installability check passes; the offline shell opens offline).

Needs a real run: delivery through a real browser push service (FCM / Mozilla / Apple) to a real phone; that needs
the network and a real device, so it is not part of the automated tests.
