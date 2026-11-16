#!/usr/bin/env bash
# Build the Linux package (W26). NOT RUN on the build machine yet; meant for a Linux CI runner
# (apps/desktop/ci/desktop-packages.yml). Produces out/pasabot-linux-<arch>-<version>.tar.gz: the install, a node
# runtime, a `pasabot-desktop` starter and a desktop entry. No tray yet on Linux (desktops differ too much): the
# starter runs the launcher without a shell (--no-stdin --open-urls), opens the web app, and the web app has the
# Stop all button. Starting it again opens the app again: the running copy is poked and opens a fresh setup link
# while no one has claimed PasaBot yet (never a code to type), the plain address after. `pasabot-desktop --quit` stops it.
#   apps/desktop/linux/build-linux.sh [--node PATH] [--update-url URL] [--skip-build]
#   --skip-build: package the workspace's existing install and dist/ (CI builds in a step of its own first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
NODE_BIN="$(command -v node || true)"
UPDATE_URL=""
SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_BIN="$2"; shift 2 ;;
    --update-url) UPDATE_URL="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "build-linux: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$UPDATE_URL" in ""|https://*) ;; *) echo "build-linux: --update-url must be https" >&2; exit 2 ;; esac
[ -x "$NODE_BIN" ] || { echo "build-linux: no node binary (pass --node)" >&2; exit 2; }
command -v rsync >/dev/null || { echo "build-linux: rsync missing (apt-get install rsync)" >&2; exit 2; }
PNPM=(npx --yes pnpm@12.18.0)
if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$ROOT" && "${PNPM[@]}" install --frozen-lockfile && "${PNPM[@]}" -r run build)
fi
for f in apps/server/dist/host/main.js apps/desktop/dist/main.js apps/web/dist/index.html; do
  [ -f "$ROOT/$f" ] || { echo "build-linux: $f missing; run without --skip-build" >&2; exit 1; }
done
VERSION="$("$NODE_BIN" -p "require('$ROOT/apps/server/package.json').version")"
ARCH="$(uname -m)"
OUT="$ROOT/apps/desktop/out"
DEST="$OUT/pasabot"
rm -rf "$DEST" && mkdir -p "$DEST/pasabot"
(cd "$ROOT" && rsync -a --prune-empty-dirs \
  --exclude '.git' --exclude 'node_modules' --exclude '.claude' --exclude 'out' --exclude '*.test.*' \
  --exclude '__fixtures__' --exclude 'e2e' --exclude 'coverage' --exclude 'test-results' \
  --include '*/' --include 'package.json' --include 'pnpm-workspace.yaml' --include 'pnpm-lock.yaml' \
  --include '/LICENSE' --include '/NOTICE' --include '**/dist/**' --include '**/locales/**' \
  --include '**/migrations/**' --include '/catalog/**' --include '/deploy/release-keys/**' --include '**/skills/**' \
  --exclude '*' ./ "$DEST/pasabot/")
(cd "$DEST/pasabot" && PATH="$(dirname "$NODE_BIN"):$PATH" "${PNPM[@]}" install --prod --frozen-lockfile --offline)
cp "$NODE_BIN" "$DEST/node"
UPDATE_JSON=null
[ -n "$UPDATE_URL" ] && UPDATE_JSON="\"$UPDATE_URL\""
printf '{"root":"pasabot","updateUrl":%s,"payload":"copy"}\n' "$UPDATE_JSON" > "$DEST/payload.json"
cat > "$DEST/pasabot-desktop" <<'SH'
#!/bin/sh
# PasaBot starter: runs the launcher in the background (one per data dir) and opens PasaBot in its own app window
# (an installed Chromium, Chrome, Brave or Edge in app mode; the default browser when there is none).
# Everything it writes (the log) is this user's only.
umask 077
D="$(cd "$(dirname "$0")" && pwd)"
LOG="${PASABOT_HOME:-$HOME/.pasabot}/logs/desktop.log"
mkdir -p "$(dirname "$LOG")"
if [ "$1" = "--quit" ]; then
  pkill -TERM -f "$D/pasabot/apps/desktop/dist/main.js" ; exit 0
fi
nohup "$D/node" "$D/pasabot/apps/desktop/dist/main.js" --payload "$D/payload.json" --app "$D/pasabot-desktop" \
  --no-stdin --open-urls --app-window >>"$LOG" 2>&1 &
SH
chmod 755 "$DEST/pasabot-desktop"
cp "$HERE/pasabot.desktop" "$DEST/pasabot.desktop.in"
cp "$ROOT/apps/desktop/assets/option-b.svg" "$DEST/pasabot.svg"
cp "$HERE/install.sh" "$DEST/install.sh"
cp "$HERE/selftest.sh" "$DEST/selftest.sh"
chmod 755 "$DEST/install.sh" "$DEST/selftest.sh"
tar -C "$OUT" -czf "$OUT/pasabot-linux-$ARCH-$VERSION.tar.gz" pasabot
echo "build-linux: $OUT/pasabot-linux-$ARCH-$VERSION.tar.gz (unsigned)"
