import { describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/streams/visibility/route'
import { denyViewer, getBlock, kickViewer } from '@/lib/accessBlocks'
import {
  approveAccess,
  isApproved,
  listPendingRequests,
  openAccessRequest,
} from '@/lib/accessRequests'
import {
  getPathVisibility,
  rotateViewerPassword,
  setPathVisibility,
} from '@/lib/db'
import { useFakeMediamtx } from '../helpers/msw'
import { nextRequest } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import { GUEST_IP, OTHER_IP, goLive, installFakeMediamtx, whep } from './_support'

const setVisibility = (body: unknown) =>
  POST(nextRequest('/api/streams/visibility', { json: body }))

describe('POST /api/streams/visibility', () => {
  describe('guards and validation', () => {
    it.each([
      ['signed out', () => signedOut()],
      ['a guest', () => asGuest('pw')],
      ['a Discord viewer', () => asDiscord('42', 'Luna')],
    ])('401 for %s, and nothing changes', async (_label, signIn) => {
      signIn()
      const res = await setVisibility({ path: 'cam', visibility: 'public' })
      expect(res.status).toBe(401)
      expect(getPathVisibility('cam')).toBe('private')
    })

    it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
      useFakeMediamtx()
      vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
      signedOut()
      expect((await setVisibility({ path: 'cam', visibility: 'public' })).status).toBe(200)
      expect(getPathVisibility('cam')).toBe('public')
    })

    it('400 "Invalid JSON body" when the body is not JSON', async () => {
      asStreamer()
      const res = await POST(
        nextRequest('/api/streams/visibility', { method: 'POST', body: 'nope' }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
    })

    it.each([
      ['a missing path', { visibility: 'public' }],
      ['a non-string path', { path: 5, visibility: 'public' }],
      ['a path with a dot', { path: 'a.b', visibility: 'public' }],
      ['an empty path', { path: '', visibility: 'public' }],
      ['a path that is too long', { path: 'a'.repeat(65), visibility: 'public' }],
      ['a null body', null],
    ])('400 "Invalid path" for %s', async (_label, body) => {
      asStreamer()
      const res = await setVisibility(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid path' })
    })

    it.each([
      ['missing', {}],
      ['unknown', { visibility: 'friends' }],
      ['not a string', { visibility: true }],
    ])('400 "Invalid visibility" when visibility is %s', async (_label, extra) => {
      asStreamer()
      const res = await setVisibility({ path: 'cam', ...extra })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid visibility' })
      expect(getPathVisibility('cam')).toBe('private')
    })

    it.each(['maybe', 'kick ', 5, null])(
      '400 "Invalid viewers action" for viewers = %j',
      async (viewers) => {
        asStreamer()
        setPathVisibility('cam', 'public')
        const res = await setVisibility({ path: 'cam', visibility: 'private', viewers })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Invalid viewers action' })
        expect(getPathVisibility('cam')).toBe('public')
      },
    )

    it('validates before touching MediaMTX', async () => {
      const fake = useFakeMediamtx()
      asStreamer()
      await setVisibility({ path: 'a.b', visibility: 'private' })
      expect(fake.requests).toHaveLength(0)
    })
  })

  describe('going public', () => {
    it('sets the visibility and echoes it', async () => {
      useFakeMediamtx()
      asStreamer()

      const res = await setVisibility({ path: 'cam', visibility: 'public' })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ path: 'cam', visibility: 'public' })
      expect(getPathVisibility('cam')).toBe('public')
      expect(getPathVisibility('other')).toBe('private')
    })

    it('clears the path\'s pending requests but not other paths\'', async () => {
      useFakeMediamtx()
      asStreamer()
      const request = (path: string) => ({
        path,
        ip: GUEST_IP,
        role: 'viewer',
        name: null,
        image: null,
        discordId: null,
        clientIp: GUEST_IP,
      })
      openAccessRequest(request('cam'))
      openAccessRequest(request('other'))

      await setVisibility({ path: 'cam', visibility: 'public' })

      expect(listPendingRequests().map((r) => r.path)).toEqual(['other'])
    })

    it('clears denials but keeps kicks', async () => {
      useFakeMediamtx()
      asStreamer()
      denyViewer('cam', { role: 'viewer', ip: GUEST_IP })
      kickViewer('cam', { role: 'viewer', ip: OTHER_IP })

      await setVisibility({ path: 'cam', visibility: 'public' })

      expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
      expect(getBlock('cam', { role: 'viewer', ip: OTHER_IP })).toMatchObject({
        reason: 'kicked',
      })
    })

    it('does not contact MediaMTX or kick anyone', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asStreamer()
      fake.addSession({ path: 'cam', state: 'read' })

      await setVisibility({ path: 'cam', visibility: 'public' })

      expect(fake.requests).toHaveLength(0)
    })

    it('lets a previously unapproved guest in', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))
      expect((await whep('cam')).res.status).toBe(403)

      asStreamer()
      await setVisibility({ path: 'cam', visibility: 'public' })

      asGuest(rotateViewerPassword('default'))
      expect((await whep('cam')).res.status).toBe(201)
    })
  })

  describe('going private with people watching', () => {
    // Watching a public stream: a guest, a Discord viewer, the streamer, an
    // unknown session MediaMTX has but this app never saw, a publisher and a
    // viewer of another path.
    async function setup() {
      const fake = installFakeMediamtx()
      goLive(fake, 'cam')
      goLive(fake, 'other')
      setPathVisibility('cam', 'public')
      setPathVisibility('other', 'public')

      asGuest(rotateViewerPassword('default'))
      const guest = (await whep('cam', GUEST_IP)).id!
      asDiscord('42', 'Luna', 'https://cdn.discord.test/luna.png')
      const discord = (await whep('cam', OTHER_IP)).id!
      asStreamer()
      const streamer = (await whep('cam', '198.51.100.20')).id!
      asGuest(rotateViewerPassword('default'))
      const elsewhere = (await whep('other', GUEST_IP)).id!
      const unknown = fake.addSession({ path: 'cam', state: 'read' }).id
      const publisher = fake.addSession({ path: 'cam', state: 'publish' }).id
      const requestsBefore = fake.requests.length
      asStreamer()
      return { fake, guest, discord, streamer, elsewhere, unknown, publisher, requestsBefore }
    }

    describe('viewers: "reapprove" (the default)', () => {
      it('sets private and kicks the watchers through MediaMTX', async () => {
        const { fake, guest, discord, unknown } = await setup()

        const res = await setVisibility({ path: 'cam', visibility: 'private' })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ path: 'cam', visibility: 'private' })
        expect(getPathVisibility('cam')).toBe('private')
        expect(fake.kickedIds().sort()).toEqual([guest, discord, unknown].sort())
      })

      it('spares the streamer, the publisher and other paths', async () => {
        const { fake, streamer, publisher, elsewhere } = await setup()

        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'reapprove' })

        const kicked = fake.kickedIds()
        expect(kicked).not.toContain(streamer)
        expect(kicked).not.toContain(publisher)
        expect(kicked).not.toContain(elsewhere)
      })

      it('does not block the kicked viewers, but they must be approved again', async () => {
        await setup()
        approveAccess('cam', GUEST_IP, 'viewer')

        await setVisibility({ path: 'cam', visibility: 'private' })

        expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
        expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
        asGuest(rotateViewerPassword('default'))
        expect((await whep('cam', GUEST_IP)).res.status).toBe(403)
      })
    })

    describe('viewers: "approve"', () => {
      it('approves everybody currently watching and kicks nobody', async () => {
        const { fake, requestsBefore } = await setup()

        const res = await setVisibility({
          path: 'cam',
          visibility: 'private',
          viewers: 'approve',
        })

        expect(res.status).toBe(200)
        expect(getPathVisibility('cam')).toBe('private')
        expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)
        expect(isApproved('cam', 'discord:42', 'discord')).toBe(true)
        expect(fake.kicks()).toHaveLength(0)
        // Only the session list was fetched.
        expect(fake.requests.slice(requestsBefore).map((r) => r.path)).toEqual([
          '/v3/webrtcsessions/list',
        ])
      })

      it('does not approve the streamer, other paths, or sessions the app never saw', async () => {
        await setup()

        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'approve' })

        expect(isApproved('cam', '198.51.100.20', 'streamer')).toBe(false)
        expect(isApproved('other', GUEST_IP, 'viewer')).toBe(false)
        expect(isApproved('cam', '127.0.0.1', 'guest')).toBe(false)
      })

      it('lets the approved viewers reconnect and keeps others out', async () => {
        await setup()
        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'approve' })

        asGuest(rotateViewerPassword('default'))
        expect((await whep('cam', GUEST_IP)).res.status).toBe(201)
        expect((await whep('cam', '198.51.100.99')).res.status).toBe(403)
      })

      it('clears approvals granted earlier to people no longer watching', async () => {
        await setup()
        approveAccess('cam', '198.51.100.55', 'viewer')

        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'approve' })

        expect(isApproved('cam', '198.51.100.55', 'viewer')).toBe(false)
      })
    })

    describe('viewers: "kick"', () => {
      it('kicks everybody watching and blocks the ones the app knows', async () => {
        const { fake, guest, discord, unknown } = await setup()

        const res = await setVisibility({
          path: 'cam',
          visibility: 'private',
          viewers: 'kick',
        })

        expect(res.status).toBe(200)
        expect(fake.kickedIds().sort()).toEqual([guest, discord, unknown].sort())
        expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toMatchObject({
          reason: 'kicked',
        })
        expect(getBlock('cam', { role: 'discord', discordId: '42' })).toMatchObject({
          reason: 'kicked',
        })
      })

      it('does not block anybody else', async () => {
        await setup()

        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'kick' })

        expect(getBlock('cam', { role: 'viewer', ip: '198.51.100.99' })).toBeNull()
        expect(getBlock('other', { role: 'viewer', ip: GUEST_IP })).toBeNull()
      })

      it('keeps the kicked viewers out of a now public path too', async () => {
        await setup()
        await setVisibility({ path: 'cam', visibility: 'private', viewers: 'kick' })
        await setVisibility({ path: 'cam', visibility: 'public' })

        asGuest(rotateViewerPassword('default'))
        expect((await whep('cam', GUEST_IP)).res.status).toBe(403)
        expect((await whep('cam', '198.51.100.99')).res.status).toBe(201)
      })
    })

    it('still switches to private when MediaMTX is down (nobody to kick)', async () => {
      const fake = useFakeMediamtx()
      fake.setDown(true)
      asStreamer()
      setPathVisibility('cam', 'public')

      const res = await setVisibility({ path: 'cam', visibility: 'private' })

      expect(res.status).toBe(200)
      expect(getPathVisibility('cam')).toBe('private')
    })
  })
})
