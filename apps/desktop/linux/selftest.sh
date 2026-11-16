#!/usr/bin/env bash
# "Check this computer" for a Linux desktop (W26 proof kit). Run it from the unpacked or installed PasaBot folder:
#   ./selftest.sh
# It builds nothing and never touches your own PasaBot data: the installed launcher and server run on a free port with
# a temporary data folder, each piece is checked, everything is stopped and the folder deleted. A PASS/FAIL table is
# printed and written to selftest-report.txt next to this script (no codes, no keys).
set -u
umask 077
D="$(cd "$(dirname "$0")" && pwd)"
NODE="$D/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
MAIN="$D/pasabot/apps/desktop/dist/main.js"
TMPH="$(mktemp -d "${TMPDIR:-/tmp}/pasabot-selftest-XXXXXX")"
REPORT="$D/selftest-report.txt"
FAIL=0; PASS=0; SKIP=0; OUT=""
res() { # name result detail
  local d="${3:-}"; d="$(printf '%s' "$d" | sed -E 's/token=[^&# "]+/token=<hidden>/g')"
  OUT="$OUT$(printf '%-5s %s%s' "$2" "$1" "${d:+ — $d}")"$'\n'
  printf '%-5s %s\n' "$2" "$1"; [ -n "$d" ] && printf '      %s\n' "$d"
  case "$2" in PASS) PASS=$((PASS+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; *) SKIP=$((SKIP+1)) ;; esac
}
# a failed check never leaves the test launcher or its server running
cleanup() {
  [ -n "${LPID:-}" ] && kill "$LPID" 2>/dev/null
  [ -n "${SPID:-}" ] && kill "$SPID" 2>/dev/null
  rm -rf "$TMPH"
}
trap cleanup EXIT

echo; echo "PasaBot: checking this computer (a test folder, never your own data)"; echo
[ -f "$MAIN" ] && [ -x "$NODE" ] && res "PasaBot is installed" PASS "node $("$NODE" --version)" || { res "PasaBot is installed" FAIL "missing $MAIN or node"; exit 1; }

# any free ports: never the ones your own PasaBot uses
printf '{"port":0,"sitesPort":0}' >"$TMPH/desktop.json"
# the launcher with a pipe for its commands, as a shell runs it: its stdin is a plain pipe, fed by cat from a FIFO
# whose one writer is this script (fd 3, opened after the fork so nothing else holds it). Closing fd 3 below is then
# the end of input the launcher stops on. (Not the FIFO itself as stdin: opened read-write and shared, the launcher
# would hold a writer of its own input and never see its end; and Node does not see a FIFO's end on macOS.)
mkfifo "$TMPH/in"
cat "$TMPH/in" | PASABOT_HOME="$TMPH" "$NODE" "$MAIN" --payload "$D/payload.json" --home "$TMPH" --no-browser >"$TMPH/events" 2>"$TMPH/err" &
LPID=$!
exec 3>"$TMPH/in"
URL=""
for _ in $(seq 1 120); do
  URL="$(grep -o '"server":"running","url":"http://127.0.0.1:[0-9]*"' "$TMPH/events" 2>/dev/null | head -1 | sed -E 's/.*"url":"(.*)"/\1/')"
  [ -n "$URL" ] && break; sleep 1
done
if [ -n "$URL" ]; then res "The app starts (launcher + server)" PASS "$URL (127.0.0.1 only)"; else res "The app starts (launcher + server)" FAIL "$(tail -3 "$TMPH/err")"; fi

