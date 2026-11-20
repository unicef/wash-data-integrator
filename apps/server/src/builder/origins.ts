/** Origins of a source's addresses: what a key is tied to. */

/** The origin (scheme, host and port) of each source address a key was given for; null when unset. */
export type KeyOrigins = Record<(typeof ADDRESS_FIELDS)[number], string | null>

/** The source fields a connector sends requests to. */
export const ADDRESS_FIELDS = ["url", "layerUrl"] as const

/** The origin of an address, null when empty; text that is not a URL is its own origin. */
export function originOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  try {
    const url = new URL(String(value))
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    return "invalid:" + String(value)
  }
}

/** The origins of a source's addresses. */
export function keyOriginsOf(source: Record<string, unknown> | undefined): KeyOrigins {
  const s = source ?? {}
  return { url: originOf(s.url), layerUrl: originOf(s.layerUrl) }
}

/** True when a source address now points to an origin other than the one it had (an address that is cleared does not count). */
export function addressOriginChanged(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
  const was = keyOriginsOf(before)
  const now = keyOriginsOf(after)
  return ADDRESS_FIELDS.some(field => now[field] !== null && now[field] !== was[field])
}
