# apps/desktop — desktop wrappers (W26)

A person installs PasaBot without a terminal: a real app on macOS (its own window with the web app inside, a Dock icon
and a small menu-bar icon as a second control) and a tray app on Windows, that starts and stops the
local server, opens the web app, shows status, has the **Stop all** kill switch, an **Open at login** toggle, and an
update check that is **off by default**. User guide: `docs/INSTALL.md`.

## Why this shape (and not Tauri or Electron)

Checked on the build Mac (2026-11-14): node 24, Swift 6.4 + macOS SDKs from the Command Line Tools, `hdiutil`,
`codesign`; **no** Rust/cargo (so no Tauri), no Xcode, no Java (so no Android/Capacitor builds), no Inno Setup, no
Linux packagers. So:

- **All the logic is one Node launcher** (`src/`, unit-tested with Vitest): single instance, port pick, the server as
  a child process, Stop all, clean shutdown, open at login, update check, translated labels. It runs on the same node
  the server needs anyway.
- **The native part is a thin shell** that only draws what the launcher describes and sends commands back, one JSON
  object per line over stdin/stdout. macOS: one Swift file (`macos/PasaBotMenu.swift`, AppKit + WebKit, built with `swiftc`): the app window and the menu-bar icon.
  Windows: one PowerShell script on WinForms (`windows/PasaBotTray.ps1`), which ships with Windows.
  Electron would add ~200 MB and a second runtime for the same menu; Tauri needs Rust.
- Linux has no tray yet (desktops differ): `linux/` ships a starter that runs the launcher shell-less and opens the
  web app; Stop all is in the web app.

## How it works

```
PasaBot.app (Swift menu) ──stdin/stdout JSON lines──► launcher (node, src/main.ts) ──IPC channel──► pasabot-server
```

- The server is spawned with a Node IPC channel (ARCHITECTURE 4.3, an `iface:` change in `apps/server/src/host/main.ts`).
  Over it the server reports its real URLs (so port 0 works) and the first-run setup link, hands a fresh setup link
  to the window on `pasabot:setup-link` (shell command `setup-link`, event `setup-link`; null once there is an owner;
  see ARCHITECTURE 4.3 for its threat model), takes the
  `pasabot:stop-all` request (the W31 kill switch, as `asSystem('desktop app')`; resume stays owner + re-auth on the
  web), and **shuts down when the channel closes**. That is what guarantees no orphan server, even when the launcher
  is killed with SIGKILL.
- The launcher quits when its stdin closes (the menu app quit or crashed), stopping the server first: channel close,
  SIGTERM, SIGKILL after 10 s.
- Single instance: `$PASABOT_HOME/run/desktop.lock` (O_EXCL, pid + entry + URL + `show`); a dead or reused pid is
  stale. A second copy starts nothing. When the first one handles a poke (recorded as `show: true` in the lock: a
  shell with a window, `--window`, the macOS app; or a launcher that opens links itself, `--open-urls`, the Linux
  starter) the second launcher pokes it with SIGUSR2 and quits (`already-running` with `handedOff: true`, opening
  nothing): the macOS one sends its shell `{"event":"show"}`, the Linux one opens the app in the browser itself (a
  fresh setup link while unclaimed, from its own server channel, so the server's 10 s reuse covers a double click).
  Otherwise (Windows, which has no signals; an older first copy) the second copy opens the first one's URL or, while
  the server has no owner, a fresh setup link minted from the data dir (`mint-setup-link`, below), so the browser
  never lands on a bare or expired claim page. Opening the `.app` from Finder while it runs reaches the same window
  through the normal reopen event. A server started by `pasabot start` for the same data dir is left alone (status
  "running as a service").
- Setup links, Windows and Linux: their shells have no app window, so they open the claim page in the default
  browser, but a desktop user never has to know a code there either. While the server has no owner, every way they
  open the app asks for a **fresh** link at that moment and opens that: the first launch (the boot link, or for a
  server it did not start a freshly minted one), the tray's Open PasaBot (`{"cmd":"open"}`), Stop all on a server
  the app did not start (its button is in the web app), and a second launch (above). Once an owner exists they open
  the bare address. A browser tab left open past the 30 min while the person typed still gets "used up or expired" on
  submit (no web page can ever get a code), and that line says to click Open PasaBot in the PasaBot icon (a fresh
  link in a new tab), on Linux to start PasaBot again from the app menu, or run `pasabot setup-link`; the name typed
  stays in the form. For a server this launcher did not start (status `external`) it has no parent channel,
  so a fresh link comes from the server's one-shot minter (`apps/server/dist/host/mint-setup-link.js <url>` with
  `$PASABOT_HOME`; the same DB-level mint as `pasabot setup-link`: one live code, nothing once an owner exists;
  stdout only, never logged).
