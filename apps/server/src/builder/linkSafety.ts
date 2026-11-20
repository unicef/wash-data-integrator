import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

/** Resolves a host name to all of its addresses. */
export type Resolver = (host: string) => Promise<string[]>

/** Every address the host resolves to, IPv4 and IPv6. */
const systemResolve: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address)

/** Addresses a builder link may never reach: this host, the local network and cloud metadata. */
const BLOCKED = new BlockList()
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4") // "this network", 0.0.0.0 included
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4")
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4")
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4") // link-local, cloud metadata
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4")
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4")
BLOCKED.addAddress("::", "ipv6")
BLOCKED.addAddress("::1", "ipv6")
BLOCKED.addSubnet("fe80::", 10, "ipv6")
BLOCKED.addSubnet("fc00::", 7, "ipv6")

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh), else null. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = lower.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const hex = lower.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join(".")
}

/** True when the address is private, loopback, link-local, unique-local or unspecified. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return BLOCKED.check(address, "ipv4")
  if (family === 6) {
    const v4 = mappedIpv4(address)
    return v4 !== null ? BLOCKED.check(v4, "ipv4") : BLOCKED.check(address, "ipv6")
  }
  return true
}

/**
 * Refuses a link the builder must not fetch: anything but http or https, and
 * any host that resolves (on any of its addresses) to this machine or a
 * private network. Throws an Error with a message for the editor.
 */
export async function checkLink(url: string, resolve: Resolver = systemResolve): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`"${url}" is not a valid link.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`The link must start with http:// or https:// (got ${parsed.protocol.replace(/:$/, "")}).`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (host === "") throw new Error("The link has no host.")
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await resolve(host)
    } catch {
      throw new Error(`The link's host ${host} could not be found.`)
    }
    if (addresses.length === 0) throw new Error(`The link's host ${host} could not be found.`)
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`The link points to a private or local network address (${host}); use a public link.`)
  }
}
