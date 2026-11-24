import { ewsSignInHref } from "./ewsSso.js"

/** Props for the signed-out page. */
interface SignedOutProps {
  /** The EWS single sign-on address */
  loginUrl: string
  /** True when an automatic sign-in through the EWS did not complete */
  failed?: boolean
}

/**
 * Shown after signing out when the deployment signs users in through the EWS,
 * and when single sign-on did not complete. It never redirects by itself.
 */
export function SignedOut({ loginUrl, failed = false }: SignedOutProps) {
  return (
    <main className="login-page">
      <div className="login-card">
        <h1>WASH Data Integrator</h1>
        <p>{failed ? T`Sign-in through the early warning system did not complete.` : T`Signed out`}</p>
        <a className="login-action" href={ewsSignInHref(loginUrl, "/")}>{T`Sign in with EWS`}</a>
        <a href="/?local=1">{T`Local admin login`}</a>
      </div>
    </main>
  )
}
