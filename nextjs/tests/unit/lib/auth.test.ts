import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setViewerPassword } from '@/lib/db'
import { config } from '@/lib/auth'
import { resetServerState } from '../../helpers/state'

type Authorize = (
  credentials: Record<string, unknown>,
  request: Request,
) => Promise<Record<string, unknown> | null>
type Provider = { options: { id: string; authorize: Authorize } }

function providerById(id: string, from = config): Provider {
  const found = (from.providers as unknown as Provider[]).find(
    (p) => p.options?.id === id,
  )
  if (!found) throw new Error(`provider ${id} not found`)
  return found
}

const request = (ip = '203.0.113.10') =>
  new Request('http://localhost/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  })

describe('viewer-password provider', () => {
  const authorize: Authorize = (c, r) => providerById('viewer-password').options.authorize(c, r)

  beforeEach(() => {
    setViewerPassword('default', 'default-pw')
    setViewerPassword('live', 'live-pw')
  })

  it('accepts the password of any path and returns a viewer carrying it', async () => {
    expect(await authorize({ password: 'live-pw' }, request())).toEqual({
      id: 'viewer',
      name: 'Viewer',
      role: 'viewer',
      password: 'live-pw',
    })
    expect(await authorize({ password: 'default-pw' }, request())).toMatchObject({
      role: 'viewer',
      password: 'default-pw',
    })
  })

  it('rejects wrong, empty and non-string passwords', async () => {
    expect(await authorize({ password: 'nope' }, request())).toBeNull()
    expect(await authorize({ password: 'live-pW' }, request())).toBeNull()
    expect(await authorize({ password: '' }, request())).toBeNull()
    expect(await authorize({}, request())).toBeNull()
    expect(await authorize({ password: 123 }, request())).toBeNull()
    expect(await authorize({ password: ['live-pw'] }, request())).toBeNull()
  })

  it('rejects everything while no password exists', async () => {
    resetServerState()
    expect(await authorize({ password: 'anything' }, request())).toBeNull()
  })

  it('locks out an IP after 10 wrong guesses, even for the right password', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await authorize({ password: `guess-${i}` }, request('198.51.100.1'))).toBeNull()
    }
    expect(await authorize({ password: 'live-pw' }, request('198.51.100.1'))).toBeNull()
    // Another address is unaffected.
    expect(await authorize({ password: 'live-pw' }, request('198.51.100.2'))).not.toBeNull()
  })

  it('does not count empty passwords as failures', async () => {
    for (let i = 0; i < 20; i++) await authorize({ password: '' }, request('198.51.100.3'))
    expect(await authorize({ password: 'live-pw' }, request('198.51.100.3'))).not.toBeNull()
  })
})

describe('streamer-password provider', () => {
  const authorize: Authorize = (c, r) => providerById('streamer-password').options.authorize(c, r)

  it('accepts the STREAMER_PASSWORD', async () => {
    expect(await authorize({ password: 'test-streamer-password' }, request())).toEqual({
      id: 'streamer',
      name: 'Streamer',
      role: 'streamer',
    })
  })

  it('rejects wrong and non-string passwords', async () => {
    expect(await authorize({ password: 'wrong' }, request())).toBeNull()
    expect(await authorize({ password: 'test-streamer-passwor' }, request())).toBeNull()
    expect(await authorize({}, request())).toBeNull()
    expect(await authorize({ password: 42 }, request())).toBeNull()
  })

  it('is disabled when STREAMER_PASSWORD is empty', async () => {
    vi.stubEnv('STREAMER_PASSWORD', '')
    expect(await authorize({ password: '' }, request())).toBeNull()
    expect(await authorize({ password: 'anything' }, request())).toBeNull()
  })

  it('does not accept a viewer password', async () => {
    setViewerPassword('live', 'live-pw')
    expect(await authorize({ password: 'live-pw' }, request())).toBeNull()
  })

  it('throttles guessing per IP', async () => {
    for (let i = 0; i < 10; i++) {
      await authorize({ password: `guess-${i}` }, request('198.51.100.9'))
    }
    expect(
      await authorize({ password: 'test-streamer-password' }, request('198.51.100.9')),
    ).toBeNull()
    expect(
      await authorize({ password: 'test-streamer-password' }, request('198.51.100.8')),
    ).not.toBeNull()
  })

  it('shares the failure budget with the viewer-password provider', async () => {
    setViewerPassword('live', 'live-pw')
    const viewer = providerById('viewer-password').options.authorize
    for (let i = 0; i < 10; i++) await viewer({ password: `guess-${i}` }, request('198.51.100.7'))
    expect(
      await authorize({ password: 'test-streamer-password' }, request('198.51.100.7')),
    ).toBeNull()
  })
})

describe('callbacks', () => {
  type Callback = (params: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  const jwt = config.callbacks!.jwt as unknown as Callback
  const session = config.callbacks!.session as unknown as Callback

  it('stores the viewer password in the token', async () => {
    const token = await jwt({ token: {}, user: { role: 'viewer', password: 'pw' } })
    expect(token).toMatchObject({ role: 'viewer', password: 'pw' })
  })

  it('leaves the password out for other users', async () => {
    const token = await jwt({ token: {}, user: { role: 'streamer' } })
    expect(token).toMatchObject({ role: 'streamer' })
    expect(token).not.toHaveProperty('password')
  })

  it('keeps the stored password on later refreshes', async () => {
    const token = await jwt({ token: { role: 'viewer', password: 'pw' } })
    expect(token).toMatchObject({ password: 'pw' })
  })

  it('still refuses sessions with a placeholder secret', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXTAUTH_SECRET', 'changeme-use-a-random-secret')
    expect(await jwt({ token: {}, user: { role: 'viewer', password: 'pw' } })).toBeNull()
  })

  it('exposes the password, role and id on the session user', async () => {
    const result = (await session({
      session: { user: {}, expires: 'later' },
      token: { role: 'viewer', sub: 'viewer', password: 'pw' },
    })) as { user: Record<string, unknown> }
    expect(result.user).toMatchObject({ role: 'viewer', id: 'viewer', password: 'pw' })
  })
})

describe('Discord provider', () => {
  afterEach(() => vi.resetModules())

  async function load(id: string, secret: string) {
    vi.resetModules()
    vi.stubEnv('DISCORD_CLIENT_ID', id)
    vi.stubEnv('DISCORD_CLIENT_SECRET', secret)
    return (await import('@/lib/auth')).config
  }

  const ids = (c: typeof config) =>
    (c.providers as unknown as { id?: string; options?: { id?: string } }[]).map(
      (p) => p.options?.id ?? p.id,
    )

  it('is absent without credentials', () => {
    expect(ids(config)).toEqual(['viewer-password', 'streamer-password'])
  })

  it('is absent when only one of id and secret is set', async () => {
    expect(ids(await load('abc', ''))).not.toContain('discord')
    expect(ids(await load('', 'def'))).not.toContain('discord')
  })

  it('is added first when both are set', async () => {
    expect(ids(await load('abc', 'def'))).toEqual([
      'discord',
      'viewer-password',
      'streamer-password',
    ])
  })
})
