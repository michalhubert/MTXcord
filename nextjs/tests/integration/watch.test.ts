import { describe, expect, it, vi } from 'vitest'
import {
  GET,
  POST as reactionPost,
} from '@/app/api/watch/[path]/route'
import { POST as leavePost } from '@/app/api/watch/[path]/leave/route'
import { kickViewer } from '@/lib/accessBlocks'
import {
  approveAccess,
  denyAccess,
  listPendingRequests,
  isApproved,
} from '@/lib/accessRequests'
import { rotateViewerPassword, setPathVisibility } from '@/lib/db'
import { notifyChanged } from '@/lib/events'
import type { WatchEvent } from '@/lib/watchRoomShared'
import { useFakeClock } from '../helpers/clock'
import { useFakeDerpibooru, useFakeMediamtx } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, asTrusted, signedOut } from '../helpers/session'
import { trustNetworks } from '../helpers/trust'
import { GUEST_IP, OTHER_IP, goLive, openStream } from './_support'

type StateEvent = Extract<WatchEvent, { type: 'state' }>

const isState = (e: WatchEvent): e is StateEvent => e.type === 'state'
const stateWith =
  (status: string) =>
  (e: WatchEvent): boolean =>
    isState(e) && e.access.status === status

const connect = (
  path: string,
  opts: { gate?: boolean; ip?: string } = {},
) =>
  openStream((signal) =>
    GET(
      nextRequest(`/api/watch/${path}${opts.gate ? '?mode=gate' : ''}`, {
        ip: opts.ip ?? GUEST_IP,
        signal,
      }),
      routeParams(path),
    ),
  )

