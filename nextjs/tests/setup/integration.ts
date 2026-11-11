// Integration project only: replaces the NextAuth instance (lib/auth.ts) with a
// controllable auth(). Use asStreamer()/asGuest()/asDiscord()/signedOut() from
// tests/helpers/session.ts to choose the session. Both '@/lib/auth' and
// lib/watchAccess.ts's './auth' resolve to the same module id, so both are mocked.
import { beforeEach, vi } from 'vitest'
import { auth } from '@/lib/auth'

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => null),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  config: {},
}))

// Every test starts signed out.
beforeEach(() => {
  ;(vi.mocked(auth) as unknown as { mockResolvedValue(v: null): void }).mockResolvedValue(null)
})
