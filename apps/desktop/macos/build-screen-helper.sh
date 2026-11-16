#!/usr/bin/env bash
# Build "PasaBot Screen Helper.app" (W16): the separate menu-bar app that alone holds Screen Recording and
# Accessibility for computer use, with its own bundle id. Needs only the Command Line Tools (swiftc, codesign).
#
#   apps/desktop/macos/build-screen-helper.sh [--out DIR] [--selftest]
#
# Signing is configuration, not code: by default the app is ad-hoc signed ("-") like PasaBot.app. It is ALWAYS signed
# with the hardened runtime, ad-hoc too: without it macOS honours DYLD_INSERT_LIBRARIES, and code loaded that way
# would run with the helper's Screen Recording and Accessibility. The build fails if the signature lacks it, or if
# the entitlements would switch library validation or the dyld variables back on. For a release set
#   SCREEN_HELPER_SIGN_IDENTITY="Developer ID Application: ..."  (codesign identity; adds a secure timestamp)
#   SCREEN_HELPER_BUNDLE_ID=ai.pasabot.screenhelper              (keep it stable: macOS keys the permissions to it)
#   SCREEN_HELPER_ENTITLEMENTS=path/to/file.entitlements          (optional)
# Note: an ad-hoc signature changes with every build, so macOS asks for Screen Recording / Accessibility again after
# each rebuild; a real identity keeps the permission across updates.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$ROOT/apps/desktop/out"
SELFTEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "build-screen-helper: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "build-screen-helper: macOS only" >&2; exit 2; }
command -v swiftc >/dev/null || { echo "build-screen-helper: swiftc missing: xcode-select --install" >&2; exit 2; }

BUNDLE_ID="${SCREEN_HELPER_BUNDLE_ID:-ai.pasabot.screenhelper}"
IDENTITY="${SCREEN_HELPER_SIGN_IDENTITY:--}"
ENTITLEMENTS="${SCREEN_HELPER_ENTITLEMENTS:-}"
if [ -n "$ENTITLEMENTS" ]; then
  for bad in com.apple.security.cs.disable-library-validation com.apple.security.cs.allow-dyld-environment-variables \
    com.apple.security.get-task-allow com.apple.security.cs.allow-unsigned-executable-memory \
    com.apple.security.cs.disable-executable-page-protection; do
    if grep -q "$bad" "$ENTITLEMENTS"; then
      echo "build-screen-helper: $ENTITLEMENTS asks for $bad, which would let other code run inside the helper" >&2
      exit 2
    fi
  done
fi
VERSION="$(sed -n 's/^let helperVersion = "\(.*\)"$/\1/p' "$HERE/ScreenHelper.swift")"

APP="$OUT/PasaBot Screen Helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -swift-version 5 -O \
  -framework AppKit -framework ScreenCaptureKit -framework CryptoKit -framework ApplicationServices -framework Carbon \
  -o "$APP/Contents/MacOS/PasaBotScreenHelper" "$HERE/ScreenHelper.swift"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUNDLE_ID__/$BUNDLE_ID/g" "$HERE/ScreenHelper-Info.plist" \
  > "$APP/Contents/Info.plist"

SIGN=(codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --options runtime)
if [ "$IDENTITY" != "-" ]; then SIGN+=(--timestamp); fi
if [ -n "$ENTITLEMENTS" ]; then SIGN+=(--entitlements "$ENTITLEMENTS"); fi
"${SIGN[@]}" "$APP" >/dev/null
# the check, not a hope: the signature must carry the hardened runtime flag
FLAGS="$(codesign -d --verbose=2 "$APP" 2>&1 | sed -n 's/.*flags=\(0x[0-9a-f]*([^)]*)\).*/\1/p' | head -1)"
case "$FLAGS" in
  *runtime*) ;;
  *) echo "build-screen-helper: the helper is not signed with the hardened runtime (flags: ${FLAGS:-none})" >&2; exit 3 ;;
esac
echo "build-screen-helper: $APP ($BUNDLE_ID, version $VERSION, signed: $IDENTITY, $FLAGS)"

if [ "$SELFTEST" = 1 ]; then
  "$APP/Contents/MacOS/PasaBotScreenHelper" --selftest
fi
