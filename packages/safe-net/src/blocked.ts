/** The address blocklist shared by safeFetch and safeConnect (kept apart so tcp.ts does not import index.ts). */
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (incl. Tailscale)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
// IPv6
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can reach IPv4 private space
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** True when an address must not be reached without an explicit allowlist entry. */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / -compatible forms (::ffff:127.0.0.1, ::ffff:7f00:1, ::127.0.0.1) judge the embedded IPv4
    const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = Number.parseInt(hexMapped[1]!, 16);
      const lo = Number.parseInt(hexMapped[2]!, 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
