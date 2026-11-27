import { isIP } from "node:net";

/**
 * Where a fetch is allowed to go. Retrieval runs on the installation's own
 * network, so a retailer page is not the only thing a URL could reach: the
 * database, the SearXNG container, a cloud metadata service, or anything else
 * on the operator's private network all answer plain HTTP. Every destination is
 * therefore judged before a connection is opened, and every redirect hop is
 * judged again, because a public URL can redirect to a private one.
 *
 * The judgement is made from a URL's host. Where a host is a name, the caller
 * resolves it first and passes the addresses here as well: a name that resolves
 * into a private range is exactly the trick a single string check would miss.
 */

/**
 * The address families a fetch may use. IPv4 and IPv6 only: a host that cannot
 * be parsed as either is a name, and a name is judged after resolution.
 */
export type IpVersion = 4 | 6;

/** What a caller learns when a destination is refused, and nothing more. */
export interface DestinationRefusal {
  /** The address or host that was refused, so an operator can see what was tried. */
  target: string;
  reason: "scheme" | "credentials" | "port" | "host" | "address";
}

/**
 * The ports a public page may be served on, so a URL cannot pick a service's
 * own: a URL ending in `:6379` is an attempt to speak to something that is not
 * a web server, and a URL ending in `:22` is an attempt to speak to an
 * administrator's session.
 */
export const DEFAULT_PERMITTED_PORTS: readonly number[] = [80, 443];

/** Private and reserved IPv4 blocks, in the order they are most often abused. */
const BLOCKED_IPV4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // "this network": 0.0.0.0 and friends.
  [0x0a000000, 8], // Private.
  [0x64400000, 10], // Carrier-grade NAT, which reaches other subscribers.
  [0x7f000000, 8], // Loopback.
  [0xa9fe0000, 16], // Link-local, including the cloud metadata address.
  [0xac100000, 12], // Private.
  [0xc0000000, 24], // IETF protocol assignments, including benchmarking.
  [0xc0a80000, 16], // Private.
  [0xc6120000, 15], // Benchmarking.
  [0xc0586300, 24], // 6to4 relay anycast.
  [0xe0000000, 4], // Multicast.
  [0xf0000000, 4], // Reserved, including broadcast.
];

/** Hostnames that never leave the machine, whatever they resolve to. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];

/** The single-label names that mean "this machine" in every convention we meet. */
const BLOCKED_HOSTS: ReadonlySet<string> = new Set(["localhost", "localhost.localdomain"]);

function parseIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    // Leading zeros are refused rather than interpreted: `010.0.0.1` is octal
    // to some resolvers and decimal to others, and the two disagree about
    // whether it is private.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv6 address as eight 16-bit groups, with an embedded IPv4 folded in. */
