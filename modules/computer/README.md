# @pasabot/mod-computer — computer use and remote desktop (W16)

Agents see and drive a display through the core `ComputerDriver` port; the owner watches each agent's display in
a VNC-style viewer on the **Computer** screen (`#/computer`) and can take over.

## Drivers (`src/drivers`)

| Driver     | Where                     | How                                                                                                                                         |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `xvfb`     | Linux (default)           | one Xvfb per agent (`-displayfd`, `-auth` cookie, `-nolisten tcp -nolisten local`), xdotool, ImageMagick `import`; image: `deploy/computer` |
| `macos`    | macOS, **opt-in only**    | the owner's own screen through **PasaBot Screen Helper**, a separate app (unix socket + per-action grants)                                  |
| `practice` | tests, e2e, trying it out | an in-memory test app (button, text box, pointer) drawn as a real PNG                                                                       |

`PASABOT_COMPUTER_DRIVER` = `xvfb` | `macos` | `practice` | `off` overrides the platform default.

- **Separate display.** The agent's Xvfb display is never the owner's: Xvfb picks a free display, a number equal
  to the owner's `$DISPLAY` is refused, and every helper runs with only `PATH`, the agent's `DISPLAY` and that
  display's own cookie file as `XAUTHORITY` (never the owner's `XAUTHORITY`, no `HOME` or session bus).
