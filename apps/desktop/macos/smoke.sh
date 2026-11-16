#!/usr/bin/env bash
# Smoke run of the BUILT PasaBot.app with a throwaway $PASABOT_HOME (never ~/.pasabot), any free port, no browser,
# and a test-only vault passphrase so the login keychain is not touched. Checks: the menu-bar app starts the
# server, the API and the web UI answer, the first run opens the app window on the server's own URL
# (PASABOT_DESKTOP_WINDOW=1; the second run stays headless), opening the app a second time hands off to the running
# copy (it brings its window up, asks for a fresh setup link while there is no owner, the second copy quits and starts
# nothing), a normal quit (SIGTERM) and a crash
# (SIGKILL) of the app both leave no launcher and no server behind. First the shell's pure decisions (`--selftest`:
# what may load inside the window, camera/mic, icon state, window at launch) run without a GUI.
#
#   apps/desktop/macos/smoke.sh [path/to/PasaBot.app]      (default apps/desktop/out/PasaBot.app)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HERE/../out/PasaBot.app}"
BIN="$APP/Contents/MacOS/PasaBot"
[ -x "$BIN" ] || { echo "smoke: $BIN missing; run build-app.sh first" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pasabot-smoke.XXXXXX")"
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

field() { /usr/bin/python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"; }
alive() { kill -0 "$1" 2>/dev/null; }
wait_gone() { for _ in $(seq 1 200); do alive "$1" || return 0; sleep 0.1; done; return 1; }

run_once() { # $1 = how to end the app: TERM or KILL
  local H="$WORK/home-$1"
  mkdir -p "$H"
  printf '{"port":0,"sitesPort":0,"updateCheck":false}\n' > "$H/desktop.json"
  local win=0
  [ "$1" = TERM ] && win=1
  PASABOT_HOME="$H" PASABOT_DESKTOP_NO_BROWSER=1 PASABOT_DESKTOP_WINDOW="$win" PASABOT_VAULT_PASSPHRASE="smoke-test-only-passphrase" \
    "$BIN" >"$WORK/app-$1.log" 2>&1 &
  APP_PID=$!
  local lock="$H/run/desktop.lock" url=""
  for _ in $(seq 1 600); do
    if [ -f "$lock" ]; then url="$(field "$lock" url)"; [ -n "$url" ] && break; fi
    sleep 0.1
  done
  [ -n "$url" ] || { echo "smoke: FAIL no server URL after 60 s"; cat "$WORK/app-$1.log"; tail -20 "$H/logs/desktop-server.log" 2>/dev/null; exit 1; }
  local launcher server
  launcher="$(field "$lock" pid)"; server="$(field "$lock" serverPid)"
  echo "smoke[$1]: app pid $APP_PID, launcher pid $launcher, server pid $server, $url"
  curl -fsS "$url/api/v1/health" | grep -q '"ok":true' && echo "smoke[$1]: PASS health $(curl -fsS "$url/api/v1/health")"
  curl -fsS "$url/" | grep -qi '<html' && echo "smoke[$1]: PASS web UI served at /"
  if [ "$1" = TERM ]; then window_check "$url"; second_launch "$H"; fi
  kill -"$1" "$APP_PID"
  wait_gone "$APP_PID" || { echo "smoke: FAIL app still running"; exit 1; }
  wait_gone "$launcher" || { echo "smoke: FAIL launcher left running (pid $launcher)"; exit 1; }
  wait_gone "$server" || { echo "smoke: FAIL orphan server (pid $server)"; exit 1; }
  [ ! -f "$lock" ] || [ "$1" = KILL ] || { echo "smoke: FAIL lock left behind"; exit 1; }
  echo "smoke[$1]: PASS app, launcher and server all gone after SIG$1"
  APP_PID=""
}

window_check() { # $1 = the server URL: the window came up and loads the app from it
  local u="${1%/}"
  for _ in $(seq 1 50); do grep -q "main window loads $u/" "$WORK/app-TERM.log" && break; sleep 0.1; done
  grep -q "main window shown (launch)" "$WORK/app-TERM.log" \
    || { echo "smoke: FAIL no app window at launch"; cat "$WORK/app-TERM.log"; exit 1; }
  grep -q "main window loads $u/" "$WORK/app-TERM.log" \
    || { echo "smoke: FAIL the window did not load $u"; cat "$WORK/app-TERM.log"; exit 1; }
  echo "smoke[TERM]: PASS app window shown at launch and loading $u/"
  # the bare address has no setup code: the claim page in the real web view asks the window (pasabotSetup) for one
  for _ in $(seq 1 150); do grep -q "the claim page asked for a fresh setup link" "$WORK/app-TERM.log" && break; sleep 0.1; done
  grep -q "the claim page asked for a fresh setup link" "$WORK/app-TERM.log" \
    || { echo "smoke: FAIL the claim page did not ask the window for a setup link"; cat "$WORK/app-TERM.log"; exit 1; }
  if grep -q "refused a page message" "$WORK/app-TERM.log"; then echo "smoke: FAIL the window refused its own claim page"; exit 1; fi
  echo "smoke[TERM]: PASS the claim page asked the window for a setup link (no code field in the app)"
}

second_launch() { # $1 = the running copy's PASABOT_HOME
  local H="$1" second code
  PASABOT_HOME="$H" PASABOT_DESKTOP_NO_BROWSER=1 PASABOT_VAULT_PASSPHRASE="smoke-test-only-passphrase" \
    "$BIN" >"$WORK/app-second.log" 2>&1 &
  second=$!
  wait_gone "$second" || { echo "smoke: FAIL the second launch is still running"; kill -9 "$second"; exit 1; }
  code=0; wait "$second" || code=$?
  [ "$code" = 0 ] || { echo "smoke: FAIL the second launch exited $code"; cat "$WORK/app-second.log"; exit 1; }
  grep -q "asked the running copy to show its window" "$WORK/app-second.log" \
    || { echo "smoke: FAIL the second launch did not hand off"; cat "$WORK/app-second.log"; exit 1; }
  for _ in $(seq 1 50); do grep -q "show window (second launch)" "$WORK/app-TERM.log" && break; sleep 0.1; done
  grep -q "show window (second launch)" "$WORK/app-TERM.log" \
    || { echo "smoke: FAIL the running copy did not show its window"; cat "$WORK/app-TERM.log"; exit 1; }
  alive "$APP_PID" || { echo "smoke: FAIL the running copy quit on a second launch"; exit 1; }
  [ "$(field "$H/run/desktop.lock" pid)" = "$launcher" ] || { echo "smoke: FAIL the lock changed hands"; exit 1; }
  echo "smoke[TERM]: PASS second launch handed off (running copy showed its window, second copy quit, nothing new started)"
  # no owner yet: the window that came back asked for a fresh setup link, which came over the server's own channel
  for _ in $(seq 1 50); do grep -q "fresh setup link received" "$WORK/app-TERM.log" && break; sleep 0.1; done
  grep -q "asking for a fresh setup link (second launch)" "$WORK/app-TERM.log" \
    && grep -q "fresh setup link received" "$WORK/app-TERM.log" \
    || { echo "smoke: FAIL the window that came back got no fresh setup link"; cat "$WORK/app-TERM.log"; exit 1; }
  if grep -q "setup?token=" "$WORK/app-TERM.log"; then echo "smoke: FAIL a setup token reached the app log"; exit 1; fi
  echo "smoke[TERM]: PASS the window that came back got a fresh setup link (and no token in the app log)"
  grep "menu-bar item isVisible=" "$WORK/app-TERM.log" | tail -1 | sed 's/^.*PasaBot: /smoke[TERM]: item probe: /' || true
}

"$BIN" --selftest | sed 's/^/smoke: /'
run_once TERM
run_once KILL
echo "smoke: PASS"
