import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authConfig } from '@/lib/auth.config'

// The callbacks are typed against Auth.js internals; tests pass partial objects.
type Callback = (params: Record<string, unknown>) => unknown
const jwt = authConfig.callbacks!.jwt as unknown as Callback
const session = authConfig.callbacks!.session as unknown as Callback
const authorized = authConfig.callbacks!.authorized as unknown as Callback

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('jwt callback', () => {
  it('refuses all sessions with a missing or placeholder NEXTAUTH_SECRET', () => {
    for (const secret of [
      '',
      'changeme-use-a-random-secret',
      'change-me-to-a-random-secret',
    ]) {
      vi.stubEnv('NEXTAUTH_SECRET', secret)
      expect(jwt({ token: { sub: 'viewer' }, user: { role: 'viewer' } })).toBeNull()
    }
  })

  it('takes the role from the signed-in user', () => {
    expect(jwt({ token: {}, user: { role: 'streamer' } })).toMatchObject({ role: 'streamer' })
    expect(jwt({ token: {}, user: { role: 'viewer' } })).toMatchObject({ role: 'viewer' })
  })

  it('defaults the role to viewer when the user has none', () => {
    expect(jwt({ token: {}, user: {} })).toMatchObject({ role: 'viewer' })
  })

  it('makes Discord sign-ins role discord, whatever the user object says', () => {
    expect(
      jwt({ token: {}, user: { role: 'streamer' }, account: { provider: 'discord' } }),
    ).toMatchObject({ role: 'discord' })
  })

  it('does not treat other providers as Discord', () => {
    expect(
      jwt({ token: {}, user: { role: 'viewer' }, account: { provider: 'credentials' } }),
    ).toMatchObject({ role: 'viewer' })
  })

  it('keeps an existing role on later refreshes', () => {
    expect(jwt({ token: { role: 'streamer', sub: 'viewer' } })).toMatchObject({
      role: 'streamer',
    })
  })

  it('derives a missing role from the subject', () => {
    expect(jwt({ token: { sub: 'viewer' } })).toMatchObject({ role: 'viewer' })
    expect(jwt({ token: { sub: 'streamer' } })).toMatchObject({ role: 'streamer' })
    expect(jwt({ token: { sub: '1234567890' } })).toMatchObject({ role: 'discord' })
    expect(jwt({ token: {} })).toMatchObject({ role: 'discord' })
  })
})

describe('session callback', () => {
  it('copies the role and subject onto the user', () => {
    const result = session({
      session: { user: { name: 'x' }, expires: 'later' },
      token: { role: 'streamer', sub: 'streamer' },
    }) as { user: Record<string, unknown> }
    expect(result.user).toMatchObject({ name: 'x', role: 'streamer', id: 'streamer' })
  })

  it('keeps the user id when the token has no subject', () => {
    const result = session({
      session: { user: { id: 'keep' } },
      token: { role: 'viewer' },
    }) as { user: Record<string, unknown> }
    expect(result.user).toMatchObject({ id: 'keep', role: 'viewer' })
  })

  it('passes through a session without a user', () => {
    const input = { expires: 'later' }
    expect(session({ session: input, token: { role: 'viewer' } })).toBe(input)
  })
})

describe('authorized callback', () => {
  it('requires a user', () => {
    expect(authorized({ auth: { user: { name: 'x' } } })).toBe(true)
    expect(authorized({ auth: {} })).toBe(false)
    expect(authorized({ auth: null })).toBe(false)
  })
})

describe('config', () => {
  it('trusts the host and sends users to /login', () => {
    expect(authConfig.trustHost).toBe(true)
    expect(authConfig.pages?.signIn).toBe('/login')
  })
})