- **Only PasaBot's helpers can connect.** Each display gets a fresh MIT-MAGIC-COOKIE-1 in a 0600 file under
  `$PASABOT_HOME/modules/computer/xauth/` (hidden from agent sandboxes), Xvfb runs with `-auth <file>`, and with
  `-nolisten tcp -nolisten local` there is no TCP port and no Linux abstract socket, only the path socket in
  `/tmp/.X11-unix` (which a sandbox's own `/tmp` hides). An agent's CLI that finds the display number with
  `xdotool`/`import` from its workspace shell is refused, so the tier-3 tools stay the only way in. The cookie
  file is removed when the display stops. A Mac has no separate display, so macOS stays off for **every agent**
  until the owner turns it on for **that one agent** in the Computer screen with a fresh re-auth
  (`PUT /macos/:agentId` answers 401 `reauth_required` otherwise). It is re-checked before every agent action (a
  display of an agent that was turned off is stopped), the server-wide switch of earlier builds (`macos_opt_in`) is
  ignored, and the screen says plainly that the agent then uses the owner's own screen and what the macOS
  permissions mean (below).
- Input checks are plain loops (no regex on agent text): whole-pixel coordinates inside the display, text ≤ 2000
  characters without control characters, key chords of letters/digits/`_+-` (never starting with `-`), ≤ 16.
  Helpers run without a shell; xdotool gets `--` before typed text and keys.

## Tools (all through the `/mcp` gateway)

`computer_screenshot`, `computer_click`, `computer_move`, `computer_type`, `computer_key` are **tier 3**: the
owner is asked every time, at every trust level, and approves only from a paired device with re-auth.
`computer_display` (tier 0) only says whether computer use is set up and the display size. A screenshot is saved
as a PNG in the agent's workspace (`.pasabot/computer/`), the result names the file (`inline: true` adds base64).

## Owner REST (`/api/m/computer`, owner session only; members/guests 403)

`GET /status` (with `macosAgents`: every live agent and whether it may use this Mac), `GET /displays/:agentId/frame`
(PNG, `no-store`), `POST /displays/:agentId/act` (take over: click/move/type/key, logged as the owner),
`POST /displays/:agentId/stop`, `GET /actions`, `PUT /macos/:agentId` (`{ enabled }`; turning on needs a fresh
re-auth, turning off does not and stops that agent's macOS display), `GET /helper` (the Screen Helper's ticks),
`POST /helper/open` (`{ pane: "screen" | "accessibility" }`), `POST /try/:agentId` (one picture),
`GET /displays/:agentId/preview` (the newest frame already taken, for the approval card).

Every action is a `computer_action` row and a `computer.action` event on the owner-only `owner` topic. Typed text
is never stored or published, for the agent or the owner: the row says only `type (N characters)` (the agent's
text was shown on the tier-3 approval card; the owner's take-over box is a masked, non-autofilled field). A started Xvfb is reported with `procs.started`, so Background processes lists it.

## Proofs

- `src/computer.test.ts`: tools over `/mcp` with the practice driver (tier 3 asked for a trusted agent on an owner
  turn and for a guarded one; denied click never reaches the app; typed text, the owner's included, never in the log; secrets redacted from
  approvals),
  owner REST and 403s; macOS off for every agent until turned on for that agent with re-auth (the old server-wide
  switch ignored, the other agent still refused before any action, off again at once).
- `src/drivers.test.ts`: the Xvfb driver against stub `Xvfb`/`xdotool`/`import` (exact argv incl. `-auth` and
  `-nolisten local`, a 0600 cookie file per display that is removed on stop, scrubbed env, owner display refused,
  every stub process stopped); the macOS driver is in `src/helper.test.ts`.
- `src/xvfb-live.test.ts`: the real thing in the `deploy/computer` proof image (`PASABOT_LIVE_XVFB=1`), including a
  client without the cookie (or with another display's cookie) being refused and no abstract or TCP listener.
- `e2e/computer.spec.ts` (Playwright, 1440 + 390 px, shared e2e server with `PASABOT_COMPUTER_DRIVER=practice`):
  the Fake agent screenshots and clicks the test app's button after tier-3 approvals with re-auth, the owner sees
  the pressed button in the live frame, the action log, takes control (click + type) and stops the display.

## macOS: PasaBot Screen Helper

macOS gives Screen Recording and Accessibility to the _responsible_ process, and agent CLIs are children of the
server, so those permissions must never be given to the server (or Terminal/node). They belong to **PasaBot Screen
Helper** (`apps/desktop/macos/ScreenHelper.swift`, bundle id `ai.pasabot.screenhelper`, built by
`build-screen-helper.sh` into `PasaBot.app/Contents/Helpers/`), a menu-bar app the desktop launcher starts through
LaunchServices (`open -g -a`), so it is its own responsible process.

- **Private channel** (`src/helper/protocol.ts`): unix socket `$PASABOT_HOME/run/screen.sock` (0600 in a 0700
  folder, no TCP port), peer must be the same user, and an HMAC challenge with the per-launch key
  `$PASABOT_HOME/run/screen.key` (32 random bytes the launcher writes fresh on every start, 0600; agent sandboxes
  cannot read `$PASABOT_HOME`). The server refuses a socket, key or folder with group/other bits (`checkPrivate`).
- **Grants**: every verb that sees or touches the screen (`screenshot`, `displays`, `move`, `click`, `type`, `key`,
  `resume`) carries `{ id, exp, mac }`, HMAC-signed over the verb and its exact arguments (typed text as its
  SHA-256). The server mints one (`GrantIssuer`) only on a path the owner approved: a tier-3 tool handler, the
  owner's take-over, the owner's live view, "Try it". The helper refuses a missing, forged, mismatched, expired (30 s),
  far-ahead or replayed grant, then the rate (8 inputs / 6 pictures per 2 s), then a stop, then a password box
  (`IsSecureEventInputEnabled` or a focused `AXSecureTextField`: `secure_input`, "type it yourself"), then a
  protected window (System Settings, SecurityAgent, keychain, permission prompts, its own windows).
- **Visible and stoppable**: a menu-bar dot and an orange screen border while it acts; holding **Esc for 1 s** or
  its menu's Stop cuts control at once and turns every agent's switch off (each needs the owner's password again);
  **Stop all** sends `stop` to the helper and closes the display; only an owner action (turning an agent back on,
  resuming Stop all) sends the granted `resume`.
- **Per-agent switch**: off for every agent until the owner says yes for that one agent with a fresh re-auth,
  re-checked before every action. Before any approval card, a call from an agent that is off (or whose helper is
  not ready) is refused and the chat gets the **setup card** instead.
- **Cards** (owner's rule: everything is a card with clear buttons): the setup card ("Let Tala use this
  computer?" → password → step cards with live ticks for the helper, Screen Recording and Accessibility, each with a
  button that only OPENS the exact System Settings pane → "Try it" with the picture), the approval card's picture
  (the newest frame with a red ring where it will click; the text and its length for typing; never a new capture),
  and the "watch live" card (live picture, Take over, Stop). The Computer screen shows the same setup cards.
- Proofs: `src/helper.test.ts` (grant protocol, socket/key permissions, secure input, protected window, rate, both
  stop paths, the driver and the whole module against `src/helper/fake.ts`, a fake helper on a real socket);
  `ScreenHelper --selftest` (45 checks incl. the shared grant vector, without any permission);
  `e2e/computer-mac.spec.ts` (the cards at 1440 and 390 px against the fake helper).

Not verified here: a real Xvfb run (needs Docker on Linux: `deploy/computer/proof.sh`) and the Screen Helper
driving a real screen (it needs the owner to grant Screen Recording and Accessibility by hand; its `--selftest` and
the fake-helper proofs run without them).
