# apps/mobile — the phone app (W26)

**The phone app is the PasaBot web app (PWA), installed to the home screen.** It is already installable (W23:
manifest, offline shell, Lighthouse installable) and gets **web push** for agent finished / error / approval
(`modules/push`). User steps: `docs/INSTALL.md`, "On your phone".

No native shell project lives here yet, on purpose:

- A Capacitor-style shell needs Xcode (iOS) or a JDK + Android SDK (Android) to even add its platform folders; the
  build Mac has neither Xcode nor Java (checked 2026-11-14), so nothing could be built or tested.
- A store build needs an Apple Developer / Google Play account, which this repository never holds.
- Every server is the owner's own, at their own address, so the shell would first need an "add your server / scan
  the pairing QR" screen. That screen is a design decision still to make.

## Exact steps for the owner, when a store app is wanted

1. Install Xcode (iOS) and/or Android Studio + a JDK 21 (Android).
2. Create the shell (Apache-2.0 Capacitor, no account needed for this part):

   ```sh
   mkdir -p apps/mobile && cd apps/mobile
   npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/push-notifications @capacitor/barcode-scanner
   npx cap init PasaBot app.pasabot.mobile --web-dir www
   npx cap add ios && npx cap add android
   ```
3. `www/` holds only the first screen (enter the server address or scan the pairing QR from **Devices** on the
   computer); after pairing the WebView navigates to the owner's server, which already serves the full web app.
   Keep `server.allowNavigation` limited to the paired host.
4. Push: on iOS and Android the shell can keep using the web push subscription the PWA already makes; native
   APNs/FCM would need an Apple/Google push key in the server vault and a new `Notifier` transport (a W23 change).
5. Build and run: `npx cap open ios` (simulator: pair by scanning the QR shown on the computer) or
   `npx cap open android`. Signing, store listings and accounts are the owner's.
