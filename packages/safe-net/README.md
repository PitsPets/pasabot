# @pasabot/safe-net

Outbound HTTP with an SSRF guard, plus the webhook HMAC helpers (ARCHITECTURE.md 5.3, 8).

- `safeFetch(url, opts)` resolves DNS itself, refuses loopback/private/link-local/CGNAT/ULA/metadata/NAT64 ranges unless the host is in `allowHosts`, connects to the exact IP it vetted (no second lookup), re-checks every redirect (max 5) and caps body size and time.
- `createSafeNet()` is the `SafeNet` port modules get as `host.net`.
- `safeConnect({ host, port, tls, onlyHosts, privateHosts?, ca? })` (W35) is outbound TCP for mail protocols: only a host named in `onlyHosts` (the owner-entered hosts of one mailbox), resolved once and pinned, blocked addresses refused unless the host is in `privateHosts` (operator config), always TLS with certificate + host name checks (`implicit`, or `starttls` then `startTls()`); `requireTls()` throws on a plain connection, so no client can authenticate in plaintext.
- `signWebhook` / `verifyWebhook` implement `v1=<hex HMAC-SHA256 over "v1:{ts}:{deliveryId}:{body}">` with a ±5 min window and constant-time compare.

Proof: `pnpm test:ssrf`.