- Opening links safely (`src/opener.ts`): an argument array, never a shell (Windows: `rundll32
  url.dll,FileProtocolHandler <url>`, never `cmd /c start`, which cuts a URL at `&`; the tray opens by ShellExecute
  with the URL as the file name, not `Start-Process`; Linux: `xdg-open`, then `gio open`), and only a plain http(s)
  address. A setup link is never put in a tooltip, a notification or a log: with `--open-urls` nobody reads the
  launcher's stdout but the starter's `desktop.log`, so the code is written there as `token=<hidden>`. The server
  log's boot line stays the only place a link is written.
- Accepted risk, the browser's command line: opening a link hands it to the browser as an argument, and on Linux
  `xdg-open` passes it on to a browser it starts, which keeps it in `/proc/<pid>/cmdline` while it runs. Other local
  users can read that unless `/proc` is mounted with `hidepid`, and the server's 127.0.0.1 port is open to them too,
  so on a machine shared with other accounts one of them could claim an unclaimed PasaBot inside the code's 30 min.
  This has been true of the boot link since it was first opened, and now applies to every Open while unclaimed (each
  Open replaces the older code). Windows does not show other users' command lines to non-admins, and macOS `open`
  hands the link over by Apple Events, not argv. A redirect file (a 0600 HTML page opened by its `file://` path, as
  Jupyter does) would keep the code out of argv, but confined browsers cannot read it under a hidden home folder
  (Ubuntu's default snap Firefox reads only non-hidden files in home; Flatpak browsers read less), so the link would
  not open at all. Claim right away on a shared machine, or run `pasabot setup-link` and type the code there.
- Ports: the preferred port (`desktop.json`, default 7777/7778) while it is free, else 0; the port actually used is
  remembered so a paired phone keeps working.
- Settings: `$PASABOT_HOME/desktop.json` (0600, no secrets): `port`, `sitesPort`, `updateCheck` (false), `updateUrl`.
- Update check: only when switched on; one https GET of a static JSON file through `@pasabot/safe-net`, no
  identifying headers, never downloads anything. Source = `updateUrl`, else the URL baked in at build time, else none.
- Strings: `locales/*.json` (14 languages); the shells contain none (the launcher sends labels).

## The macOS app window

- **A regular app** (Dock icon, standard menus: PasaBot, Edit, View, Window). The window is an `NSWindow` with a
  `WKWebView` (WebKit from the Command Line Tools SDK) on the server URL the launcher reports, including the first-run
  setup link. Default 1200×800, at least 390 wide (the phone layout), size and position remembered
  (`setFrameAutosaveName`). ⌘W hides it, the server keeps running; a Dock click, opening the app again
  (`applicationShouldHandleReopen`) or a second launch (the SIGUSR2 hand-off above) shows it. It comes up with the
  first `status` event, so a second copy that only hands off never flashes a window. `PASABOT_DESKTOP_NO_BROWSER=1`
  keeps it closed (smoke runs); `PASABOT_DESKTOP_WINDOW=1` opens it anyway (smoke.sh's window check).
- **Web view safety** (`navigationVerdict`, `mayAskForMedia`, pure, in `--selftest`): the main frame loads only the
  app's own origin (scheme + host + port from `status.url`); any other http(s) URL (chat links, store pages, OAuth,
  the sites origin as a whole page) opens in the default browser; other schemes (file:, custom) are refused. Frames
  may load the app origin, the sandboxed sites origin (`status.sitesUrl`), about: and blob:; other frames are refused.
  `target=_blank` / `window.open` follow the same rule. No user scripts and one script message handler,
  `pasabotSetup` (`acceptsSetupLinkAsk`): the claim page of the app origin's main frame may post `need-setup-link`
  and the window moves it to a fresh `#/setup?token=` link in place (`setupLinkTarget`); frames and other origins are
  refused, and the page gets nothing back through it but one data-less `pasabot:no-setup-link` event when the
  launcher has no link (an owner exists, no server), so it says to reopen at once. The window also asks when it comes back (reopen, second launch,
  Open PasaBot), so a first-timer never sees a setup-code field however long the app sat open. Developer extras and `isInspectable` only with `PASABOT_DESKTOP_DEVTOOLS=1`. Downloads (`attachment` or a
  type the view cannot show) always go through a save panel; file inputs use the open panel; alert/confirm/prompt are
  native dialogs. Camera/mic: a system prompt for the app origin only, denied for every other origin; the usage
  strings are in `Info.plist` and, translated, in `<lang>.lproj/InfoPlist.strings` (generated by build-app.sh from
  `macos.micUsage` / `macos.cameraUsage`).
- **Not like the browser/PWA:** WKWebView gives apps no Web Push and no Notification API, so push and desktop
  notifications only work in a browser (Open in browser, then install the PWA there). Cookies and storage are the
  app's own (not shared with Safari or Chrome), so signing in once in the window is separate from the browser.
- **The menu-bar item** is one square template icon drawn in code (our own "Silip" mark, two eyes): open = running,
  closed = stopped or everything stopped, crossed = failed; the words are only the tooltip and the VoiceOver label.
  A full menu bar (notched MacBooks) can hide it; on macOS 27 (2026-11-14) AppKit even reported such an item as
  visible, on screen and not occluded while the bar did not show it. That no longer matters: the app window and the
  Dock icon are the main way in. The shell logs what AppKit says once, 1.5 s after launch (`PasaBot: menu-bar item …`).
- Windows and Linux: an app window without any SDK (`src/app-window.ts`): an installed Edge/Chrome/Brave/Chromium
  in app mode with PasaBot's own profile in the data folder, the default browser only when there is none. Not run on
  those systems by the author; `windows/selftest.ps1` and `linux/selftest.sh` check it there. What still differs from macOS: the web app
  opens in the default browser, not an in-app window, so a claim page left open past 30 min cannot be renewed in
  place (the person clicks Open PasaBot for a new tab), and the Linux starter has no tray or menu (starting it again
  is its Open).

## Build and test

```sh
npx pnpm@12.18.0 vitest run apps/desktop          # launcher unit tests + the real-server test
bash apps/desktop/macos/build-app.sh              # out/PasaBot.app, runs the server from this checkout
bash apps/desktop/macos/build-app.sh --skip-build --out apps/desktop/out/next   # another folder (a copy is running)
bash apps/desktop/macos/build-app.sh --payload copy --dmg   # self-contained app + PasaBot-<v>.dmg (unsigned)
bash apps/desktop/macos/smoke.sh [app]            # selftest, temp PASABOT_HOME, port 0, no browser, second-launch
                                                  # hand-off; quit + crash leave nothing
powershell -File apps/desktop/windows/build-windows.ps1  # Windows (CI: .github/workflows/desktop.yml)
bash apps/desktop/linux/build-linux.sh            # Linux tarball (not run yet; CI)
```

`.github/workflows/desktop.yml` builds, installs and self-checks the packages on windows-latest, ubuntu-latest and
macos-latest (unsigned artifacts only). Windows: `docs/WINDOWS.md` (install steps, the 2-minute owner check with
`windows/selftest.ps1`, and what only a real Windows run proves).

## Status

| Piece                                 | State                                                               |
| ------------------------------------- | ------------------------------------------------------------------- |
| Launcher + tests                      | built, tested here                                                  |
| macOS menu-bar app, `.app` + `.dmg`   | built and smoke-run here (unsigned)                                 |
| Windows tray + installer script       | scripted only, not run                                              |
| Linux tarball + desktop entry         | scripted only, not run; no tray (starting it again = Open)          |
| Signing, notarisation, store accounts | the owner's step (`docs/INSTALL.md`)                                |
| Menu-bar icon                         | code-drawn two-eyes template icon (3 states); a designer may refine |
| App (Dock / Finder) icon art          | open: the generic app icon shows while the Dock icon is up          |