function parseIpv6(address: string): number[] | undefined {
  // A zone id names an interface on this machine, which is never public.
  const withoutZone = address.split("%")[0] ?? address;
  if (withoutZone.length === 0) return undefined;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (text: string): number[] | undefined => {
    if (text.length === 0) return [];
    const groups: number[] = [];
    for (const piece of text.split(":")) {
      if (piece.length === 0) return undefined;
      if (piece.includes(".")) {
        const embedded = parseIpv4(piece);
        if (embedded === undefined) return undefined;
        groups.push(Math.floor(embedded / 65536), embedded % 65536);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIpv4(value: number): boolean {
  return BLOCKED_IPV4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
}

/**
 * Whether an IPv6 address is only reachable from inside a network. IPv6 has
 * many ways to say the same thing — a mapped IPv4 address, a NAT64 address that
 * embeds one, a 6to4 address that embeds one — so each is unwrapped and judged
 * as the IPv4 address it really reaches.
 */
function isBlockedIpv6(groups: number[]): boolean {
  const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0, seventh = 0, eighth = 0] =
    groups;
  const embeddedIpv4 = () => ((third & 0xffff) * 65536 + fourth) >>> 0;

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated but still
  // routed by some stacks).
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0) {
    if (sixth === 0xffff || sixth === 0) {
      const value = (seventh * 65536 + eighth) >>> 0;
      // :: and ::1 are the unspecified and loopback addresses.
      if (sixth === 0 && value <= 1) return true;
      return isBlockedIpv4(value);
    }
  }
  // 64:ff9b::/96 NAT64, and 64:ff9b:1::/48 local-use NAT64.
  if (first === 0x0064 && second === 0xff9b) {
    if (third === 0 && fourth === 0 && fifth === 0 && sixth === 0) {
      return isBlockedIpv4((seventh * 65536 + eighth) >>> 0);
    }
    if (third === 1) return true;
  }
  // 2002::/16 6to4 embeds the IPv4 address it tunnels to.
  if (first === 0x2002) return isBlockedIpv4(((second * 65536 + third) >>> 0));
  // 2001::/32 Teredo, 2001:db8::/32 documentation.
  if (first === 0x2001 && (second === 0x0000 || second === 0x0db8)) return true;
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

/** Whether a literal address is only reachable from inside a network. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = parseIpv4(address);
    return value === undefined ? true : isBlockedIpv4(value);
  }
  if (version === 6) {
    const groups = parseIpv6(address);
    return groups === undefined ? true : isBlockedIpv6(groups);
  }
  // Not an address at all, so it cannot be vouched for. A caller that meant a
  // hostname resolves it and asks again.
  return true;
}

/**
 * Judges a URL's scheme, credentials, port, and host. Resolution is separate so
 * that a name which is itself blocked is refused without a lookup, and a name
 * that resolves to a blocked address is refused after one.
 */
export function judgeUrl(
  url: URL,
  permittedPorts: readonly number[] = DEFAULT_PERMITTED_PORTS,
): DestinationRefusal | undefined {
  // Only http and https: `file:` would read the installation's own disk,
  // `ftp:`/`gopher:` reach services no page needs, and every other scheme is
  // an interpreter we do not want to feed.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { target: url.protocol.replace(/:$/, ""), reason: "scheme" };
  }
  // Credentials in a URL are the only way to authenticate to a page we must
  // never bypass, so they are refused rather than sent.
  if (url.username !== "" || url.password !== "") {
    return { target: url.hostname, reason: "credentials" };
  }
  // The port a URL leaves out is the scheme's own, which is always permitted:
  // `url.port` is empty then rather than "80" or "443".
  if (url.port !== "" && !permittedPorts.includes(Number(url.port))) {
    return { target: `${url.hostname}:${url.port}`, reason: "port" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return { target: url.hostname, reason: "host" };
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? { target: host, reason: "address" } : undefined;
  }
  // An address written as a name is still an address to the resolver: these
  // are the forms a numeric IPv4 address can take.
  const asInteger = /^\d+$/.test(host) ? Number(host) : Number.NaN;
  if (Number.isInteger(asInteger) && asInteger >= 0 && asInteger <= 0xffffffff) {
    return { target: host, reason: "address" };
  }
  if (host.startsWith("0x") && /^0x[0-9a-f]+$/i.test(host)) {
    return { target: host, reason: "address" };
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { target: host, reason: "host" };
  }
  // A single label is never a public domain, and in a container it is the name
  // of another service on the installation's own network.
  if (!host.includes(".")) return { target: host, reason: "host" };
  return undefined;
}

/**
 * Judges the addresses a host resolved to. A single blocked answer refuses the
 * fetch: the connection could take it, and there is no way to know which answer
 * the socket will use. The refusal names the address rather than the host, so
 * an operator sees what was actually reached for.
 */
export function judgeAddresses(addresses: readonly string[]): DestinationRefusal | undefined {
  const blocked = addresses.find((address) => isPrivateAddress(address));
  return blocked === undefined ? undefined : { target: blocked, reason: "address" };
}
