import { type SessionUser } from './authz'
import { isTrustedIp } from './trustedNetworks'

export type TrustedLogin = {
  // Offer "Continue without password": the client's IP is in TRUSTED_NETWORKS and there is
  // no usable session that signing in by IP would replace.
  trusted: boolean
  // Sign in by IP straight away, without a click.
  autoSignIn: boolean
}

// The one place that decides how /login treats a client on TRUSTED_NETWORKS. Streamer mode
// never offers it. Signing in by IP replaces the current session, so it is only offered
// when there is no usable session to lose: nobody is signed in, or the session is revoked
// (`revoked`, from isSessionRevoked, e.g. a password guest holding a stale password).
// Discord, streamer and still valid sessions are never replaced, and `manual=1` (set after
// signing out) offers the button but asks to pick another way to sign in.
export function trustedLogin({
  user,
  revoked,
  mode,
  manual,
  ip,
}: {
  user: SessionUser | undefined
  revoked: boolean
  mode: unknown
  manual: unknown
  ip: string
}): TrustedLogin {
  const noUsableSession = !user || revoked
  const trusted = mode !== 'streamer' && noUsableSession && isTrustedIp(ip)
  return { trusted, autoSignIn: trusted && manual !== '1' }
}
