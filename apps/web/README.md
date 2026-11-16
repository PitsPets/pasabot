# @pasabot/web

The PasaBot PWA: first-run setup (setup link), sign-in (password or passkey), device pairing by QR, agents
create/edit, the chat (streaming, tool-activity line, queued chip, interrupted card, approval card + pinned decision
bar with tier-3 re-auth), devices/passkeys and settings, EN/FIL. Design direction "Sabay" (tokens in `@pasabot/ui`).

- `src/shell` (W0a): web-module discovery by `import.meta.glob` and the slot renderer. Modules add pages, nav items,
  settings, header widgets, dock panels, block renderers and onboarding steps there; nothing here is edited for them.
- `src/app`: REST client, WebSocket client + store (resume from the last `seq`, `gap` -> REST refetch), hash router,
  i18n (`locales/{en,fil}.json` under the `web` namespace).
- `public/`: PWA manifest, icons (`node scripts/make-icons.mjs` regenerates the PNGs), network-first `sw.js`.

Run it:

```sh
npx pnpm@12.18.0 dev          # server (sources, $PASABOT_HOME=<repo>/.pasabot) on :7777 + Vite on http://localhost:5173
                              # the first-run setup link is printed by the server and opens the Vite origin
npx pnpm@12.18.0 build        # builds apps/web/dist; `pasabot-server` serves it at /
npx pnpm@12.18.0 test:e2e     # Vite build + Playwright (desktop + 390 px); each test boots its own server
```

Passkeys need a host name (`localhost`, a LAN or Tailscale name), not a bare IP.
