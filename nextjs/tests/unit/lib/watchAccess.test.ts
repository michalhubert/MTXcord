import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))

import { auth } from '@/lib/auth'
import { kickViewer, denyViewer } from '@/lib/accessBlocks'
import { approveAccess } from '@/lib/accessRequests'
import { rotateViewerPassword, setPathVisibility, setViewerPassword } from '@/lib/db'
import type { SessionUser } from '@/lib/authz'
import {
  authorizeGuest,
  authorizeWatch,
  viewerAccess,
  watchAccessDenied,
} from '@/lib/watchAccess'
import { nextRequest } from '../../helpers/request'
import { useFakeClock } from '../../helpers/clock'
import { trustNetworks } from '../../helpers/trust'

const mockAuth = vi.mocked(auth) as unknown as {
  mockResolvedValue(v: unknown): void
}

const IP = '203.0.113.10'
const viewer = (password = 'pw'): SessionUser => ({
  id: 'viewer',
  name: null,
  image: null,
  role: 'viewer',
  password,
})
const TRUSTED_IP = '10.250.0.5'
const trusted = (): SessionUser => ({
  id: 'viewer',
  name: null,
  image: null,
  role: 'viewer',
  trusted: true,
})
const discord = (id = '42'): SessionUser => ({
  id,
  name: 'Luna',
  image: null,
  role: 'discord',
})
const streamer: SessionUser = {
  id: 'streamer',
  name: null,
  image: null,
  role: 'streamer',
}

beforeEach(() => {
  setViewerPassword('live', 'pw')
})

describe('viewerAccess', () => {
  it('lets the streamer in regardless of visibility', () => {
    expect(viewerAccess(streamer, 'live', IP)).toEqual({ status: 'ok' })
  })

  it('lets anyone onto a public stream', () => {
    setPathVisibility('live', 'public')
    expect(viewerAccess(viewer(), 'live', IP)).toEqual({ status: 'ok' })
    expect(viewerAccess(discord(), 'live', IP)).toEqual({ status: 'ok' })
  })

  it('makes viewers wait on a private stream until approved', () => {
    expect(viewerAccess(viewer(), 'live', IP)).toEqual({ status: 'pending' })
    expect(viewerAccess(discord(), 'live', IP)).toEqual({ status: 'pending' })
  })

  it('approves guests by IP', () => {
    approveAccess('live', IP, 'viewer')
    expect(viewerAccess(viewer(), 'live', IP).status).toBe('ok')
    expect(viewerAccess(viewer(), 'live', '198.51.100.7').status).toBe('pending')
    expect(viewerAccess(viewer(), 'other', IP).status).toBe('pending')
  })

  it('approves Discord viewers by account, not by IP', () => {
    approveAccess('live', 'discord:42', 'discord')
    expect(viewerAccess(discord('42'), 'live', IP).status).toBe('ok')
    expect(viewerAccess(discord('42'), 'live', '198.51.100.7').status).toBe('ok')
    expect(viewerAccess(discord('43'), 'live', IP).status).toBe('pending')
  })

  it('does not let an IP approval cover a Discord viewer (or the reverse)', () => {
    approveAccess('live', IP, 'viewer')
    expect(viewerAccess(discord(), 'live', IP).status).toBe('pending')
    approveAccess('live', 'discord:42', 'discord')
    expect(viewerAccess(viewer(), 'live', '198.51.100.7').status).toBe('pending')
  })

  it('reports a stale password as unauthorized, before anything else', () => {
    setPathVisibility('live', 'public')
    kickViewer('live', { role: 'viewer', ip: IP })
    expect(viewerAccess(viewer('old'), 'live', IP)).toEqual({ status: 'unauthorized' })
  })

  it('blocks kicked viewers even when approved or public', () => {
    useFakeClock()
    approveAccess('live', IP, 'viewer')
    kickViewer('live', { role: 'viewer', ip: IP })
    expect(viewerAccess(viewer(), 'live', IP)).toEqual({
      status: 'blocked',
      reason: 'kicked',
      blockedUntil: Date.now() + 60_000,
    })
    setPathVisibility('live', 'public')
    expect(viewerAccess(viewer(), 'live', IP).status).toBe('blocked')
  })

  it('reports the reason for a denial', () => {
    denyViewer('live', { role: 'discord', ip: IP, discordId: '42' })
    expect(viewerAccess(discord('42'), 'live', IP)).toMatchObject({
      status: 'blocked',
      reason: 'denied',
    })
    expect(viewerAccess(discord('43'), 'live', IP).status).toBe('pending')
  })

  it('lets a viewer back in once the block expires', () => {
    useFakeClock()
    setPathVisibility('live', 'public')
    kickViewer('live', { role: 'viewer', ip: IP })
    vi.advanceTimersByTime(60_001)
    expect(viewerAccess(viewer(), 'live', IP).status).toBe('ok')
  })

  it('never blocks the streamer', () => {
    kickViewer('live', { role: 'streamer', ip: IP })
    expect(viewerAccess(streamer, 'live', IP).status).toBe('ok')
  })
})

