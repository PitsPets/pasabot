# Installing PasaBot

PasaBot runs on your own computer. Nothing to sign up for, and nothing is sent to us: there is no "us" server.

## On a Mac (no terminal)

1. **Download** `PasaBot-<version>.dmg` from the release page the owner of your copy gave you.
2. **Open** the `.dmg` and drag **PasaBot** onto **Applications**.
3. **First open.** The app is not signed yet (see "For the owner: signing" below), so macOS asks before it runs it:
   - Open **Applications**, **right-click PasaBot → Open**, then **Open** again in the dialog.
   - On recent macOS versions: if there is no Open button, go to **System Settings → Privacy & Security**, scroll to
     the message about PasaBot and click **Open Anyway**.
     You only do this once.
4. **First run.** PasaBot opens as a normal app: its own **PasaBot window** (and a Dock icon), showing a one-time
   page to **claim PasaBot as its owner**: pick your password (or a passkey). The link works once, for 30 minutes.
   Missed it? Use the menu-bar icon → **Stop PasaBot**, then **Start PasaBot**: a fresh link opens in the window.
   You do not need a browser; **Open in browser** is there if you prefer one.
5. **Closing the window** (⌘W or the red button) only hides it: PasaBot keeps running. Click the Dock icon or open
   PasaBot again (Applications, Launchpad, Spotlight) to bring the window back. **Quit PasaBot** (⌘Q) stops
   everything.
6. A small **two-eyes icon** in the menu bar is a second switch (eyes open = running, eyes closed = stopped, crossed
   eyes = a problem; hover it for the details):

   | Menu item         | What it does                                                                                                                                                    |
   | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Open PasaBot      | shows the PasaBot window                                                                                                                                        |
   | Open in browser   | opens the same app in your default browser instead                                                                                                              |
   | Stop all agents   | the big red button: every running agent stops at once; resume it from the app (password)                                                                        |
   | Stop / Start      | stops or starts PasaBot itself                                                                                                                                  |
   | Open at login     | starts PasaBot when you log in (off until you tick it)                                                                                                          |
   | Check for updates | off by default; when on, it only reads one small public release file and tells you if a newer version exists; it never downloads or installs anything by itself |
   | Show logs         | shows PasaBot's log file in Finder                                                                                                                              |
   | Quit PasaBot      | stops PasaBot and everything it runs                                                                                                                            |

**Can't see the icon?** A full menu bar hides the newest icons, most often on MacBooks with a notch. You do not need
it: the window and the Dock icon do everything, and opening PasaBot again always brings the window up. To make room
in the menu bar, quit menu-bar apps you don't need, or turn some off in **System Settings → Menu Bar**.

**In the window compared with a browser:** links to other sites (chat links, store pages, sign-ins with other
services) open in your default browser; downloads ask where to save; the microphone (voice) asks for permission the
first time. Web push and desktop notifications from the web app are **not** available inside the window (the macOS
web view does not offer them to apps): use **Open in browser** and install it as a web app there if you want them.

Your data lives in the `.pasabot` folder in your home folder. Deleting the app never deletes it.

## On Windows

1. Download `PasaBot-Setup-<version>.exe` and run it. It installs for you only (no administrator needed).
2. Windows SmartScreen may say "Windows protected your PC" because the installer is not signed yet: click
   **More info → Run anyway**.
3. A PasaBot icon appears in the system tray (bottom right; it may hide behind the **^** arrow). The first-run
   claim page opens in your browser. The tray menu is the same as the Mac menu above, without the app window: an
   app window like the Mac one is planned for Windows and Linux too (scripted only, not built yet).

## On Linux

1. Download `pasabot-linux-<arch>-<version>.tar.gz` and unpack it to `/opt/pasabot` (or anywhere you like).
2. Run `pasabot-desktop` (or copy `pasabot.desktop` into `~/.local/share/applications` to get a menu entry). Your
   browser opens the claim page. Linux has no tray icon yet: use **Stop all** in the web app, and
   `pasabot-desktop --quit` to stop PasaBot.

## On your phone

The phone app is the web app, installed to your home screen (no app store):

1. Make your PasaBot reachable from the phone: same Wi-Fi is not enough by itself, since PasaBot only listens on the
   computer it runs on. The simplest safe way is Tailscale: see `deploy/REMOTE-ACCESS.md`.
2. In the web app on your computer, open **Devices** and scan the pairing QR code with the phone's camera; then
   confirm the phone on the computer.
3. On the phone: **iPhone**: Share → **Add to Home Screen**. **Android**: menu → **Install app**.
4. Allow notifications when PasaBot asks: it tells you when an agent finishes, fails, or needs your approval (web
   push; on iPhone this needs iOS 16.4+ and the app opened from the home screen).

## Link a second machine

PasaBot on two of your computers can work together (no account, no central server):

1. Install PasaBot on the second machine as above and claim it.
2. On the first machine: **Settings → Machines → Show a link code**. The code works once, for 10 minutes.
3. On the second machine: **Settings → Machines**, enter the code, choose what the other machine may do, and confirm
   with your password.
4. Back on the first machine, confirm the request (password again). Done: each machine keeps its own agents, data
   and rules. **Unlink** in the same place cuts it off at once.

## For technical users: one line

From a checkout of the repository (Node 22+):

```sh
npx --yes pnpm@12.18.0 install --frozen-lockfile && npx --yes pnpm@12.18.0 -r run build && node apps/cli/dist/main.js service install && node apps/cli/dist/main.js start && node apps/cli/dist/main.js setup-link
```

That builds everything, installs PasaBot as a login service (launchd on macOS, systemd `--user` on Linux), starts
it, and prints the one-time claim link. `deploy/README.md` has the Docker route and every ops verb. To build the
desktop apps yourself: `apps/desktop/README.md`.

## For the owner: signing and store accounts (later)

The packages are built unsigned on purpose: no signing identity, no Apple or Microsoft account and no telemetry are
in this repository. Before handing them to people who should not need the "Open Anyway" step:

- **macOS**: an Apple Developer ID, then `codesign --deep --options runtime --sign "Developer ID Application: …"`
  on `PasaBot.app` (the bundled `node` included), `xcrun notarytool submit PasaBot-<v>.dmg --wait`, and
  `xcrun stapler staple`. Native modules inside the bundle need signing too.
- **Windows**: an Authenticode certificate, then `signtool sign /fd sha256 /tr <timestamp URL> /td sha256` on the
  installer.
- **Updates**: host a static `latest.json` (`{"version":"x.y.z","page":"https://…"}`) on https and build with
  `--update-url https://…/latest.json`. The app only reads it when the person turned the check on.
- **Phone stores** (optional, the web app is the phone app): see `apps/mobile/README.md`.
