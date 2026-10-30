// Webhook target guard (A16): which addresses FanFunnel's server may POST to,
// resolved ONCE and then pinned for the request, so there is no window for a
// DNS rebind between the check and the connection. Server-only by use.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Loopback, private, link-local (incl. the 169.254.169.254 cloud metadata
// address), CGNAT, benchmarking, documentation, multicast and reserved ranges.
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["64:ff9b::", 96], // NAT64 (embeds an IPv4 target)
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 (embeds an IPv4 target)
  ["fc00::", 7], // unique local, incl. fd00:ec2::254 (cloud metadata)
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** True for any address a webhook must never reach. Unknown input is blocked. */
export function isPrivateIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(addr);
  if (family === 4) return BLOCKED.check(addr, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1): judge the IPv4 inside.
    const dotted = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return BLOCKED.check(addr, "ipv6");
  }
  return true;
}

export type LookupFn = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;

export type WebhookTarget =
  | { ok: true; url: URL; ip: string; family: 4 | 6 }
  | { ok: false; reason: "invalid_url" | "blocked_url" };

/**
 * Parse and vet a webhook URL: http(s) only, no credentials, no local names,
 * and every address the name resolves to must be public. Returns the address
 * to connect to (pinned: the request never resolves the name again).
 */
export async function resolveWebhookTarget(raw: string, lookup: LookupFn = dnsLookup as LookupFn): Promise<WebhookTarget> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid_url" };
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "blocked_url" };
  }
  const literal = isIP(host);
  if (literal) {
    return isPrivateIp(host) ? { ok: false, reason: "blocked_url" } : { ok: true, url, ip: host, family: literal as 4 | 6 };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "blocked_url" }; // unresolvable → unsafe
  }
  // Reject if ANY record is private: a mixed answer could otherwise be used.
  if (!addrs.length || addrs.some(({ address }) => isPrivateIp(address))) return { ok: false, reason: "blocked_url" };
  const pick = addrs[0];
  return { ok: true, url, ip: pick.address, family: pick.family === 6 ? 6 : 4 };
}