describe('GET /api/watch/[path] (SSE)', () => {
  describe('guards', () => {
    it('404 for an invalid path name (checked before auth)', async () => {
      useFakeMediamtx()
      signedOut()
      const res = await GET(nextRequest('/api/watch/a.b'), routeParams('a.b'))
      expect(res.status).toBe(404)
    })

    it('401 when signed out', async () => {
      useFakeMediamtx()
      signedOut()
      const res = await GET(nextRequest('/api/watch/cam'), routeParams('cam'))
      expect(res.status).toBe(401)
    })

    it('opens an event stream for a signed-in user', async () => {
      useFakeMediamtx()
      asStreamer()
      const { res } = await connect('cam')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
    })
  })

  describe('normal (player) mode', () => {
    it('sends connected, state ok/online, hello and presence on a public live path', async () => {
      useFakeDerpibooru()
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam')
      await sse.waitFor((e) => e.type === 'presence')

      const types = sse.events.map((e) => e.type)
      expect(types.slice(0, 2)).toEqual(['connected', 'state'])
      expect(types).toContain('hello')
      const connected = sse.events[0] as Extract<WatchEvent, { type: 'connected' }>
      expect(connected.connectionId).toEqual(expect.any(String))

      const state = sse.events.find(isState)!
      expect(state.access).toEqual({ status: 'ok' })
      expect(state.online).toBe(true)

      const hello = sse.events.find((e) => e.type === 'hello') as Extract<
        WatchEvent,
        { type: 'hello' }
      >
      expect(hello.self.role).toBe('viewer')
      expect(hello.self.name).toEqual(expect.any(String))
      expect(hello.guest).toMatchObject({ kept: false, favoriteTag: null })

      const presence = sse.events.find((e) => e.type === 'presence') as Extract<
        WatchEvent,
        { type: 'presence' }
      >
      expect(presence.viewers.map((v) => v.id)).toEqual([hello.self.id])
    })

    it('reports an offline stream as online:false', async () => {
      useFakeDerpibooru()
      useFakeMediamtx()
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam')
      await sse.waitFor(isState)

      expect(sse.events.find(isState)).toMatchObject({
        access: { status: 'ok' },
        online: false,
      })
    })

    it('lists the streamer first and de-duplicates several tabs of one viewer', async () => {
      useFakeDerpibooru()
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')

      asStreamer()
      const streamer = await connect('cam')
      await streamer.sse.waitFor((e) => e.type === 'presence')

      asGuest(rotateViewerPassword('default'))
      await connect('cam', { ip: GUEST_IP })
      const second = await connect('cam', { ip: GUEST_IP })

      const roles = (e: WatchEvent) =>
        e.type === 'presence' ? e.viewers.map((v) => v.role) : null
      await streamer.sse.waitFor((e) => roles(e)?.length === 2)
      await second.sse.waitFor((e) => e.type === 'presence')
      // Two tabs from one address are still one viewer.
      const presences = streamer.sse.events.filter((e) => e.type === 'presence')
      expect(roles(presences.at(-1)!)).toEqual(['streamer', 'viewer'])
    })

    it('pushes pending when the path turns private, then ok again when approved', async () => {
      useFakeDerpibooru()
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam')
      await sse.waitFor(stateWith('ok'))

      setPathVisibility('cam', 'private')
      notifyChanged('cam')
      await sse.waitFor(stateWith('pending'))

      approveAccess('cam', GUEST_IP, 'viewer')
      await sse.waitFor(stateWith('ok'))
      // A player-mode connection never creates an access request.
      expect(listPendingRequests()).toEqual([])
    })

    it('reports a stale viewer password as unauthorized', async () => {
      useFakeMediamtx()
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))
      rotateViewerPassword('default')

      const { sse } = await connect('cam')
      await sse.waitFor(isState)

      expect(sse.events.find(isState)?.access).toEqual({ status: 'unauthorized' })
    })

    it('does not send a hello for a viewer who is not allowed in', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam')
      await sse.waitFor(stateWith('pending'))

      expect(sse.events.map((e) => e.type)).toEqual(['connected', 'state'])
    })
  })

  describe('gate mode (waiting screen)', () => {
    it('on a private live path sends pending and files an access request with the client IP', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))

      expect(sse.events.find(isState)).toMatchObject({
        access: { status: 'pending' },
        online: true,
      })
      expect(listPendingRequests()).toMatchObject([
        { path: 'cam', ip: GUEST_IP, clientIp: GUEST_IP, role: 'viewer' },
      ])
      // The waiting screen never joins the viewer room.
      expect(sse.events.map((e) => e.type)).not.toContain('hello')
    })

    it('files Discord requests by account, with name and image', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asDiscord('42', 'Luna', 'https://cdn.discord.test/luna.png')

      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))

      expect(listPendingRequests()).toMatchObject([
        {
          path: 'cam',
          ip: 'discord:42',
          clientIp: GUEST_IP,
          role: 'discord',
          name: 'Luna',
          image: 'https://cdn.discord.test/luna.png',
        },
      ])
    })

    it('pushes ok when the streamer approves, and drops the request', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))
      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))

      approveAccess('cam', GUEST_IP, 'viewer')
      await sse.waitFor(stateWith('ok'))

      expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)
      expect(listPendingRequests()).toEqual([])
    })

    it('pushes blocked(denied) with the remaining time when the streamer denies', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))
      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))

      denyAccess('cam', GUEST_IP, 'viewer')
      await sse.waitFor(stateWith('blocked'))

      const blocked = sse.events.filter(isState).at(-1)!
      expect(blocked.access).toMatchObject({ status: 'blocked', reason: 'denied' })
      const remaining = (blocked.access as { remainingMs: number }).remainingMs
      expect(remaining).toBeGreaterThan(55_000)
      expect(remaining).toBeLessThanOrEqual(60_000)
      expect(listPendingRequests()).toEqual([])
    })

    it('pushes blocked(kicked) when an approved viewer is kicked', async () => {
      const fake = useFakeMediamtx()
      // Going live wipes approvals, so the stream must be live before approving.
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))
      approveAccess('cam', GUEST_IP, 'viewer')
      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('ok'))

      kickViewer('cam', { role: 'viewer', ip: GUEST_IP })
      const events = await sse.waitFor(stateWith('blocked'))

      expect(events.filter(isState).at(-1)!.access).toMatchObject({
        status: 'blocked',
        reason: 'kicked',
      })
    })

    it('returns to pending (and re-files the request) once a block expires', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))
      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))

      useFakeClock()
      denyAccess('cam', GUEST_IP, 'viewer')
      await sse.waitFor(stateWith('blocked'))
      expect(listPendingRequests()).toEqual([])

      await vi.advanceTimersByTimeAsync(61_000)
      await sse.waitFor(
        (e, all) => stateWith('pending')(e) && all.filter(stateWith('pending')).length === 2,
      )

      expect(listPendingRequests()).toMatchObject([{ path: 'cam', ip: GUEST_IP }])
    })

    it('removes the access request when the connection is aborted', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))
      const { sse, abort } = await connect('cam', { gate: true })
      await sse.waitFor(stateWith('pending'))
      expect(listPendingRequests()).toHaveLength(1)

      abort()

      expect(listPendingRequests()).toEqual([])
    })

    it('keeps the request while one of two tabs of the same viewer remains', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      asGuest(rotateViewerPassword('default'))
      const first = await connect('cam', { gate: true })
      const second = await connect('cam', { gate: true })
      await first.sse.waitFor(stateWith('pending'))
      await second.sse.waitFor(stateWith('pending'))

      first.abort()
      expect(listPendingRequests()).toHaveLength(1)

      second.abort()
      expect(listPendingRequests()).toEqual([])
    })

    it('on an offline private path reports online:false and files no request', async () => {
      useFakeMediamtx()
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(isState)

      expect(sse.events.find(isState)).toMatchObject({
        access: { status: 'pending' },
        online: false,
      })
      expect(listPendingRequests()).toEqual([])
    })

    it('files the request once the stream goes live', async () => {
      const fake = useFakeMediamtx()
      asGuest(rotateViewerPassword('default'))
      const { sse } = await connect('cam', { gate: true })
      await sse.waitFor(isState)
      expect(listPendingRequests()).toEqual([])

      goLive(fake, 'cam')
      await sse.waitFor((e) => isState(e) && e.online)

      expect(listPendingRequests()).toHaveLength(1)
    })

    it('on a public path answers ok straight away and files no request', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { sse } = await connect('cam', { gate: true, ip: OTHER_IP })
      await sse.waitFor(isState)

      expect(sse.events.find(isState)?.access).toEqual({ status: 'ok' })
      expect(listPendingRequests()).toEqual([])
    })
  })
})

