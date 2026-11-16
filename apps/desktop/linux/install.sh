#!/bin/sh
# Installs PasaBot for this user only, no root: copies this folder to ~/.local/share/pasabot and adds PasaBot to the
# app menu (~/.local/share/applications/pasabot.desktop, with its icon). Run it from the unpacked tarball:
#   ./install.sh            install or update (your data in ~/.pasabot is never touched)
#   ./install.sh --remove   take PasaBot out of the app menu and remove the program (your data stays)
set -eu
umask 022
SRC="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
case "$DATA" in /*) ;; *) DATA="$HOME/.local/share" ;; esac
DEST="$DATA/pasabot"
APPS="$DATA/applications"
case "$DEST" in
  *'|'*|*'&'*|*'
'*) echo "install.sh: the folder $DEST has a character a desktop entry cannot hold; set XDG_DATA_HOME" >&2; exit 2 ;;
esac
if [ "${1:-}" = "--remove" ]; then
  [ -x "$DEST/pasabot-desktop" ] && "$DEST/pasabot-desktop" --quit || true
  rm -f "$APPS/pasabot.desktop"
  rm -rf "$DEST"
  echo "PasaBot was removed. Your data in ${PASABOT_HOME:-$HOME/.pasabot} is still there."
  exit 0
fi
if [ "$SRC" != "$DEST" ]; then
  [ -x "$DEST/pasabot-desktop" ] && "$DEST/pasabot-desktop" --quit || true
  mkdir -p "$DEST"
  # a fresh copy: the old program files go, nothing else (the data folder is elsewhere)
  rm -rf "$DEST.new"
  cp -R "$SRC" "$DEST.new"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
fi
mkdir -p "$APPS"
# the desktop entry spells the install folder inside double quotes: \ " ` $ are escaped there
ESC="$(printf '%s' "$DEST" | sed -e 's/[\\"`$]/\\&/g')"
sed -e "s|Exec=\"__DIR__/pasabot-desktop\"|Exec=\"$ESC/pasabot-desktop\"|" -e "s|Icon=__DIR__/|Icon=$DEST/|" \
  "$DEST/pasabot.desktop.in" > "$APPS/pasabot.desktop"
chmod 644 "$APPS/pasabot.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
echo "PasaBot is installed. Open it from your app menu, or run: $DEST/pasabot-desktop"
