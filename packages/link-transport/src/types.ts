/** The one interface every machine-link transport implements (ARCHITECTURE 11.1). */
import type { Duplex } from 'node:stream';

/** Ordered, reliable bytes between two linked servers. */
export type LinkStream = Duplex;
export interface LinkPeer {
  /** the other side's long-term Ed25519 public key (base64url, 32 bytes), proven by the transport */
  publicKey: string;
  /**
   * Inbound only, for transports with a tunnel identity of their own (tailcat): the key the tunnel itself saw the peer
   * connect with (tailcat's `$TAILCAT_PEER_KEY`, `nodekey:<hex>`). Reported by the tunnel, not claimed by the peer.
   */
  transportKey?: string;
  /** Inbound only: the connection came in through the one-time linking window (`openLinkWindow`), not the pinned one. */
  viaLinkWindow?: boolean;
}
export type LinkTransportId = 'tailcat' | 'tcp-tls' | 'memory';

/** What Settings → Machines shows about the transport; never an address or a key. */
export interface LinkTransportStatus {
  /** the tunnel process that accepts linked machines is up (tailcat runs it only while a machine is linked) */
  serving: boolean;
  /** it died and is being started again (backoff) */
  restarting?: boolean;
  /** how many machines the tunnel admits */
  linked?: number;
  /** how often it had to be restarted after it died (not counting allow-list changes) */
  restarts: number;
  /** a linking window is open (a link code can be used right now) */
  linkWindow: boolean;
  /** the CLI version, when the transport drives one */
  version?: string;
}

export interface LinkTransport {
  readonly id: LinkTransportId;
  /**
   * Our long-term public key (Ed25519) and the address peers dial. The address is a bearer secret: callers store it
   * in the vault and never log or show it. It is final once `listen()` resolved (empty before, for listening kinds).
   * `transportKey`: our tunnel-level key that linked machines must admit (tailcat: our client node key), if any.
   */
  identity(): Promise<{ publicKey: string; address: string; transportKey?: string }>;
  listen(onPeer: (s: LinkStream, peer: LinkPeer) => void): Promise<{ close(): Promise<void> }>;
  dial(address: string): Promise<{ stream: LinkStream; peer: LinkPeer }>;
  available(): Promise<{ ok: true } | { ok: false; installHelp: string }>;
  /**
   * Tunnel-level admission (tailcat `serve --allow`): the `transportKey`s of the linked machines, replacing the list.
   * Takes effect at once (a removed key is refused from the next byte on). Before `listen()` it only sets the list.
   * Defence in depth: the link handshake (pinned keys, code proof) still authenticates every connection.
   */
  setAllowed?(transportKeys: readonly string[]): Promise<void>;
  /**
   * Opens (or extends to `until`, epoch ms) the one-time linking window and returns the address for a link code.
   * tailcat: a separate, short-lived address that admits any tunnel key (the link code proof gates it) until `until`
   * or `closeLinkWindow()`. Transports without a window leave this out; callers then use `identity().address`.
   */
  openLinkWindow?(until: number): Promise<string>;
  closeLinkWindow?(): Promise<void>;
  status?(): Promise<LinkTransportStatus>;
  /** the path to a linked machine when that is cheap to learn (tailcat `ping`); null = no answer */
  probe?(address: string): Promise<{ path: 'direct' | 'relay' | 'unknown'; rttMs?: number } | null>;
  /** stops every helper process the transport started (listener, dialer, window) */
  close?(): Promise<void>;
}

/**
 * The address grammar every transport and the link module accept: 1–512 chars, a letter or digit first (never `-`, so
 * a CLI can never read it as an option), then letters, digits and `._~:/@%+=[]-` only (no spaces, quotes or shell
 * syntax). One linear character class, no backtracking.
 */
export const isLinkAddress = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._~:/@%+=[\]-]*$/.test(s);

export type LinkTransportErrorCode = 'unreachable' | 'unavailable' | 'peer_key' | 'bad_address' | 'closed';
/** Transport failures. Messages never carry the address (a bearer secret). */
export class LinkTransportError extends Error {
  constructor(
    readonly code: LinkTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LinkTransportError';
  }
}
