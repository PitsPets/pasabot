# Reaching PasaBot from your other devices

PasaBot listens on `127.0.0.1` by default. Never change `PASABOT_HOST` to `0.0.0.0` to "make it work from the phone":
that sends your password and sessions over the network in plain HTTP, and `pasabot doctor` fails it. Put a TLS front in
front of the loopback port instead. PasaBot serves two origins and both must stay separate:

| Port (default) | Origin | What                                                                 |
| -------------- | ------ | -------------------------------------------------------------------- |
| 7777           | app    | the web app, API and WebSocket                                       |
| 7778           | sites  | agent-made HTML and static sites (untrusted: never the app's origin) |

## Option A: Tailscale (recommended)

Your devices already on the tailnet get HTTPS with a real certificate, and nothing is open to the internet.

```
tailscale serve --bg --https=443 http://127.0.0.1:7777     # app:   https://<machine>.<tailnet>.ts.net
tailscale serve --bg --https=8443 http://127.0.0.1:7778    # sites: https://<machine>.<tailnet>.ts.net:8443
```

Then in `$PASABOT_HOME/pasabot.env`:

```
PASABOT_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
PASABOT_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
```

`pasabot restart`, then `pasabot doctor` should show no `[FAIL]` lines. The sites origin differs from the app by port, so
the browser keeps them apart. Use `tailscale funnel` only if you really want the app on the public internet.

## Option B: your own tunnel or reverse proxy

Any TLS front works (Cloudflare Tunnel, Caddy, nginx) as long as it:

1. terminates HTTPS and forwards to `http://127.0.0.1:7777`, passing the `Host` header through and allowing
   WebSocket upgrades on `/ws`;
2. serves the sites port on a **different hostname** (for example `sites.example.com` → `http://127.0.0.1:7778`),
   never under a path of the app hostname;
3. is listed in `PASABOT_ALLOWED_HOSTS` and `PASABOT_PUBLIC_URL` (app hostname).

Keep `PASABOT_HOST=127.0.0.1`; the proxy runs on the same machine or reaches it over a private network.

Note: the sites links the app shows still use the local sites address until a public sites URL setting exists
(W18); the tunnel route above is what makes them reachable once it does.

## Docker

Compose publishes on `127.0.0.1` already; point Tailscale serve or the tunnel at the same ports on the host and set
`PASABOT_PUBLIC_URL` and `PASABOT_ALLOWED_HOSTS` in the compose environment (or a `.env` next to `compose.yaml`).