describe('trusted-network viewers', () => {
  const TRUSTED_IP = '10.250.0.5'
  const trustedNetworks = () => trustNetworks('10.250.0.0/16')

  it('join a public live path from a trusted IP without any password', async () => {
    useFakeDerpibooru()
    const fake = useFakeMediamtx()
    fake.setReady('cam', true)
    setPathVisibility('cam', 'public')
    trustedNetworks()
    asTrusted()

    const { sse } = await connect('cam', { ip: TRUSTED_IP })
    await sse.waitFor((e) => e.type === 'presence')

    expect(sse.events.find(isState)?.access).toEqual({ status: 'ok' })
    const hello = sse.events.find((e) => e.type === 'hello') as Extract<
      WatchEvent,
      { type: 'hello' }
    >
    expect(hello.self.role).toBe('viewer')
    expect(hello.self.name).toEqual(expect.any(String))
  })

  it('wait on a private path, filing a request keyed by IP, until approved', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('cam', true)
    trustedNetworks()
    asTrusted()

    const { sse } = await connect('cam', { gate: true, ip: TRUSTED_IP })
    await sse.waitFor(stateWith('pending'))
    expect(listPendingRequests()).toMatchObject([
      { path: 'cam', ip: TRUSTED_IP, role: 'viewer' },
    ])

    approveAccess('cam', TRUSTED_IP, 'viewer')
    await sse.waitFor(stateWith('ok'))
    expect(listPendingRequests()).toEqual([])
  })

  it('are told their session is unauthorized from an IP outside the trusted networks', async () => {
    useFakeMediamtx()
    setPathVisibility('cam', 'public')
    trustedNetworks()
    asTrusted()

    const { sse } = await connect('cam', { ip: GUEST_IP })
    await sse.waitFor(isState)

    expect(sse.events.find(isState)?.access).toEqual({ status: 'unauthorized' })
  })

  it('cannot react from outside the trusted networks (401), but can from inside', async () => {
    useFakeDerpibooru()
    useFakeMediamtx()
    setPathVisibility('cam', 'public')
    trustedNetworks()
    asTrusted()
    const react = (ip: string) =>
      reactionPost(
        nextRequest('/api/watch/cam', { json: { emoji: '🔥' }, ip }),
        routeParams('cam'),
      )

    expect((await react(GUEST_IP)).status).toBe(401)
    expect((await react(TRUSTED_IP)).status).toBe(204)
  })
})

