/**
 * Single sign-on from the UNICEF WASH Early Warning System (EWS). The EWS
 * signs a short-lived handover token (a compact JWT, HS256, with a secret
 * shared through EWS_DI_SSO_SECRET); GET /auth/ews-sso verifies it, accepts
 * each token once, and signs the browser in as one shared DI account. With
 * the secret unset nothing here is reachable. See "Single sign-on from the
 * EWS" in docs/Deployment.md.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import pg from "pg"
import type { AuthUser } from "./auth.js"

/** Validated EWS single sign-on settings; null in AppConfig when off. */
export interface EwsSsoConfig {
  /** EWS_DI_SSO_SECRET: HMAC key shared with the EWS */
  secret: string
  /** EWS_DI_SSO_LOGIN_URL: where a signed-out browser is sent; null keeps the local login */
  loginUrl: string | null
  /** EWS_DI_SSO_ACCOUNT: the shared account EWS users sign in as */
  account: string
  /** EWS_DI_SSO_ROLE: role given to the shared account when it is created */
  role: AuthUser["role"]
}

/** Longest lifetime a token may claim, in seconds. */
export const MAX_TOKEN_SECONDS = 60

/** Clock difference tolerated between the EWS and DI hosts, in seconds. */
const CLOCK_SKEW_SECONDS = 30

/** The only header accepted: HS256, so "none" and other algorithms fail. */
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")

/** Stored as the shared account's password hash; it is not a scrypt hash, so no password ever matches. */
export const UNUSABLE_PASSWORD_HASH = "ews-sso:no-password"

/** Why a token was refused (logged; never the token itself). */
export type TokenRefusal = "malformed" | "bad-signature" | "expired" | "bad-claims" | "replayed"

/** Nonces of accepted tokens, kept until their token would have expired. */
export class NonceStore {
  private readonly used = new Map<string, number>()

  /** Records a nonce; false when it was already used. */
  claim(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    for (const [key, until] of this.used) if (until < nowMs) this.used.delete(key)
    if (this.used.has(nonce)) return false
    this.used.set(nonce, expiresAtMs)
    return true
  }
}

/**
 * Verifies a handover token: header, constant-time signature, issuer "ews",
 * audience "di", a lifetime of at most MAX_TOKEN_SECONDS that has not ended,
 * and a nonce not seen before. Returns the EWS user's email for the audit log.
 */
export function verifyEwsToken(
  token: string,
  secret: string,
  nonces: NonceStore,
  nowMs = Date.now()
): { ok: true; subject: string } | { ok: false; reason: TokenRefusal } {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: "malformed" }
  const want = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest()
  const got = Buffer.from(parts[2], "base64url")
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad-signature" }

  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  const { iss, aud, sub, iat, exp, nonce } = claims ?? {}
  const now = nowMs / 1000
  if (
    iss !== "ews" ||
    aud !== "di" ||
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > 320 ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    exp - iat > MAX_TOKEN_SECONDS ||
    exp < iat ||
    iat > now + CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "bad-claims" }
  }
  if (exp <= now) return { ok: false, reason: "expired" }
  if (!nonces.claim(nonce, exp * 1000 + CLOCK_SKEW_SECONDS * 1000, nowMs)) return { ok: false, reason: "replayed" }
  return { ok: true, subject: sub }
}

/** A relative DI path (one leading slash, no "//", no backslash, no scheme), else "/". */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/"
  if (/[\\\x00-\x1f\x7f]/.test(next) || next.length > 2000) return "/"
  return next
}

/** Whether an email is the shared account (emails compare case-insensitively, like the users table). */
export function isSsoAccount(config: EwsSsoConfig | null, email: string): boolean {
  return config !== null && email.trim().toLowerCase() === config.account.toLowerCase()
}

/**
 * The shared account, created on first use with the configured role and a
 * password hash no password matches. Null when an admin has disabled it.
 */
export async function ssoAccount(pool: pg.Pool, config: EwsSsoConfig): Promise<AuthUser | null> {
  await pool.query(
    "INSERT INTO app.users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING",
    [config.account, UNUSABLE_PASSWORD_HASH, config.role]
  )
  const result = await pool.query("SELECT id, email, role, disabled FROM app.users WHERE email = $1", [config.account])
  const row = result.rows[0]
  return row && !row.disabled ? { id: row.id, email: row.email, role: row.role } : null
}

/** Escapes text for HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/**
 * The plain page shown when a handover fails. It links back to the EWS and
 * never redirects, so a failure cannot loop.
 */
export function ssoErrorPage(config: EwsSsoConfig, message: string): string {
  let ews: string | null = null
  try {
    if (config.loginUrl) ews = new URL(config.loginUrl).origin
  } catch {
    ews = null
  }
  const back = ews ? `<p><a href="${escapeHtml(ews)}/">Back to the early warning system</a></p>` : ""
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in failed</title></head>' +
    '<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">' +
    `<h1>Sign-in from the early warning system failed</h1><p>${escapeHtml(message)}</p>${back}` +
    '<p><a href="/?local=1">Local admin login</a></p></body></html>'
  )
}
