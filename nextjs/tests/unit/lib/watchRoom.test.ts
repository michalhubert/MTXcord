import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  allowReaction,
  broadcastWatchEvent,
  closeWatchConnection,
  joinWatchRoom,
  leaveWatchRoom,
  registerWatchConnection,
  watchViewerFor,
  type WatchClient,
} from '@/lib/watchRoom'
import type { WatchEvent, WatchViewer } from '@/lib/watchRoomShared'
import { setPathVisibility } from '@/lib/db'
import { useFakeDerpibooru } from '../../helpers/msw'
import { useFakeClock } from '../../helpers/clock'

function client(
  connectionId: string,
  viewer: Partial<WatchViewer> & { id: string; name: string },
): WatchClient & { send: Mock<(event: WatchEvent) => void> } {
  return {
    connectionId,
    viewer: { image: null, role: 'viewer', ...viewer },
    ip: '1.1.1.1',
    role: viewer.role ?? 'viewer',
    ponyKey: null,
    send: vi.fn<(event: WatchEvent) => void>(),
  }
}

const lastPresence = (c: { send: { mock: { calls: unknown[][] } } }): string[] => {
  const events = c.send.mock.calls.map((call) => call[0] as WatchEvent)
  const presence = events.filter((e) => e.type === 'presence').at(-1)
  if (!presence || presence.type !== 'presence') throw new Error('no presence event')
  return presence.viewers.map((v) => v.name)
}

describe('presence', () => {
  it('broadcasts the viewer list to everyone in the room on join', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    const b = client('c2', { id: 'b', name: 'Bob' })
    joinWatchRoom('live', a)
    expect(lastPresence(a)).toEqual(['Alice'])
    joinWatchRoom('live', b)
    expect(lastPresence(a)).toEqual(['Alice', 'Bob'])
    expect(lastPresence(b)).toEqual(['Alice', 'Bob'])
  })

  it('lists several tabs of one viewer once', () => {
    const a1 = client('c1', { id: 'a', name: 'Alice' })
    const a2 = client('c2', { id: 'a', name: 'Alice' })
    joinWatchRoom('live', a1)
    joinWatchRoom('live', a2)
    expect(lastPresence(a1)).toEqual(['Alice'])
  })

  it('puts the streamer first, then sorts by name', () => {
    joinWatchRoom('live', client('c1', { id: 'z', name: 'Zed' }))
    joinWatchRoom('live', client('c2', { id: 'b', name: 'Bob' }))
    const streamer = client('c3', { id: 's', name: 'Zzz Streamer', role: 'streamer' })
    joinWatchRoom('live', streamer)
    joinWatchRoom('live', client('c4', { id: 'a', name: 'alice' }))
    expect(lastPresence(streamer)).toEqual(['Zzz Streamer', 'alice', 'Bob', 'Zed'])
  })

  it('keeps rooms per path', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    const b = client('c2', { id: 'b', name: 'Bob' })
    joinWatchRoom('one', a)
    joinWatchRoom('two', b)
    expect(lastPresence(a)).toEqual(['Alice'])
    expect(lastPresence(b)).toEqual(['Bob'])
  })

  it('updates the others when a connection leaves', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    const b = client('c2', { id: 'b', name: 'Bob' })
    joinWatchRoom('live', a)
    joinWatchRoom('live', b)
    leaveWatchRoom('live', 'c2')
    expect(lastPresence(a)).toEqual(['Alice'])
  })

  it('does not broadcast for an unknown connection', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    joinWatchRoom('live', a)
    a.send.mockClear()
    leaveWatchRoom('live', 'nope')
    leaveWatchRoom('missing-room', 'c1')
    expect(a.send).not.toHaveBeenCalled()
  })

  it('deletes an empty room, so later joiners start fresh', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    joinWatchRoom('live', a)
    leaveWatchRoom('live', 'c1')
    const b = client('c2', { id: 'b', name: 'Bob' })
    joinWatchRoom('live', b)
    expect(lastPresence(b)).toEqual(['Bob'])
    expect(a.send).toHaveBeenCalledTimes(1) // only its own join
  })
})

describe('broadcastWatchEvent', () => {
  const reaction: WatchEvent = { type: 'connected', connectionId: 'x' }

  it('sends to all but the excluded connection', () => {
    const a = client('c1', { id: 'a', name: 'Alice' })
    const b = client('c2', { id: 'b', name: 'Bob' })
    joinWatchRoom('live', a)
    joinWatchRoom('live', b)
    a.send.mockClear()
    b.send.mockClear()
    broadcastWatchEvent('live', reaction, 'c1')
    expect(a.send).not.toHaveBeenCalled()
    expect(b.send).toHaveBeenCalledWith(reaction)
  })

  it('ignores unknown rooms', () => {
    expect(() => broadcastWatchEvent('nobody', reaction)).not.toThrow()
  })
})

