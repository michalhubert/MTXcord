// Controls what the mocked `auth()` (see tests/setup/integration.ts) returns.
// Integration project only.
import { vi } from 'vitest'
import { auth } from '@/lib/auth'

export type TestSession = {
  user: Record<string, unknown>
  expires: string
}

// next-auth's auth() is heavily overloaded; treat the mock as a plain async fn.
const mockAuth = vi.mocked(auth) as unknown as {
  mockResolvedValue(value: TestSession | null): void
}

function setSession(user: Record<string, unknown> | null): TestSession | null {
  const session = user
    ? { user, expires: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }
    : null
  mockAuth.mockResolvedValue(session)
  return session
}

/** Streamer session (the dock/stream owner). */
export function asStreamer(): TestSession | null {
  return setSession({ id: 'streamer', role: 'streamer', name: null, image: null })
}

/** Shared-password viewer. `password` is the viewer password they signed in with. */
export function asGuest(password: string): TestSession | null {
  return setSession({
    id: 'viewer',
    role: 'viewer',
    name: null,
    image: null,
    password,
  })
}

/** Discord-signed-in viewer. */
export function asDiscord(
  id: string,
  name: string,
  image: string | null = null,
): TestSession | null {
  return setSession({ id, role: 'discord', name, image })
}

/** No session: auth() resolves null. */
export function signedOut(): TestSession | null {
  return setSession(null)
}
