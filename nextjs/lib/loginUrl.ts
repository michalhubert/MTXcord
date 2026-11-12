export function loginUrlFor(path: string): string {
  return `/login?${new URLSearchParams({ callbackUrl: `/${path}` })}`
}

// The same login URL with `manual=1`: signed-out trusted-network viewers are not signed
// straight back in, so they can pick another way to sign in.
export function withManualLogin(url: string): string {
  const parsed = new URL(url, 'http://same.site')
  parsed.searchParams.set('manual', '1')
  return parsed.pathname + parsed.search + parsed.hash
}

// Rejects other sites and schemes like javascript: in a callbackUrl.
export function sameSitePath(url: string | null, fallback: string): string {
  if (!url) return fallback
  try {
    const parsed = new URL(url, 'http://same.site')
    if (parsed.origin !== 'http://same.site') return fallback
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return fallback
  }
}

export function streamPathOf(callbackUrl: unknown): string | null {
  if (typeof callbackUrl !== 'string') return null
  try {
    return new URL(callbackUrl, 'http://localhost').pathname.split('/')[1] || null
  } catch {
    return null
  }
}
