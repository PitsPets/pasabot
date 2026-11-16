# @pasabot/mod-browser (W15)

Managed Chromium profiles that agents drive and the owner watches live.

- **Profiles** (`browser_profile`): name, colour, optional proxy (`http://`, `https://`, `socks5://`; the password is
  stored in the vault only), and a `loggedIn` flag. Each profile is a persistent Playwright context in
  `$PASABOT_HOME/browser-profiles/<id>` (inside `$PASABOT_HOME`, so no agent sandbox can read it). One tab per
  profile: popups open in that tab.
- **Agent tools** on the MCP gateway: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`.
  Tier 2 (web); **tier 3 on a profile with the owner's sign-ins** (`loggedIn`: set by the owner, and set
  automatically as soon as the owner drives the profile from the live view: the address bar, a click, a scroll,
  a key or typing, since a sign-in may need no typing). The edit form sends `loggedIn` only when the owner
  changed it. Page text goes back redacted and labelled `untrusted`.
- **Network guard** (`src/guard-proxy.ts`): Chromium sends every request, every redirect hop and every
  WebSocket through a per-start forward proxy on 127.0.0.1 (credentials only Chromium knows). It vets each
  request and CONNECT on its own with `@pasabot/safe-net` (`vetUrl`, no cache) and connects to the vetted IP
  only, so redirects to loopback and DNS rebinding are refused: loopback, private, link-local and metadata
  addresses are refused unless the owner lists the host under _Local addresses_
  (`PUT /api/m/browser/settings { allowHosts }`). A profile's own proxy is chained behind the guard and is
  asked for the vetted IP (CONNECT ip:port, or SOCKS5 to the IP); with an http(s) proxy, plain-http pages
  also go through CONNECT, so a proxy that refuses CONNECT to port 80 cannot load them. WebRTC may not send
  UDP around the proxy.
- **Browser hardening**: the renderer runs in Chromium's sandbox (`chromiumSandbox: true`; when the sandbox
  cannot start, Start answers 503 with the reason). Service workers: Playwright's `block` plus every worker
  that starts anyway is dropped (`Storage.clearDataForOrigin`), and stored ones are cleared before each start.
- **Live view**: the CDP screencast of the profile's tab is published as `browser.frame` live frames on the
  `owner` topic (at most 8 fps, newest frame always delivered) and as the last frame at
  `GET /api/m/browser/profiles/:id/frame`. The web shell re-dispatches them on `LIVE_EVENT`.
- **Web**: the Browser page (`#/browser`, full view with address bar, click, type and keys), an agent-details
  dock panel, and a pop-out panel that stays open across screens.
- Browsers close on Stop, after 15 minutes idle, and when the server closes (Playwright also kills them when
  the process exits).

Owner-only REST under `/api/m/browser/`: `GET/POST /profiles`, `PATCH/DELETE /profiles/:id`,
`POST /profiles/:id/{start,stop,navigate,input}`, `GET /profiles/:id/frame`, `GET/PUT /settings`.

Chromium comes from Playwright's browser cache (`npx playwright install chromium`); without it, Start answers
503 with the reason.

Tests: `vitest run modules/browser` (real headless Chromium, local test page on 127.0.0.1 port 0) and
`pnpm --filter @pasabot/mod-browser test:e2e` (build the web app first) at 1440 and 390 px. `pnpm install` does not
download the browser: on a fresh machine or CI runner run
`pnpm --filter @pasabot/mod-browser exec playwright-core install --only-shell chromium` once (add `--with-deps` on
Linux for its system libraries); without it the real-Chromium test files fail at once with that instruction.
