import { describe, expect, it, vi } from 'vitest'
import {
  approveAccess,
  approvalKey,
  clearApprovedPasswordViewers,
  clearApprovedViewers,
  clearPendingRequests,
  closeAccessRequest,
  denyAccess,
  isApproved,
  keepAccessRequest,
  listPendingRequests,
  openAccessRequest,
  revokeApproval,
  usesPasswordOf,
  type AccessRequester,
} from '@/lib/accessRequests'
import { getBlock } from '@/lib/accessBlocks'
import { ALL_PATHS, onChanged } from '@/lib/events'
import { approveViewer, setViewerPassword } from '@/lib/db'
import { flushNotifications, useFakeClock } from '../../helpers/clock'

const guest = (over: Partial<AccessRequester> = {}): AccessRequester => ({
  path: 'live',
  ip: '1.1.1.1',
  role: 'viewer',
  name: null,
  image: null,
  discordId: null,
  clientIp: '1.1.1.1',
  ...over,
})

const discord = (over: Partial<AccessRequester> = {}): AccessRequester =>
  guest({
    ip: 'discord:42',
    role: 'discord',
    name: 'Luna',
    image: 'https://img/x.png',
    discordId: '42',
    clientIp: '9.9.9.9',
    ...over,
  })

describe('approvalKey', () => {
  it('keys Discord viewers by account and everyone else by IP', () => {
    expect(approvalKey('discord', '1.1.1.1', '42')).toBe('discord:42')
    expect(approvalKey('discord', '1.1.1.1', null)).toBe('1.1.1.1')
    expect(approvalKey('discord', '1.1.1.1')).toBe('1.1.1.1')
    expect(approvalKey('viewer', '1.1.1.1', '42')).toBe('1.1.1.1')
    expect(approvalKey(undefined, '1.1.1.1')).toBe('1.1.1.1')
  })
})

