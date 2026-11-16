# deploy/

How PasaBot is packaged and run as a service (workstream W20). The ops verbs live in `apps/cli/src/commands/ops/`.

| Path                                 | What                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `docker/Dockerfile`                  | Server image: non-root `pasabot` (uid 10001), runner `container`, data in `/data`, built-in healthcheck |
| `docker/compose.yaml`                | Loopback-only ports, read-only root, all capabilities dropped, seccomp + AppArmor, no-new-privileges    |
| `docker/seccomp.json`                | Our seccomp profile: refuses mounts, namespaces, module loading, ptrace, keyrings, io_uring, BPF        |
| `docker/apparmor/pasabot`            | Our AppArmor profile (load it on the host, then `PASABOT_APPARMOR=pasabot`)                             |
| `systemd/pasabot.service`            | systemd user unit template (desktop Linux; runner `host` with bubblewrap)                               |
| `systemd/pasabot-system.service`     | systemd system unit template (Linux server; `pasabot` user, runner `user`, hardened)                    |
| `launchd/local.pasabot.server.plist` | launchd user agent template (macOS; runner `host` with Seatbelt)                                        |
| `release-keys/`                      | Pinned Ed25519 release keys that `pasabot update` trusts                                                |
| `release/sign.mjs`                   | Maintainer tool: make a release key, sign a tarball                                                     |
| `REMOTE-ACCESS.md`                   | Reach PasaBot from your phone: Tailscale serve or your own tunnel, plus the sites hostname              |

## Ops verbs

```
pasabot service install [--system] [--dry-run]   # launchd on macOS, systemd --user on Linux, --system for a server
pasabot service status | uninstall
pasabot start | stop | restart                   # through the service; without one, a background process + pid file
pasabot logs [-n 200] [-f]                       # journald, or $PASABOT_HOME/logs/server.log
pasabot update <pasabot-x.y.z.tar.gz> [--check]    # refuses unless <tarball>.sig verifies against release-keys/
pasabot uninstall [--remove-releases]            # removes the service; never deletes $PASABOT_HOME
pasabot doctor [--json]                          # exposure and setup checks; exit 1 on a failure
```

Settings for the service live in `$PASABOT_HOME/pasabot.env` (0600, `KEY=VALUE`, no secrets: those are in the vault).
`pasabot service install` creates it with the platform's default runner (macOS `host`; Linux `host` only with a desktop
session, else `user`; `--system` `user`; an explicit `PASABOT_RUNNER` wins) and `PASABOT_HOST=127.0.0.1`.

Every unit runs `<prefix>/current`, never the folder you installed from. With no release installed yet,
`service install` makes `current` a link to this install; `pasabot update` later switches it to the new release, so a
restart runs the new code. `--system` puts releases in `/opt/pasabot` and state in `/var/lib/pasabot`, and refuses a node,
install or `PASABOT_HOME` under `/home`, `/root` or `/run/user` (the unit's `ProtectHome=yes` hides them).

## Docker

```
cd deploy/docker
docker compose up -d --build
docker compose ps                  # "healthy" within the 30 s start period
docker compose exec pasabot pasabot doctor
docker compose exec pasabot pasabot setup-link
```

The container listens on `0.0.0.0` inside, but compose publishes it on `127.0.0.1` only (`PASABOT_PUBLISH_HOST`);
`pasabot doctor` in the container judges that published address. Use Tailscale serve or a tunnel for remote access.

## Updates

`pasabot update` is owner-triggered (never silent). It checks the Ed25519 signature of the whole tarball against the
keys pinned in the **installed** copy before unpacking, refuses downgrades (unless `--allow-downgrade`), refuses links,
absolute paths and `..` inside the tarball, unpacks to `<prefix>/releases/<version>` and switches
`<prefix>/current` atomically, then restarts a running service. A unit that does not run `<prefix>/current` is
re-rendered first; `update` fails rather than report a release the server is not running. Prefix: `PASABOT_PREFIX`,
default `~/.local/share/pasabot` (`/opt/pasabot` as root on Linux).

## Not proven on this machine

- `docker compose up` → healthy in < 60 s, the seccomp and AppArmor profiles under a real kernel: needs a Linux Docker
  host.
- The systemd units under a real systemd (tests drive a fake `systemctl`); launchd units are linted with `plutil`.
