# PasaBot computer-use layer (W16). Owns the Xvfb image layer: the helpers the Linux ComputerDriver needs.
#
#   stage `computer`  - node 22 + Xvfb + xdotool + ImageMagick (`import`), non-root user. The main image (W20,
#                       deploy/Dockerfile) builds FROM this stage, or copies its apt line, to ship computer use.
#   stage `proof`     - the repo + Python Tk (test app) on top; runs the live Vitest proof:
#                       docker build -f deploy/computer/Dockerfile --target proof -t pasabot-computer-proof .
#                       docker run --rm pasabot-computer-proof
#
# Each agent gets its own Xvfb display, started by the server on the agent's first approved action; nothing here
# starts an X server at boot, and there is no VNC port: the owner watches in the web app's Computer screen.
FROM node:22-bookworm-slim AS computer
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xdotool imagemagick fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# Xvfb needs the socket dir; it is created root-owned with the sticky bit as on a desktop
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
USER node
WORKDIR /home/node

FROM computer AS proof
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-tk \
 && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /home/node/pasabot
COPY --chown=node:node . .
RUN npx --yes pnpm@12.18.0 install --frozen-lockfile
ENV PASABOT_LIVE_XVFB=1
CMD ["npx", "vitest", "run", "modules/computer"]
