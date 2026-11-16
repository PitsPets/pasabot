# syntax=docker/dockerfile:1.7
# PasaBot server image. Build from the repo root:
#   docker build -f deploy/docker/Dockerfile -t pasabot .
# Runs as the non-root `pasabot` user (uid 10001) with the default runner `container`; see deploy/docker/compose.yaml
# for the seccomp + AppArmor confinement, read-only root and loopback-only port publishing.

FROM node:22-bookworm-slim AS build
WORKDIR /src
# toolchain only for native modules that have no prebuilt binary (better-sqlite3 on unusual arches)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.18.0
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm -r run build \
  && printf '{"name":"pasabot","version":"%s"}\n' "$(node -p 'require("./apps/server/package.json").version')" > pasabot-release.json

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 10001 pasabot \
  && useradd --uid 10001 --gid pasabot --no-create-home --home-dir /data --shell /usr/sbin/nologin pasabot \
  && mkdir -p /data \
  && chown pasabot:pasabot /data \
  && chmod 0700 /data
# the install is owned by root and read-only for the server user
COPY --from=build --chown=root:root /src /opt/pasabot/current
RUN chmod 0755 /opt/pasabot/current/apps/cli/dist/main.js \
  && ln -s /opt/pasabot/current/apps/cli/dist/main.js /usr/local/bin/pasabot
ENV NODE_ENV=production \
  PASABOT_HOME=/data \
  PASABOT_ROOT=/opt/pasabot/current \
  PASABOT_HOST=0.0.0.0 \
  PASABOT_PORT=7777 \
  PASABOT_SITES_PORT=7778 \
  PASABOT_RUNNER=container \
  PASABOT_IN_CONTAINER=1
WORKDIR /opt/pasabot/current
USER 10001:10001
VOLUME ["/data"]
EXPOSE 7777 7778
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7777/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/opt/pasabot/current/apps/server/dist/host/main.js"]
