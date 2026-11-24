/**
 * Single sign-on from the EWS, browser side. When the deployment sets
 * EWS_DI_SSO_LOGIN_URL, /api/me tells a signed-out browser where to sign in,
 * and the app goes there instead of showing its login form.
 */

/** Session-storage key holding when the app last sent the browser to the EWS. */
const REDIRECTED_AT = "di.ewsSso.redirectedAt"

/** A second automatic redirect within this window is a loop (for example a refused cookie). */
const LOOP_WINDOW_MS = 60_000

/** The EWS sign-in address that returns to `path` (a DI path with its hash) afterwards. */
export function ewsSignInHref(loginUrl: string, path: string): string {
  return `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}next=${encodeURIComponent(path)}`
}

/** Whether the address asks for the local login form (`/?local=1`), kept for administrators. */
export function wantsLocalLogin(search = window.location.search): boolean {
  return new URLSearchParams(search).has("local")
}

/**
 * Records an automatic redirect to the EWS and says whether it may go ahead:
 * false when one already happened within the last minute.
 */
export function claimAutoRedirect(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(REDIRECTED_AT) ?? 0)
    if (now - last < LOOP_WINDOW_MS) return false
    sessionStorage.setItem(REDIRECTED_AT, String(now))
  } catch {
    // Without session storage there is no loop guard, so never redirect by itself
    return false
  }
  return true
}

/** Forgets the last automatic redirect once a session is in place. */
export function clearAutoRedirect(): void {
  try {
    sessionStorage.removeItem(REDIRECTED_AT)
  } catch {
    // Nothing stored
  }
}