describe('open / keep / close', () => {
  it('lists an opened request with its details', () => {
    useFakeClock()
    openAccessRequest(discord())
    expect(listPendingRequests()).toEqual([
      {
        ip: 'discord:42',
        clientIp: '9.9.9.9',
        path: 'live',
        name: 'Luna',
        image: 'https://img/x.png',
        role: 'discord',
        requestedAt: Date.now(),
      },
    ])
  })

  it('treats a missing role as guest', () => {
    openAccessRequest(guest({ role: undefined }))
    expect(listPendingRequests()[0].role).toBe('guest')
  })

  it('reference-counts open tabs: the row goes away when the last one closes', () => {
    openAccessRequest(guest())
    openAccessRequest(guest())
    closeAccessRequest(guest())
    expect(listPendingRequests()).toHaveLength(1)
    closeAccessRequest(guest())
    expect(listPendingRequests()).toHaveLength(0)
  })

  it('counts requests per path, ip and role separately', () => {
    openAccessRequest(guest())
    openAccessRequest(guest({ path: 'other' }))
    closeAccessRequest(guest())
    expect(listPendingRequests().map((r) => r.path)).toEqual(['other'])
  })

  it('closing an unknown request is harmless', () => {
    expect(() => closeAccessRequest(guest())).not.toThrow()
  })

  it('keepAccessRequest only refreshes an existing request', () => {
    useFakeClock()
    keepAccessRequest(guest())
    expect(listPendingRequests()).toEqual([])

    openAccessRequest(guest())
    vi.advanceTimersByTime(40_000)
    keepAccessRequest(guest())
    vi.advanceTimersByTime(40_000)
    // 80s since opened, but only 40s since the last keep.
    expect(listPendingRequests()).toHaveLength(1)
  })

  it('keepAccessRequest does not bring back an answered request', () => {
    openAccessRequest(guest())
    approveAccess('live', '1.1.1.1', 'viewer')
    keepAccessRequest(guest())
    expect(listPendingRequests()).toEqual([])
  })

  it('drops requests not seen for 45 seconds', () => {
    useFakeClock()
    openAccessRequest(guest())
    vi.advanceTimersByTime(44_000)
    expect(listPendingRequests()).toHaveLength(1)
    vi.advanceTimersByTime(2_000)
    expect(listPendingRequests()).toHaveLength(0)
  })

  it('lists requests oldest first', () => {
    useFakeClock()
    openAccessRequest(guest({ ip: '2.2.2.2' }))
    vi.advanceTimersByTime(1000)
    openAccessRequest(guest({ ip: '1.1.1.1' }))
    expect(listPendingRequests().map((r) => r.ip)).toEqual(['2.2.2.2', '1.1.1.1'])
  })

  it('notifies only when a request is new or removed', async () => {
    // Drain flushes scheduled by earlier tests (resetServerState does not cancel them).
    await flushNotifications()
    const listener = vi.fn()
    onChanged(listener)
    openAccessRequest(guest())
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual(new Set(['live']))

    openAccessRequest(guest())
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)

    closeAccessRequest(guest())
    closeAccessRequest(guest())
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('approve / deny / revoke', () => {
  it('approveAccess approves, removes the request and clears a block', () => {
    openAccessRequest(guest())
    denyAccess('live', '1.1.1.1', 'viewer')
    expect(getBlock('live', { role: 'viewer', ip: '1.1.1.1' })).not.toBeNull()

    openAccessRequest(guest())
    approveAccess('live', '1.1.1.1', 'viewer')
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(true)
    expect(listPendingRequests()).toEqual([])
    expect(getBlock('live', { role: 'viewer', ip: '1.1.1.1' })).toBeNull()
  })

  it('approves and clears blocks of Discord viewers by account', () => {
    openAccessRequest(discord())
    denyAccess('live', 'discord:42', 'discord')
    expect(getBlock('live', { role: 'discord', discordId: '42' })).not.toBeNull()

    openAccessRequest(discord())
    approveAccess('live', 'discord:42', 'discord')
    expect(isApproved('live', 'discord:42', 'discord')).toBe(true)
    expect(getBlock('live', { role: 'discord', discordId: '42' })).toBeNull()
  })

  it('denyAccess blocks, removes the request and revokes an approval', () => {
    approveViewer('live', '1.1.1.1', 'viewer')
    openAccessRequest(guest())
    denyAccess('live', '1.1.1.1', 'viewer')
    expect(listPendingRequests()).toEqual([])
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(false)
    expect(getBlock('live', { role: 'viewer', ip: '1.1.1.1' })?.reason).toBe('denied')
  })

  it('denyAccess blocks a Discord viewer by account', () => {
    openAccessRequest(discord())
    denyAccess('live', 'discord:42', 'discord')
    expect(getBlock('live', { role: 'discord', discordId: '42' })?.reason).toBe('denied')
    // Not blocked by the IP they happen to be using.
    expect(getBlock('live', { role: 'viewer', ip: '9.9.9.9' })).toBeNull()
  })

  it('keeps approvals separate per role', () => {
    approveAccess('live', '1.1.1.1', 'viewer')
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(true)
    expect(isApproved('live', '1.1.1.1', 'discord')).toBe(false)
    expect(isApproved('live', '1.1.1.1')).toBe(false) // guest role
  })

  it('revokeApproval removes just that approval', () => {
    approveViewer('live', '1.1.1.1', 'viewer')
    approveViewer('live', '2.2.2.2', 'viewer')
    revokeApproval('live', '1.1.1.1', 'viewer')
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(false)
    expect(isApproved('live', '2.2.2.2', 'viewer')).toBe(true)
  })

  it('clearApprovedViewers and clearPendingRequests work per path', () => {
    approveViewer('a', '1.1.1.1', 'viewer')
    approveViewer('b', '1.1.1.1', 'viewer')
    openAccessRequest(guest({ path: 'a' }))
    openAccessRequest(guest({ path: 'b' }))
    clearApprovedViewers('a')
    clearPendingRequests('a')
    expect(isApproved('a', '1.1.1.1', 'viewer')).toBe(false)
    expect(isApproved('b', '1.1.1.1', 'viewer')).toBe(true)
    expect(listPendingRequests().map((r) => r.path)).toEqual(['b'])
  })
})

describe('usesPasswordOf', () => {
  it('matches the rotated path itself', () => {
    expect(usesPasswordOf('a', 'a')).toBe(true)
    expect(usesPasswordOf('a', 'b')).toBe(false)
  })

  it('lets paths without their own password follow the default', () => {
    setViewerPassword('own', 'x')
    expect(usesPasswordOf('inherits', 'default')).toBe(true)
    expect(usesPasswordOf('own', 'default')).toBe(false)
    expect(usesPasswordOf('inherits', 'other')).toBe(false)
  })
})

describe('clearApprovedPasswordViewers', () => {
  it('drops password viewers on affected paths and keeps Discord viewers', async () => {
    setViewerPassword('own', 'x')
    approveViewer('a', '1.1.1.1', 'viewer')
    approveViewer('a', 'discord:42', 'discord')
    approveViewer('own', '1.1.1.1', 'viewer')
    approveViewer('b', '1.1.1.1', 'viewer')

    await flushNotifications()
    const listener = vi.fn()
    onChanged(listener)
    clearApprovedPasswordViewers('a')
    expect(isApproved('a', '1.1.1.1', 'viewer')).toBe(false)
    expect(isApproved('a', 'discord:42', 'discord')).toBe(true)
    expect(isApproved('b', '1.1.1.1', 'viewer')).toBe(true)

    await flushNotifications()
    expect(listener.mock.calls[0][0].has(ALL_PATHS)).toBe(true)
  })

  it('rotating the default also clears paths that inherit it', () => {
    setViewerPassword('own', 'x')
    approveViewer('inherits', '1.1.1.1', 'viewer')
    approveViewer('own', '1.1.1.1', 'viewer')
    approveViewer('inherits', 'discord:42', 'discord')
    clearApprovedPasswordViewers('default')
    expect(isApproved('inherits', '1.1.1.1', 'viewer')).toBe(false)
    expect(isApproved('own', '1.1.1.1', 'viewer')).toBe(true)
    expect(isApproved('inherits', 'discord:42', 'discord')).toBe(true)
  })
})
