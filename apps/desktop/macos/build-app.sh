#!/usr/bin/env bash
# Build PasaBot.app (app window + menu-bar icon, UNSIGNED) and, with --dmg, PasaBot.dmg. Needs only the Xcode Command Line Tools
# (swiftc, hdiutil) and node; no Xcode project, no signing identity, no Apple account.
#
#   apps/desktop/macos/build-app.sh [--payload link|copy] [--out DIR] [--node PATH] [--update-url URL] [--dmg]
#                                   [--skip-build]
#
# --payload link  (default) the app runs the server from THIS checkout: quick local builds and the smoke test.
#                 Not for handing to anyone: it breaks when the checkout moves.
# --payload copy  the app carries its own copy of the built install (production dependencies only): this is the
#                 one to put in a .dmg.
# --node          node binary to bundle (default: the one on PATH). Bundle the official nodejs.org build for a
#                 release; native modules (better-sqlite3) must be installed with that same node version.
# --update-url    https URL of the static release file the (off by default) update check reads.
#
# Signing and notarisation are the owner's later step (docs/INSTALL.md, "For the owner: signing").
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PAYLOAD=link
OUT="$ROOT/apps/desktop/out"
NODE_BIN="$(command -v node || true)"
UPDATE_URL=""
DMG=0
SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --payload) PAYLOAD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --update-url) UPDATE_URL="$2"; shift 2 ;;
    --dmg) DMG=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "build-app: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "build-app: macOS only" >&2; exit 2; }
[ -x "$NODE_BIN" ] || { echo "build-app: no node binary (pass --node)" >&2; exit 2; }
command -v swiftc >/dev/null || { echo "build-app: swiftc missing: xcode-select --install" >&2; exit 2; }
case "$PAYLOAD" in link|copy) ;; *) echo "build-app: --payload link|copy" >&2; exit 2 ;; esac
case "$UPDATE_URL" in ""|https://*) ;; *) echo "build-app: --update-url must be https" >&2; exit 2 ;; esac

PNPM=(npx --yes pnpm@12.18.0)
if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$ROOT" && "${PNPM[@]}" -r run build)
fi
for f in apps/server/dist/host/main.js apps/desktop/dist/main.js apps/web/dist/index.html; do
  [ -f "$ROOT/$f" ] || { echo "build-app: $f missing; run without --skip-build" >&2; exit 1; }
done
VERSION="$(cd "$ROOT" && "$NODE_BIN" -p 'require("./apps/server/package.json").version')"

APP="$OUT/PasaBot.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. the shell: one Swift file, AppKit + WebKit (both in the Command Line Tools SDK)
swiftc -O -framework AppKit -framework WebKit -o "$APP/Contents/MacOS/PasaBot" "$HERE/PasaBotMenu.swift"

# 2. Info.plist: a regular app (Dock icon, own window); the camera/mic reasons in every app language, taken from
#    apps/desktop/locales (macos.micUsage / macos.cameraUsage) into <lang>.lproj/InfoPlist.strings
sed -e "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
"$NODE_BIN" -e '
  const fs = require("node:fs"), path = require("node:path");
  const [dir, out] = process.argv.slice(1);
  const q = (s) => JSON.stringify(s);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const lproj = path.join(out, f.replace(/\.json$/, "") + ".lproj");
    fs.mkdirSync(lproj, { recursive: true });
    fs.writeFileSync(path.join(lproj, "InfoPlist.strings"),
      `"NSMicrophoneUsageDescription" = ${q(d["macos.micUsage"])};\n"NSCameraUsageDescription" = ${q(d["macos.cameraUsage"])};\n`);
  }' "$ROOT/apps/desktop/locales" "$APP/Contents/Resources"

