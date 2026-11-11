import { describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/dock/events/route'
import { approveAccess, openAccessRequest } from '@/lib/accessRequests'
import { rotateViewerPassword, setPathVisibility } from '@/lib/db'
import { notifyChanged } from '@/lib/events'
import type { DockSnapshot } from '@/lib/dockSnapshot'
import { useFakeDerpibooru, useFakeMediamtx } from '../helpers/msw'
import { nextRequest } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import { GUEST_IP, OTHER_IP, goLive, openStream, whep } from './_support'

type DockEvent = { type: 'snapshot'; snapshot: DockSnapshot }

const connect = () =>
  openStream<DockEvent>((signal) => GET(nextRequest('/api/dock/events', { signal })))

async function firstSnapshot(): Promise<DockSnapshot> {
  const { sse } = await connect()
  await sse.waitFor((e) => e.type === 'snapshot')
  return sse.events[0].snapshot
}

describe('GET /api/dock/events', () => {
  describe('authorization', () => {
    it.each([
      ['signed out', () => signedOut()],
      ['a guest', () => asGuest('pw')],
      ['a Discord viewer', () => asDiscord('42', 'Luna')],
    ])('401 for %s', async (_label, signIn) => {
      useFakeMediamtx()
      signIn()
      const res = await GET(nextRequest('/api/dock/events'))
      expect(res.status).toBe(401)
    })

    it('streams for the streamer', async () => {
      useFakeMediamtx()
      asStreamer()
      const { res, sse } = await connect()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      // Wait for the first snapshot, so its MediaMTX calls don't outlive the test.
      await sse.waitFor((e) => e.type === 'snapshot')
    })

    it('streams without a session when DISABLE_DOCK_AUTH is true', async () => {
      useFakeMediamtx()
      vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
      signedOut()
      const { sse } = await connect()
      await sse.waitFor((e) => e.type === 'snapshot')
    })
  })

  describe('first snapshot', () => {
    it('is empty and reachable for an idle MediaMTX', async () => {
      useFakeMediamtx()
      asStreamer()

      expect(await firstSnapshot()).toEqual({
        mediamtxReachable: true,
        livePaths: [],
        viewers: [],
        pending: [],
        visibility: {},
        viewerPasswords: {},
      })
    })

    it('lists the ready paths MediaMTX reports as live', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('cam', true)
      fake.setReady('other', true)
      fake.addConfiguredPath('idle')
      asStreamer()

      const snapshot = await firstSnapshot()

      expect(snapshot.livePaths).toEqual(['cam', 'other'])
      expect(snapshot.mediamtxReachable).toBe(true)
    })

    it('reports mediamtxReachable:false with nothing live when MediaMTX is down', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      fake.setDown(true)
      asStreamer()

      const snapshot = await firstSnapshot()

      expect(snapshot.mediamtxReachable).toBe(false)
      expect(snapshot.livePaths).toEqual([])
      expect(snapshot.viewers).toEqual([])
    })

    it('includes viewer passwords only for live paths', async () => {
      const fake = useFakeMediamtx()
      fake.setReady('live1', true)
      fake.setReady('live2', true)
      fake.addConfiguredPath('idle')
      const live1 = rotateViewerPassword('live1')
      rotateViewerPassword('idle')
      rotateViewerPassword('default')
      asStreamer()

      const snapshot = await firstSnapshot()

      expect(snapshot.viewerPasswords).toEqual({ live1, live2: null })
    })

    it('includes path visibilities', async () => {
      useFakeMediamtx()
      setPathVisibility('cam', 'public')
      setPathVisibility('secret', 'private')
      asStreamer()

      expect((await firstSnapshot()).visibility).toEqual({
        cam: 'public',
        secret: 'private',
      })
    })

    it('includes pending access requests', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      openAccessRequest({
        path: 'cam',
        ip: GUEST_IP,
        role: 'viewer',
        name: null,
        image: null,
        discordId: null,
        clientIp: GUEST_IP,
      })
      asStreamer()

      expect((await firstSnapshot()).pending).toMatchObject([
        { path: 'cam', ip: GUEST_IP, clientIp: GUEST_IP, role: 'viewer' },
      ])
    })
  })

  describe('viewers', () => {
    it('lists established read sessions, with identity info for Discord viewers', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asDiscord('42', 'Luna', 'https://cdn.discord.test/luna.png')
      approveAccess('cam', 'discord:42', 'discord')
      const { id } = await whep('cam', GUEST_IP)
      asStreamer()

      const { viewers } = await firstSnapshot()

      expect(viewers).toEqual([
        {
          id,
          path: 'cam',
          name: 'Luna',
          image: 'https://cdn.discord.test/luna.png',
          role: 'discord',
          ip: GUEST_IP,
          hasPony: false,
          discordName: null,
          discordImage: null,
        },
      ])
    })

    it('shows a password guest as a pony, keeping their IP', async () => {
      useFakeDerpibooru()
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))
      const { id } = await whep('cam', GUEST_IP)
      asStreamer()

      const { viewers } = await firstSnapshot()

      expect(viewers).toHaveLength(1)
      expect(viewers[0]).toMatchObject({
        id,
        path: 'cam',
        role: 'viewer',
        ip: GUEST_IP,
        hasPony: true,
        discordName: null,
      })
      expect(viewers[0].name).toEqual(expect.any(String))
      expect(viewers[0].name).not.toBe(GUEST_IP)
    })

    it('keeps the Discord account visible behind a pony on a public path', async () => {
      useFakeDerpibooru()
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asDiscord('42', 'Luna', 'https://cdn.discord.test/luna.png')
      await whep('cam', GUEST_IP)
      asStreamer()

      const [viewer] = (await firstSnapshot()).viewers

      expect(viewer).toMatchObject({
        hasPony: true,
        role: 'discord',
        discordName: 'Luna',
        discordImage: 'https://cdn.discord.test/luna.png',
      })
      expect(viewer.name).not.toBe('Luna')
    })

    it('skips sessions that have not connected yet and publishers', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      const established = fake.addSession({ path: 'cam', state: 'read' })
      fake.addSession({ path: 'cam', state: 'read', peerConnectionEstablished: false })
      fake.addSession({ path: 'cam', state: 'publish' })
      asStreamer()

      const { viewers } = await firstSnapshot()

      expect(viewers.map((v) => v.id)).toEqual([established.id])
      expect(viewers[0]).toMatchObject({
        path: 'cam',
        name: null,
        role: null,
        ip: null,
        hasPony: false,
      })
    })

    it('lists several viewers across paths', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      goLive(fake, 'other')
      setPathVisibility('cam', 'public')
      setPathVisibility('other', 'public')
      asDiscord('42', 'Luna')
      const a = (await whep('cam', GUEST_IP)).id
      asDiscord('43', 'Celestia')
      const b = (await whep('other', OTHER_IP)).id
      asStreamer()

      const { viewers } = await firstSnapshot()

      expect(viewers.map((v) => [v.id, v.path]).sort()).toEqual(
        [
          [a, 'cam'],
          [b, 'other'],
        ].sort(),
      )
    })
  })

  describe('updates', () => {
    it('pushes a new snapshot when something changes', async () => {
      useFakeMediamtx()
      asStreamer()
      const { sse } = await connect()
      await sse.waitFor((e) => e.type === 'snapshot')
      expect(sse.events[0].snapshot.visibility).toEqual({})

      setPathVisibility('cam', 'public')
      notifyChanged('cam')
      await sse.waitFor((e) => e.snapshot.visibility.cam === 'public')

      expect(sse.events.at(-1)!.snapshot.visibility).toEqual({ cam: 'public' })
    })

    it('does not repeat an identical snapshot', async () => {
      useFakeMediamtx()
      asStreamer()
      const { sse } = await connect()
      await sse.waitFor((e) => e.type === 'snapshot')

      notifyChanged('cam')
      await expect(
        sse.waitFor((e) => e.type === 'snapshot', { timeoutMs: 200 }),
      ).rejects.toThrow(/Timed out/)
    })

    it('stops reacting to changes once the request is aborted', async () => {
      const fake = useFakeMediamtx()
      asStreamer()
      const { sse, abort } = await connect()
      await sse.waitFor((e) => e.type === 'snapshot')
      abort()
      const before = fake.requests.length

      setPathVisibility('cam', 'public')
      notifyChanged('cam')
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(fake.requests.length).toBe(before)
    })
  })
})
