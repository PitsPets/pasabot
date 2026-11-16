#!/usr/bin/env bash
# W16 Linux proof in one command: builds the `proof` stage of deploy/computer/Dockerfile (node 22 + Xvfb + xdotool +
# ImageMagick + Python Tk) from the repo root and runs modules/computer's tests in it with PASABOT_LIVE_XVFB=1, which
# turns on src/xvfb-live.test.ts (a real Xvfb per agent, the Tk test app's button clicked through /mcp after tier-3
# approvals, a client without the display's cookie refused, no TCP or abstract listener).
#
#   deploy/computer/proof.sh            # needs Docker with BuildKit (Docker Desktop, or Linux docker >= 23)
#
# Exit code 0 = every test passed inside the container.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v docker >/dev/null || { echo "proof: docker is not installed" >&2; exit 2; }
cd "$ROOT"
DOCKER_BUILDKIT=1 docker build -f deploy/computer/Dockerfile --target proof -t pasabot-computer-proof .
docker run --rm pasabot-computer-proof