# 2b. app icon: assets/option-b*.svg (the "Silip" icon; small variant for 16/32px) -> PasaBot.icns via a tiny AppKit
#     renderer (Command Line Tools only) and iconutil
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
swiftc -O -framework AppKit -o "$ICON_TMP/render-icon" "$HERE/render-icon.swift"
SET="$ICON_TMP/PasaBot.iconset"
mkdir -p "$SET"
ASSETS="$ROOT/apps/desktop/assets"
render_icon() { # <pixels> <file name>: the small drawing up to 32px, the full one above
  local svg="$ASSETS/option-b.svg"; [ "$1" -le 32 ] && svg="$ASSETS/option-b-small.svg"
  "$ICON_TMP/render-icon" "$svg" "$1" "$SET/$2"
}
for n in 16 32 128 256 512; do
  render_icon "$n" "icon_${n}x${n}.png"
  render_icon "$((n * 2))" "icon_${n}x${n}@2x.png"
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/PasaBot.icns"

# 3. node runtime
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod 755 "$APP/Contents/Resources/node"

# 4. the install the launcher runs (payload.json tells it where)
json_str() { "$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
UPDATE_JSON=null
[ -n "$UPDATE_URL" ] && UPDATE_JSON="$(json_str "$UPDATE_URL")"
if [ "$PAYLOAD" = link ]; then
  printf '{"root":%s,"updateUrl":%s,"payload":"link"}\n' "$(json_str "$ROOT")" "$UPDATE_JSON" \
    > "$APP/Contents/Resources/payload.json"
else
  STAGE="$APP/Contents/Resources/pasabot"
  mkdir -p "$STAGE"
  # sources stay out; built output, manifests, locales, catalog data and release keys go in
  (cd "$ROOT" && rsync -a --prune-empty-dirs \
    --exclude '.git' --exclude 'node_modules' --exclude '.claude' --exclude 'out' --exclude '*.test.*' \
    --exclude '__fixtures__' --exclude 'e2e' --exclude 'coverage' --exclude 'test-results' \
    --include '*/' \
    --include 'package.json' --include 'pnpm-workspace.yaml' --include 'pnpm-lock.yaml' --include '.npmrc' \
    --include '/LICENSE' --include '/NOTICE' --include '**/dist/**' --include '**/locales/**' \
    --include '**/migrations/**' --include '/catalog/**' --include '/deploy/release-keys/**' --include '**/skills/**' \
    --exclude '*' ./ "$STAGE/")
  # production dependencies only, from the local store (no network), installed with the bundled node's ABI
  (cd "$STAGE" && PATH="$(dirname "$NODE_BIN"):$PATH" "${PNPM[@]}" install --prod --frozen-lockfile --offline)
  printf '{"root":"pasabot","updateUrl":%s,"payload":"copy"}\n' "$UPDATE_JSON" > "$APP/Contents/Resources/payload.json"
fi

# 4b. W16: PasaBot Screen Helper, its own app with its own bundle id (the only one that holds Screen Recording and
#     Accessibility), bundled in Contents/Helpers; the launcher starts it through LaunchServices with a fresh key
mkdir -p "$APP/Contents/Helpers"
"$HERE/build-screen-helper.sh" --out "$APP/Contents/Helpers"

# 5. ad-hoc signature only (no identity): lets the binary run locally; Gatekeeper still treats the app as unsigned
codesign --force --sign - "$APP/Contents/MacOS/PasaBot" >/dev/null 2>&1 || true

echo "build-app: $APP ($PAYLOAD payload, version $VERSION, unsigned)"

if [ "$DMG" = 1 ]; then
  [ "$PAYLOAD" = copy ] || { echo "build-app: a .dmg needs --payload copy" >&2; exit 2; }
  DMG_DIR="$OUT/dmg"
  rm -rf "$DMG_DIR" "$OUT/PasaBot-$VERSION.dmg"
  mkdir -p "$DMG_DIR"
  cp -R "$APP" "$DMG_DIR/"
  ln -s /Applications "$DMG_DIR/Applications"
  hdiutil create -volname "PasaBot" -srcfolder "$DMG_DIR" -ov -format UDZO "$OUT/PasaBot-$VERSION.dmg" >/dev/null
  rm -rf "$DMG_DIR"
  echo "build-app: $OUT/PasaBot-$VERSION.dmg (unsigned, not notarised)"
fi