if [ -n "$URL" ]; then
  curl -fsS "$URL/api/v1/health" | grep -q '"ok":true' && res "Health answers" PASS || res "Health answers" FAIL
  curl -fsS "$URL/" | grep -qi '<html' && res "First-run page loads" PASS || res "First-run page loads" FAIL
  echo '{"cmd":"setup-link"}' >&3
  LINK=""
  for _ in $(seq 1 20); do
    LINK="$(grep -o '"event":"setup-link","url":"[^"]*"' "$TMPH/events" | tail -1 | sed -E 's/.*"url":"(.*)"/\1/')"
    [ -n "$LINK" ] && break; sleep 1
  done
  CODE="$(printf '%s' "$LINK" | sed -nE 's/.*token=([A-Za-z0-9_-]+).*/\1/p')"
  if [ -n "$CODE" ]; then res "Setup link is made (private channel)" PASS; else res "Setup link is made (private channel)" FAIL; fi
  SESSION=""
  if [ -n "$CODE" ]; then
    PW="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    SESSION="$(curl -fsS -X POST "$URL/api/v1/setup" -H 'content-type: application/json' \
      -d "{\"token\":\"$CODE\",\"displayName\":\"Selftest\",\"password\":\"$PW\"}" | sed -nE 's/.*"token":"([^"]+)".*/\1/p')"
    [ -n "$SESSION" ] && res "Claim works" PASS || res "Claim works" FAIL
  fi
  MODE="$(stat -c '%a' "$TMPH" 2>/dev/null || stat -f '%Lp' "$TMPH")"
  [ "$MODE" = "700" ] && res "Data folder is yours only" PASS "mode 700" || res "Data folder is yours only" FAIL "mode $MODE"
  if [ -n "$SESSION" ]; then
    N="$(curl -fsS "$URL/api/v1/system/notices" -H "authorization: Bearer $SESSION")"
    res "Owner-only notices answer" PASS "$(printf '%s' "$N" | grep -o '"id":"[^"]*"' | sed -E 's/"id":"(.*)"/\1/' | tr '\n' ' ')"
    # the desktop keyring is for your own data folder only (~/.pasabot): a server on any other folder, such as this
    # test one, keeps its key in a 0600 vault.key inside that folder (vault/index.ts hostMasterKeySource)
    M="$(stat -c '%a' "$TMPH/vault.key" 2>/dev/null)"
    if printf '%s' "$N" | grep -q 'vault-unavailable'; then res "Vault key" FAIL "the vault did not open"
    elif [ "$M" = "600" ]; then res "Vault key" PASS "test folder: its own 0600 vault.key (your own data folder uses the desktop keyring)"
    else res "Vault key" FAIL "vault.key in the test folder: mode ${M:-missing}"; fi
    if printf '%s' "$N" | grep -q 'linux-sandbox'; then res "Helper sandbox (bubblewrap)" FAIL "see the card on the home screen"; else res "Helper sandbox (bubblewrap)" PASS; fi
  fi
fi
C="$("$NODE" --input-type=module -e "import('file://'+process.argv[1]).then(m=>console.log(JSON.stringify(m.appWindowCommand('linux','http://127.0.0.1:1/#/setup?token=a&b=1',{home:'/h',env:process.env}))))" "$D/pasabot/apps/desktop/dist/app-window.js")"
if [ "$C" = "null" ]; then res "App window browser" SKIP "no Chromium, Chrome, Brave or Edge: PasaBot opens the default browser"
else printf '%s' "$C" | grep -q '"--app=http://127.0.0.1:1/#/setup?token=a&b=1"' && res "App window browser" PASS "$(printf '%s' "$C" | sed -E 's/^\["([^"]+)".*/\1/')" || res "App window browser" FAIL; fi
if [ -n "$URL" ]; then
  timeout 60 env PASABOT_HOME="$TMPH" "$NODE" "$MAIN" --payload "$D/payload.json" --home "$TMPH" --no-browser --no-stdin >"$TMPH/second" 2>&1 3>&-
  grep -q '"already-running"' "$TMPH/second" && res "Second launch hands over (single instance)" PASS || res "Second launch hands over (single instance)" FAIL
  SPID="$(sed -nE 's/.*"serverPid":([0-9]+).*/\1/p' "$TMPH/run/desktop.lock" 2>/dev/null)"
  exec 3>&-
  for _ in $(seq 1 30); do kill -0 "$LPID" 2>/dev/null || break; sleep 1; done
  if kill -0 "$LPID" 2>/dev/null || { [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null; }; then res "Clean stop (nothing left running)" FAIL
  else res "Clean stop (nothing left running)" PASS; LPID=""; SPID=""; fi
fi
SUM="$([ $FAIL -eq 0 ] && echo "ALL GOOD: $PASS passed, $SKIP skipped" || echo "$FAIL FAILED, $PASS passed, $SKIP skipped")"
echo; echo "$SUM"
{ echo "PasaBot check of this computer"; uname -sr; date; echo; printf '%s' "$OUT"; echo; echo "$SUM"; } >"$REPORT" 2>/dev/null && echo "Report: $REPORT"
[ $FAIL -eq 0 ]
