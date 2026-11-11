import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))

import { auth } from '@/lib/auth'
import { isStreamerAuthorized, isViewerPasswordStale, type SessionUser } from '@/lib/authz'
import { setViewerPassword } from '@/lib/db'

const mockAuth = vi.mocked(auth) as unknown as {
  mockResolvedValue(v: unknown): void
}

const viewer = (password?: string): SessionUser => ({
  id: 'viewer',
  name: null,
  image: null,
  role: 'viewer',
  password,
})

describe('isViewerPasswordStale', () => {
  it('is never stale when no password is configured', () => {
    expect(isViewerPasswordStale(viewer('anything'), 'live')).toBe(false)
    expect(isViewerPasswordStale(viewer(undefined), 'live')).toBe(false)
  })

  it('compares against the path own password', () => {
    setViewerPassword('live', 'current')
    expect(isViewerPasswordStale(viewer('current'), 'live')).toBe(false)
    expect(isViewerPasswordStale(viewer('old'), 'live')).toBe(true)
    expect(isViewerPasswordStale(viewer(undefined), 'live')).toBe(true)
  })

  it('falls back to the default password', () => {
    setViewerPassword('default', 'def')
    expect(isViewerPasswordStale(viewer('def'), 'live')).toBe(false)
    expect(isViewerPasswordStale(viewer('old'), 'live')).toBe(true)
  })

  it('prefers the path password over the default', () => {
    setViewerPassword('default', 'def')
    setViewerPassword('live', 'own')
    expect(isViewerPasswordStale(viewer('own'), 'live')).toBe(false)
    expect(isViewerPasswordStale(viewer('def'), 'live')).toBe(true)
  })

  it('only applies to the viewer role', () => {
    setViewerPassword('live', 'current')
    expect(
      isViewerPasswordStale({ id: '1', name: 'x', image: null, role: 'discord' }, 'live'),
    ).toBe(false)
    expect(
      isViewerPasswordStale(
        { id: 'streamer', name: null, image: null, role: 'streamer' },
        'live',
      ),
    ).toBe(false)
  })
})

describe('isStreamerAuthorized', () => {
  beforeEach(() => mockAuth.mockResolvedValue(null))

  it('accepts a streamer session', async () => {
    mockAuth.mockResolvedValue({ user: { role: 'streamer' } })
    expect(await isStreamerAuthorized()).toBe(true)
  })

  it.each([
    ['viewer', { user: { role: 'viewer' } }],
    ['discord', { user: { role: 'discord' } }],
    ['no role', { user: {} }],
    ['no session', null],
  ])('rejects %s', async (_name, session) => {
    mockAuth.mockResolvedValue(session)
    expect(await isStreamerAuthorized()).toBe(false)
  })

  it('lets everyone in when DISABLE_DOCK_AUTH is exactly "true"', async () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    expect(await isStreamerAuthorized()).toBe(true)
    expect(auth).not.toHaveBeenCalled()
  })

  it.each(['1', 'TRUE', 'yes', 'false'])(
    'does not treat DISABLE_DOCK_AUTH=%s as disabled',
    async (value) => {
      vi.stubEnv('DISABLE_DOCK_AUTH', value)
      expect(await isStreamerAuthorized()).toBe(false)
    },
  )
})
