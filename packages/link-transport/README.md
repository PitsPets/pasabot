# @pasabot/link-transport

The one interface every machine-link transport implements (ARCHITECTURE 11.1), and the transports.

```ts
interface LinkTransport {
  id: 'tailcat' | 'tcp-tls' | 'memory';
  identity(): Promise<{ publicKey: string; address: string }>; // address: a bearer secret, final after listen()
  listen(onPeer: (s: LinkStream, peer: { publicKey: string }) => void): Promise<{ close(): Promise<void> }>;
  dial(address: string): Promise<{ stream: LinkStream; peer: { publicKey: string } }>;
  available(): Promise<{ ok: true } | { ok: false; installHelp: string }>;
}
```

Every transport reports the other side's long-term Ed25519 key, proven by the transport; the caller compares it with
the key it pinned. Errors never carry the address.

- `createMemoryNetwork().transport(keys)`: in-process, for tests (several servers in one process).
- `createTcpTlsTransport({ keys, host, port, advertiseHost })`: TLS 1.3 with a self-signed certificate of the link key
  itself (hand-built DER, no CA); the peer's certificate key is what `peer.publicKey` reports.
- `createTailcatTransport({ keys, stateDir, bin })`: the real `tailcat` v0.7 CLI as child processes (never bundled;
  every argv in `TAILCAT_ARGV`, no shell, an explicit `--key=<path>` always, never an empty `--allow`). One
  `serve --allow=<linked tunnel keys|none> exec -- node -e <bridge>` per listener (the bridge hands each tunnel
  connection to a loopback-only TCP listener with a per-run token and `$TAILCAT_PEER_KEY`), one `socks` child for all
  dials (SOCKS5 CONNECT; the address never enters an argv), a short-lived `--key=new serve` as the linking window
  (`openLinkWindow`), `setAllowed` restarts `serve` with the new list (and cuts open connections of a removed key); no `probe`, because `tailcat ping` would put the secret address in an argv. A missing
  binary gives `TAILCAT_INSTALL_HELP`; `v0.7.x` is accepted, other versions warn. `provePeer` proves both long-term
  keys over the byte stream. Design notes and the measurements behind them: ARCHITECTURE 11.1.

`runLinkTransportContract(name, make)` (`@pasabot/link-transport/contract`) is the suite every transport passes;
`src/transports.test.ts` runs it for all three (tailcat through `src/__fixtures__/tailcat-stub.mjs`, a stub of the real
v0.7.0 CLI grammar) plus the tailcat specifics. `PASABOT_LIVE=tailcat npx vitest run
packages/link-transport/src/tailcat.live.test.ts` runs the transport against the real binary (skipped by default).
