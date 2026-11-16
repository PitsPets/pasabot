# PasaBot on Windows 10 and 11

## Install (for anyone)

1. Download `PasaBot-Setup-<version>.exe` from <https://github.com/PitsPets/pasabot/releases> and double-click it.
   It installs for you only: no admin password, no "allow changes" prompt.
   - **Not signed yet.** Today's Windows builds are unsigned previews; signing is being set up
     ([SIGNING.md](SIGNING.md)). On a PC with **Smart App Control** turned on (Windows 11), Windows blocks an unsigned
     installer outright ("An Application Control policy has blocked this file"). There is no safe way around that:
     please do not turn Smart App Control or any other protection off for PasaBot (once off, Smart App Control cannot
     be turned back on without reinstalling Windows). Wait for a signed release instead.
   - Without Smart App Control, SmartScreen may say the app is unrecognised: **More info**, then **Run anyway**, only
     if you downloaded it from the releases page above and its SHA-256 matches `SHA256SUMS` there.
2. Leave **Open PasaBot** ticked and click **Finish**. PasaBot opens in its own window (it uses the Microsoft Edge
   that comes with Windows, with a profile of its own, so your everyday browser is not touched).
3. Type your name and a password to claim it. That is all.
4. PasaBot usually also has a small icon next to the clock (it may hide under the **^** arrow). Click it to open
   PasaBot; right-click it for **Stop all**, **Open at login**, **Show log** and **Quit**. On a PC whose security
   settings do not let PowerShell show it (Smart App Control and similar), there is no icon: PasaBot works from its
   window, and **Start menu › PasaBot › Stop PasaBot** quits it. **Check this computer** says which one your PC does.

Good to know:

- **Helpers have no safety box on Windows yet.** On a Mac and on Linux each helper runs in a sandbox that keeps it
  inside its own folder; on Windows it can open any file you can. PasaBot says so on its first screen, and new
  helpers ask you before they do anything outside their folder. Only add helpers you trust.
- **Computer use** (a helper using the screen) is not available on Windows yet.
- **Codex and OpenCode sign-in** needs Windows Developer Mode (Settings › System › For developers) so helpers can use
  your sign-in. Claude works without it.
- Your data stays in `%USERPROFILE%\.pasabot`, locked to your Windows account. Saved keys are protected by Windows
  itself (only your account on this PC can open them). Uninstalling keeps your data unless you say otherwise.
- PasaBot only listens on this PC (127.0.0.1), so Windows Firewall never asks.
- Logs: right-click the icon › **Show log**, or `%USERPROFILE%\.pasabot\logs`.

## Check it works (for the owner, about 2 minutes)

1. On a real Windows 10 or 11 PC, install `PasaBot-Setup-<version>.exe` as above (or build it: below).
2. Start menu › **PasaBot** › **Check this computer** (or Settings › Advanced › This computer › Check this computer
   inside PasaBot).
3. A window lists each check as PASS, FAIL or SKIP and ends with **ALL GOOD** or **N FAILED**. It uses a test folder,
   never your own data, and stops everything it started.
4. The same table is saved as `selftest-report.txt` in `%LOCALAPPDATA%\Programs\PasaBot` (no codes, keys or
   passwords in it). Send that file if anything failed, with `selftest-logs.txt` beside it: what the test run logged
   (codes hidden), written only when a check failed.
5. Then try it by hand: open PasaBot from the Start menu, claim it, pick a brain, ask a helper something, press
   **Stop all** in the tray, quit from the tray, and check Task Manager shows no `node.exe` left.
6. Build it yourself on Windows: `powershell -ExecutionPolicy Bypass -File apps\desktop\windows\build-windows.ps1`
   (needs Node 22+ and, for the installer, Inno Setup 6). CI does all of this on `windows-latest`:
   `.github/workflows/desktop.yml` (build, silent install, selftest, no `node.exe` left, silent uninstall).

## What only a real Windows run proves

Everything in the code was written and unit-tested on a Mac with the Windows parts faked (the platform, the
registry, PowerShell, icacls, taskkill, the process table). These were never run on Windows by the author:
the tray (WinForms), the installer and uninstaller (Inno Setup), the junctions `windows-shell.js links` makes, the
starter that picks the tray or the window alone, `Stop PasaBot`, better-sqlite3 compiled from source, DPAPI, `icacls`
on the data folder, Edge in app mode, `taskkill` stopping a turn's whole process tree, npm `.cmd` shims started
without cmd.exe, the OpenCode download unpacked by Windows' `tar.exe`, and Windows' handling of long paths. The
self-check above and the CI job are how they are proven. Not provable on CI at all: how a PC with Smart App Control
treats a signed release (whether PowerShell then runs the tray, the access-list and DPAPI steps in Full Language
mode, and whether the unsigned voice libraries are blocked); that needs a real PC once signing is in place.