describe('POST /api/watch/[path] (reactions)', () => {
  const react = (path: string, body: unknown, ip: string = GUEST_IP) =>
    reactionPost(
      nextRequest(`/api/watch/${path}`, { json: body, ip }),
      routeParams(path),
    )

  it('404 for an invalid path', async () => {
    asStreamer()
    expect((await react('a.b', { emoji: '🔥' })).status).toBe(404)
  })

  it('401 when signed out', async () => {
    signedOut()
    expect((await react('cam', { emoji: '🔥' })).status).toBe(401)
  })

  it('401 for a stale viewer password', async () => {
    asGuest(rotateViewerPassword('default'))
    rotateViewerPassword('default')
    expect((await react('cam', { emoji: '🔥' })).status).toBe(401)
  })

  it('403 for an unapproved viewer on a private path', async () => {
    asGuest(rotateViewerPassword('default'))
    expect((await react('cam', { emoji: '🔥' })).status).toBe(403)
  })

  it('403 for a kicked viewer', async () => {
    useFakeDerpibooru()
    setPathVisibility('cam', 'public')
    asGuest(rotateViewerPassword('default'))
    kickViewer('cam', { role: 'viewer', ip: GUEST_IP })
    expect((await react('cam', { emoji: '🔥' })).status).toBe(403)
  })

  it('400 for an unknown emoji, a missing emoji and a body that is not JSON', async () => {
    asStreamer()
    expect((await react('cam', { emoji: '🍕' })).status).toBe(400)
    expect((await react('cam', {})).status).toBe(400)
    expect((await react('cam', { emoji: 5 })).status).toBe(400)
    const res = await reactionPost(
      nextRequest('/api/watch/cam', { body: 'nope' }),
      routeParams('cam'),
    )
    expect(res.status).toBe(400)
  })

  it('204 for a valid reaction', async () => {
    asStreamer()
    expect((await react('cam', { emoji: '🔥' })).status).toBe(204)
  })

  it('allows 6 reactions in 3 seconds and rejects the 7th with 429', async () => {
    useFakeClock()
    asStreamer()

    for (let i = 0; i < 6; i++) {
      expect((await react('cam', { emoji: '❤️' })).status).toBe(204)
    }
    expect((await react('cam', { emoji: '❤️' })).status).toBe(429)
  })

  it('accepts reactions again once the window has passed', async () => {
    useFakeClock()
    asStreamer()
    for (let i = 0; i < 6; i++) await react('cam', { emoji: '❤️' })
    expect((await react('cam', { emoji: '❤️' })).status).toBe(429)

    await vi.advanceTimersByTimeAsync(3_001)

    expect((await react('cam', { emoji: '❤️' })).status).toBe(204)
  })

  it('rate limits per viewer', async () => {
    useFakeClock()
    useFakeDerpibooru()
    setPathVisibility('cam', 'public')
    asGuest(rotateViewerPassword('default'))
    for (let i = 0; i < 7; i++) await react('cam', { emoji: '🎉' }, GUEST_IP)

    expect((await react('cam', { emoji: '🎉' }, GUEST_IP)).status).toBe(429)
    expect((await react('cam', { emoji: '🎉' }, OTHER_IP)).status).toBe(204)
  })

  it('broadcasts to the room, except to the sender\'s own connection', async () => {
    useFakeDerpibooru()
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    setPathVisibility('cam', 'public')

    asStreamer()
    const watcher = await connect('cam')
    await watcher.sse.waitFor((e) => e.type === 'presence')
    const watcherId = (
      watcher.sse.events[0] as Extract<WatchEvent, { type: 'connected' }>
    ).connectionId

    asGuest(rotateViewerPassword('default'))
    const sender = await connect('cam', { ip: OTHER_IP })
    await sender.sse.waitFor((e) => e.type === 'hello')
    const senderId = (
      sender.sse.events[0] as Extract<WatchEvent, { type: 'connected' }>
    ).connectionId
    await watcher.sse.waitFor((e) => e.type === 'presence' && e.viewers.length === 2)

    const res = await reactionPost(
      nextRequest('/api/watch/cam', {
        json: { emoji: '🔥', connectionId: senderId },
        ip: OTHER_IP,
      }),
      routeParams('cam'),
    )
    expect(res.status).toBe(204)

    await watcher.sse.waitFor((e) => e.type === 'reaction')
    const reaction = watcher.sse.events.find(
      (e): e is Extract<WatchEvent, { type: 'reaction' }> => e.type === 'reaction',
    )!
    expect(reaction.emoji).toBe('🔥')
    expect(reaction.from.role).toBe('viewer')

    // The sender's own connection got no echo.
    const before = sender.sse.events.filter((e) => e.type === 'reaction').length
    expect(before).toBe(0)

    // The streamer reacts naming its own connection: the guest hears it, the streamer does not.
    asStreamer()
    await react('cam', { emoji: '👏', connectionId: watcherId }, GUEST_IP)
    await sender.sse.waitFor((e) => e.type === 'reaction')
    expect(
      watcher.sse.events.filter((e) => e.type === 'reaction'),
    ).toHaveLength(1)
  })
})