describe('viewerAccess for trusted-network sessions', () => {
  beforeEach(() => {
    trustNetworks('10.250.0.0/16')
  })

  it('lets them onto a public stream without any password', () => {
    setViewerPassword('live', 'rotated-since')
    setPathVisibility('live', 'public')
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP)).toEqual({ status: 'ok' })
  })

  it('is not made stale by a password rotation', () => {
    setPathVisibility('live', 'public')
    rotateViewerPassword('default')
    rotateViewerPassword('live')
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP).status).toBe('ok')
  })

  it('is unauthorized from an IP outside the trusted networks', () => {
    setPathVisibility('live', 'public')
    expect(viewerAccess(trusted(), 'live', IP)).toEqual({ status: 'unauthorized' })
    expect(viewerAccess(trusted(), 'live', 'unknown')).toEqual({ status: 'unauthorized' })
  })

  it('is unauthorized once TRUSTED_NETWORKS no longer covers the IP', () => {
    setPathVisibility('live', 'public')
    vi.stubEnv('TRUSTED_NETWORKS', '')
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP)).toEqual({ status: 'unauthorized' })
  })

  it('makes them wait on a private stream until approved by IP', () => {
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP)).toEqual({ status: 'pending' })
    approveAccess('live', TRUSTED_IP, 'viewer')
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP).status).toBe('ok')
    expect(viewerAccess(trusted(), 'live', '10.250.0.6').status).toBe('pending')
  })

  it('blocks kicked and denied ones like any guest', () => {
    useFakeClock()
    setPathVisibility('live', 'public')
    kickViewer('live', { role: 'viewer', ip: TRUSTED_IP })
    expect(viewerAccess(trusted(), 'live', TRUSTED_IP)).toMatchObject({
      status: 'blocked',
      reason: 'kicked',
    })
    denyViewer('live', { role: 'viewer', ip: '10.250.0.9' })
    expect(viewerAccess(trusted(), 'live', '10.250.0.9')).toMatchObject({
      status: 'blocked',
      reason: 'denied',
    })
  })

  it('does not affect password sessions on a trusted IP', () => {
    setPathVisibility('live', 'public')
    expect(viewerAccess(viewer(), 'live', TRUSTED_IP).status).toBe('ok')
    expect(viewerAccess(viewer('old'), 'live', TRUSTED_IP).status).toBe('unauthorized')
  })
})

describe('watchAccessDenied', () => {
  it('maps statuses to HTTP codes', () => {
    expect(watchAccessDenied(streamer, 'live', IP)).toBeNull()
    expect(watchAccessDenied(viewer('old'), 'live', IP)).toBe(401)
    expect(watchAccessDenied(trusted(), 'live', IP)).toBe(401) // trusted session off its network
    expect(watchAccessDenied(viewer(), 'live', IP)).toBe(403) // pending
    kickViewer('live', { role: 'viewer', ip: IP })
    expect(watchAccessDenied(viewer(), 'live', IP)).toBe(403) // blocked
    setPathVisibility('other', 'public')
    expect(watchAccessDenied(viewer(), 'other', IP)).toBeNull()
  })
})

describe('authorizeWatch', () => {
  const req = () => nextRequest('/api/watch/live', { ip: IP })

  it('404s on an invalid path without consulting the session', async () => {
    expect(await authorizeWatch(req(), 'bad path!')).toEqual({ error: 404 })
    expect(await authorizeWatch(req(), '')).toEqual({ error: 404 })
    expect(auth).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null)
    expect(await authorizeWatch(req(), 'live')).toEqual({ error: 401 })
    mockAuth.mockResolvedValue({ user: undefined })
    expect(await authorizeWatch(req(), 'live')).toEqual({ error: 401 })
  })

  it('401s for a stale password and 403s while pending', async () => {
    mockAuth.mockResolvedValue({ user: viewer('old') })
    expect(await authorizeWatch(req(), 'live')).toEqual({ error: 401 })
    mockAuth.mockResolvedValue({ user: viewer() })
    expect(await authorizeWatch(req(), 'live')).toEqual({ error: 403 })
  })

  it('returns the user and client IP when allowed', async () => {
    const user = viewer()
    mockAuth.mockResolvedValue({ user })
    approveAccess('live', IP, 'viewer')
    expect(await authorizeWatch(req(), 'live')).toEqual({ user, ip: IP })
  })
})

describe('authorizeGuest', () => {
  const req = () => nextRequest('/api/watch/live/avatar', { ip: IP })

  it('passes on the error status as an empty Response', async () => {
    mockAuth.mockResolvedValue(null)
    const res = (await authorizeGuest(req(), 'live')) as Response
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(401)
  })

  it('keys password viewers by IP', async () => {
    const user = viewer()
    mockAuth.mockResolvedValue({ user })
    approveAccess('live', IP, 'viewer')
    expect(await authorizeGuest(req(), 'live')).toEqual({ user, ip: IP, ponyKey: IP })
  })

  it('keys Discord viewers by name on public streams', async () => {
    setPathVisibility('live', 'public')
    const user = discord()
    mockAuth.mockResolvedValue({ user })
    expect(await authorizeGuest(req(), 'live')).toEqual({
      user,
      ip: IP,
      ponyKey: 'discord:Luna',
    })
  })

  it('answers 400 for viewers with no pony identity', async () => {
    mockAuth.mockResolvedValue({ user: streamer })
    const res = (await authorizeGuest(req(), 'live')) as Response
    expect(res.status).toBe(400)

    setPathVisibility('live', 'private')
    approveAccess('live', 'discord:42', 'discord')
    mockAuth.mockResolvedValue({ user: discord() })
    expect(((await authorizeGuest(req(), 'live')) as Response).status).toBe(400)
  })
})
