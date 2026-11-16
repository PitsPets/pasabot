# PasaBot on Windows 10 and 11

## Install (for anyone)

1. Download `PasaBot-Setup-<version>.exe` and double-click it. It installs for you only: no admin password, no
   "allow changes" prompt. Windows SmartScreen may say the app is unrecognised (it is not signed yet): click
   **More info**, then **Run anyway**.
2. Leave **Open PasaBot** ticked and click **Finish**. PasaBot opens in its own window (it uses the Microsoft Edge
   that comes with Windows, with a profile of its own, so your everyday browser is not touched).
3. Type your name and a password to claim it. That is all.
4. PasaBot also has a small icon next to the clock (it may hide under the **^** arrow). Click it to open PasaBot;
   right-click it for **Stop all**, **Open at login**, **Show log** and **Quit**.

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
   passwords in it). Send that file if anything failed.
5. Then try it by hand: open PasaBot from the Start menu, claim it, pick a brain, ask a helper something, press
   **Stop all** in the tray, quit from the tray, and check Task Manager shows no `node.exe` left.
6. Build it yourself on Windows: `powershell -ExecutionPolicy Bypass -File apps\desktop\windows\build-windows.ps1`
   (needs Node 22+ and, for the installer, Inno Setup 6). CI does all of this on `windows-latest`:
   `.github/workflows/desktop.yml` (build, silent install, selftest, no `node.exe` left, silent uninstall).

## What only a real Windows run proves

Everything in the code was written and unit-tested on a Mac with the Windows parts faked (the platform, the
registry, PowerShell, icacls, taskkill, the process table). These were never run on Windows by the author:
the tray (WinForms), the installer and uninstaller (Inno Setup), the junctions `links.ps1` makes, DPAPI, `icacls`
on the data folder, Edge in app mode, `taskkill` stopping a turn's whole process tree, npm `.cmd` shims started
without cmd.exe, the OpenCode download unpacked by Windows' `tar.exe`, and Windows' handling of long paths. The
self-check above and the CI job are how they are proven.