describe('POST /api/watch/[path]/leave', () => {
  const leave = (path: string, body: unknown) =>
    leavePost(
      nextRequest(`/api/watch/${path}/leave`, { json: body }),
      routeParams(path),
    )

  it('400 without a connectionId', async () => {
    expect((await leave('cam', {})).status).toBe(400)
    expect((await leave('cam', { connectionId: 1 })).status).toBe(400)
    const res = await leavePost(
      nextRequest('/api/watch/cam/leave', { body: 'x' }),
      routeParams('cam'),
    )
    expect(res.status).toBe(400)
  })

  it('204 for an unknown connection', async () => {
    expect((await leave('cam', { connectionId: 'nope' })).status).toBe(204)
  })

  it('closes the matching event stream', async () => {
    useFakeMediamtx()
    asStreamer()
    const { sse } = await connect('cam')
    await sse.waitFor((e) => e.type === 'state')
    const { connectionId } = sse.events[0] as Extract<
      WatchEvent,
      { type: 'connected' }
    >

    expect((await leave('cam', { connectionId })).status).toBe(204)

    await expect(sse.waitFor(() => false)).rejects.toThrow(/ended/)
  })

  it('leaves the stream open when the path does not match', async () => {
    useFakeMediamtx()
    asStreamer()
    const { sse } = await connect('cam')
    await sse.waitFor((e) => e.type === 'state')
    const { connectionId } = sse.events[0] as Extract<
      WatchEvent,
      { type: 'connected' }
    >

    expect((await leave('other', { connectionId })).status).toBe(204)

    await expect(sse.waitFor(() => false, { timeoutMs: 150 })).rejects.toThrow(
      /Timed out/,
    )
  })

  it('removes the gate request of the closed connection', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('cam', true)
    asGuest(rotateViewerPassword('default'))
    const { sse } = await connect('cam', { gate: true })
    await sse.waitFor(stateWith('pending'))
    const { connectionId } = sse.events[0] as Extract<
      WatchEvent,
      { type: 'connected' }
    >
    expect(listPendingRequests()).toHaveLength(1)

    await leave('cam', { connectionId })

    expect(listPendingRequests()).toEqual([])
  })
})