describe('watch connections', () => {
  it('closes a registered connection only for its own path', () => {
    const close = vi.fn()
    registerWatchConnection('live', 'c1', close)
    closeWatchConnection('other', 'c1')
    closeWatchConnection('live', 'unknown')
    expect(close).not.toHaveBeenCalled()
    closeWatchConnection('live', 'c1')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does nothing after unregistering', () => {
    const close = vi.fn()
    const unregister = registerWatchConnection('live', 'c1', close)
    unregister()
    closeWatchConnection('live', 'c1')
    expect(close).not.toHaveBeenCalled()
  })
})

describe('allowReaction', () => {
  it('allows 6 reactions per 3 seconds per viewer', () => {
    useFakeClock()
    for (let i = 0; i < 6; i++) expect(allowReaction('v1')).toBe(true)
    expect(allowReaction('v1')).toBe(false)
    expect(allowReaction('v2')).toBe(true)
  })

  it('slides the window', () => {
    useFakeClock()
    // Reactions at t=0, 1000 and 2000, then three more at t=2000.
    for (let t = 0; t <= 2000; t += 1000) {
      expect(allowReaction('v1')).toBe(true)
      if (t < 2000) vi.advanceTimersByTime(1000)
    }
    for (let i = 0; i < 3; i++) expect(allowReaction('v1')).toBe(true)
    expect(allowReaction('v1')).toBe(false)
    vi.advanceTimersByTime(999)
    expect(allowReaction('v1')).toBe(false)
    // t=3000: the reaction from t=0 has left the window.
    vi.advanceTimersByTime(1)
    expect(allowReaction('v1')).toBe(true)
    expect(allowReaction('v1')).toBe(false)
  })

  it('does not count rejected reactions against the viewer', () => {
    useFakeClock()
    for (let i = 0; i < 6; i++) allowReaction('v1')
    vi.advanceTimersByTime(1500)
    for (let i = 0; i < 10; i++) expect(allowReaction('v1')).toBe(false)
    vi.advanceTimersByTime(1501)
    expect(allowReaction('v1')).toBe(true)
  })
})

describe('watchViewerFor', () => {
  const IP = '203.0.113.10'

  it('describes the streamer without a guest identity', async () => {
    const res = await watchViewerFor(
      { id: 'streamer', name: null, image: null, role: 'streamer' },
      IP,
      'live',
    )
    expect(res.viewer).toMatchObject({ name: 'Streamer', image: null, role: 'streamer' })
    expect(res.viewer.id).toMatch(/^[0-9a-f]{12}$/)
    expect(res.guest).toBeNull()
    expect(res.ponyKey).toBeNull()
  })

  it('shows Discord viewers on private streams under their own identity', async () => {
    const user = {
      id: '42',
      name: 'Luna',
      image: 'https://cdn.discordapp.com/a.png',
      role: 'discord' as const,
    }
    const res = await watchViewerFor(user, IP, 'live')
    expect(res.viewer).toMatchObject({
      name: 'Luna',
      image: 'https://cdn.discordapp.com/a.png',
      role: 'discord',
    })
    expect(res.guest).toBeNull()
    expect(res.ponyKey).toBeNull()
    // Stable across calls and IPs, since it is keyed by account name.
    const again = await watchViewerFor(user, '198.51.100.7', 'live')
    expect(again.viewer.id).toBe(res.viewer.id)
  })

  it('gives password viewers a pony, with an id per IP', async () => {
    useFakeDerpibooru()
    const user = {
      id: 'viewer',
      name: null,
      image: null,
      role: 'viewer' as const,
      password: 'pw',
    }
    const a = await watchViewerFor(user, IP, 'live')
    expect(a.ponyKey).toBe(IP)
    expect(a.viewer.name).not.toBe('Guest')
    expect(a.viewer.image).toMatch(/^https:\/\/cdn\.booru\.test\//)
    expect(a.guest).toEqual({ kept: false, favoriteTag: null, rerollInMs: 0 })

    const sameIp = await watchViewerFor(user, IP, 'live')
    expect(sameIp.viewer).toEqual(a.viewer)
    const otherIp = await watchViewerFor(user, '198.51.100.7', 'live')
    expect(otherIp.viewer.id).not.toBe(a.viewer.id)
  })

  it('gives Discord viewers a pony on public streams', async () => {
    useFakeDerpibooru()
    setPathVisibility('live', 'public')
    const res = await watchViewerFor(
      { id: '42', name: 'Luna', image: null, role: 'discord' },
      IP,
      'live',
    )
    expect(res.ponyKey).toBe('discord:Luna')
    expect(res.guest).not.toBeNull()
  })
})
