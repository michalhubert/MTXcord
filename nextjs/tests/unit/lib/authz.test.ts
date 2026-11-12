import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))

import { auth } from '@/lib/auth'
import {
  isSessionRevoked,
  isStreamerAuthorized,
  isTrustedSessionValid,
  type SessionUser,
} from '@/lib/authz'
import { setViewerPassword } from '@/lib/db'
import { trustNetworks } from '../../helpers/trust'

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

const IP = '203.0.113.10'
const TRUSTED_IP = '10.250.0.5'
const trusted = (): SessionUser => ({
  id: 'viewer',
  name: null,
  image: null,
  role: 'viewer',
  trusted: true,
})
const revoked = (user: SessionUser, path = 'live', ip = IP) => isSessionRevoked(user, path, ip)

describe('isSessionRevoked: viewer password', () => {
  it('is never revoked when no password is configured', () => {
    expect(revoked(viewer('anything'))).toBe(false)
    expect(revoked(viewer(undefined))).toBe(false)
  })

  it('compares against the path own password', () => {
    setViewerPassword('live', 'current')
    expect(revoked(viewer('current'))).toBe(false)
    expect(revoked(viewer('old'))).toBe(true)
    expect(revoked(viewer(undefined))).toBe(true)
  })

  it('falls back to the default password', () => {
    setViewerPassword('default', 'def')
    expect(revoked(viewer('def'))).toBe(false)
    expect(revoked(viewer('old'))).toBe(true)
  })

  it('prefers the path password over the default', () => {
    setViewerPassword('default', 'def')
    setViewerPassword('live', 'own')
    expect(revoked(viewer('own'))).toBe(false)
    expect(revoked(viewer('def'))).toBe(true)
  })

  it('treats a stale password guest as revoked even on a trusted IP', () => {
    trustNetworks('10.250.0.0/16')
    setViewerPassword('live', 'current')
    expect(revoked(viewer('old'), 'live', TRUSTED_IP)).toBe(true)
    expect(revoked(viewer('current'), 'live', TRUSTED_IP)).toBe(false)
  })

  it('only applies to the viewer role', () => {
    setViewerPassword('live', 'current')
    expect(revoked({ id: '1', name: 'x', image: null, role: 'discord' })).toBe(false)
    expect(revoked({ id: 'streamer', name: null, image: null, role: 'streamer' })).toBe(false)
  })
})

describe('isSessionRevoked: trusted-network session', () => {
  beforeEach(() => trustNetworks('10.250.0.0/16'))

  it('is never made stale by a password, from a trusted IP', () => {
    setViewerPassword('live', 'current')
    setViewerPassword('default', 'def')
    expect(revoked(trusted(), 'live', TRUSTED_IP)).toBe(false)
    expect(revoked(trusted(), 'other', TRUSTED_IP)).toBe(false)
  })

  it('is revoked from an IP outside the trusted networks', () => {
    expect(revoked(trusted(), 'live', IP)).toBe(true)
    expect(revoked(trusted(), 'live', 'unknown')).toBe(true)
  })

  it('is revoked once TRUSTED_NETWORKS is cleared', () => {
    vi.stubEnv('TRUSTED_NETWORKS', '')
    expect(revoked(trusted(), 'live', TRUSTED_IP)).toBe(true)
  })
})

describe('isSessionRevoked: no stream path (login page)', () => {
  beforeEach(() => trustNetworks('10.250.0.0/16'))

  it('keeps a password session, whatever password it holds', () => {
    setViewerPassword('default', 'def')
    setViewerPassword('gaming', 'own')
    expect(isSessionRevoked(viewer('own'), null, IP)).toBe(false)
    expect(isSessionRevoked(viewer('old'), null, IP)).toBe(false)
    expect(isSessionRevoked(viewer(undefined), null, TRUSTED_IP)).toBe(false)
  })

  it('still revokes a trusted session off the network, and keeps it on it', () => {
    expect(isSessionRevoked(trusted(), null, IP)).toBe(true)
    expect(isSessionRevoked(trusted(), null, TRUSTED_IP)).toBe(false)
  })

  it('never revokes discord and streamer sessions', () => {
    expect(isSessionRevoked({ id: '1', name: 'x', image: null, role: 'discord' }, null, IP)).toBe(false)
    expect(isSessionRevoked({ id: 's', name: null, image: null, role: 'streamer' }, null, IP)).toBe(false)
  })
})

describe('isTrustedSessionValid', () => {
  beforeEach(() => trustNetworks('10.250.0.0/16'))

  it('is true for a trusted session on a trusted IP', () => {
    expect(isTrustedSessionValid(true, TRUSTED_IP)).toBe(true)
  })

  it('is false off the network, without an IP, or without the trusted flag', () => {
    expect(isTrustedSessionValid(true, IP)).toBe(false)
    expect(isTrustedSessionValid(true, 'unknown')).toBe(false)
    expect(isTrustedSessionValid(true, undefined)).toBe(false)
    expect(isTrustedSessionValid(true, null)).toBe(false)
    expect(isTrustedSessionValid(true, '')).toBe(false)
    expect(isTrustedSessionValid(false, TRUSTED_IP)).toBe(false)
    expect(isTrustedSessionValid(undefined, TRUSTED_IP)).toBe(false)
  })

  it('is false once TRUSTED_NETWORKS is cleared', () => {
    vi.stubEnv('TRUSTED_NETWORKS', '')
    expect(isTrustedSessionValid(true, TRUSTED_IP)).toBe(false)
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
