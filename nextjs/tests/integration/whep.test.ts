import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { POST as leavePost } from '@/app/api/whep/[path]/leave/route'
import { approveAccess } from '@/lib/accessRequests'
import { kickViewer } from '@/lib/accessBlocks'
import { rotateViewerPassword, setPathVisibility } from '@/lib/db'
import { mediamtxWebrtcBase } from '@/lib/mediamtx'
import { getViewerIdentity } from '@/lib/viewerIdentities'
import { server, useFakeMediamtx } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, asTrusted, signedOut } from '../helpers/session'
import { trustNetworks } from '../helpers/trust'
import { GUEST_IP, OFFER, OTHER_IP, goLive, whep } from './_support'

describe('POST /api/whep/[path]', () => {
  describe('rejections (MediaMTX is never contacted)', () => {
    it('401 without a session', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      signedOut()

      const { res } = await whep('cam')

      expect(res.status).toBe(401)
      expect(fake.requests).toHaveLength(0)
    })

    it('404 for an invalid path name', async () => {
      const fake = useFakeMediamtx()
      asStreamer()

      const { res } = await whep('a.b')

      expect(res.status).toBe(404)
      expect(fake.requests).toHaveLength(0)
    })

    it('401 once the viewer password was rotated after sign-in', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))
      rotateViewerPassword('default')

      const { res } = await whep('cam')

      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Session no longer valid')
      expect(fake.requests).toHaveLength(0)
    })

    it('401 when the path has its own password and the session carries another one', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      const defaultPassword = rotateViewerPassword('default')
      rotateViewerPassword('cam')
      asGuest(defaultPassword)

      const { res } = await whep('cam')

      expect(res.status).toBe(401)
      expect(fake.requests).toHaveLength(0)
    })

    it('403 for an unapproved viewer on a private path', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))

      const { res } = await whep('cam')

      expect(res.status).toBe(403)
      expect(fake.requests).toHaveLength(0)
    })

    it('403 for a Discord viewer who is not approved on a private path', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asDiscord('42', 'Luna')

      const { res } = await whep('cam')

      expect(res.status).toBe(403)
      expect(fake.requests).toHaveLength(0)
    })

    it('403 for a kicked viewer even on a public path', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))
      kickViewer('cam', { role: 'viewer', ip: GUEST_IP })

      const { res } = await whep('cam', GUEST_IP)
      expect(res.status).toBe(403)

      // A different address is a different guest.
      const { res: other } = await whep('cam', OTHER_IP)
      expect(other.status).toBe(201)
      expect(fake.whepPosts()).toHaveLength(1)
    })

    it('403 for a kicked viewer even when previously approved', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))
      approveAccess('cam', GUEST_IP, 'viewer')
      kickViewer('cam', { role: 'viewer', ip: GUEST_IP })

      const { res } = await whep('cam')

      expect(res.status).toBe(403)
      expect(fake.requests).toHaveLength(0)
    })
  })

  describe('allowed viewers', () => {
    it('lets the streamer in on a private path without approval', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asStreamer()

      const { res } = await whep('cam')

      expect(res.status).toBe(201)
      expect(fake.whepPosts()).toHaveLength(1)
    })

    it('lets an approved guest in on a private path', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asGuest(rotateViewerPassword('default'))
      approveAccess('cam', GUEST_IP, 'viewer')

      const { res } = await whep('cam')

      expect(res.status).toBe(201)
    })

    it('lets a trusted-network viewer onto a public path without a password', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      trustNetworks('10.250.0.0/16')
      asTrusted()

      const { res } = await whep('cam', '10.250.0.5')

      expect(res.status).toBe(201)
      expect(fake.whepPosts()).toHaveLength(1)
    })

    it('makes a trusted-network viewer wait for approval on a private path', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      trustNetworks('10.250.0.0/16')
      asTrusted()

      expect((await whep('cam', '10.250.0.5')).res.status).toBe(403)
      approveAccess('cam', '10.250.0.5', 'viewer')
      expect((await whep('cam', '10.250.0.5')).res.status).toBe(201)
    })

    it('401 for a trusted-network session used from an untrusted IP', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      trustNetworks('10.250.0.0/16')
      asTrusted()

      const { res } = await whep('cam', GUEST_IP)

      expect(res.status).toBe(401)
      expect(fake.requests).toHaveLength(0)
    })

    it('lets an approved Discord viewer in from any address (approved by account)', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asDiscord('42', 'Luna')
      approveAccess('cam', 'discord:42', 'discord')

      expect((await whep('cam', GUEST_IP)).res.status).toBe(201)
      expect((await whep('cam', OTHER_IP)).res.status).toBe(201)
    })

    it('lets a guest in on a public path without approval', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { res } = await whep('cam')

      expect(res.status).toBe(201)
    })

    it('accepts a path-specific password for a path with its own password', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      rotateViewerPassword('default')
      asGuest(rotateViewerPassword('cam'))

      const { res } = await whep('cam')

      expect(res.status).toBe(201)
    })
  })

  describe('forwarding to MediaMTX', () => {
    it('sends the SDP offer with the streamer Basic auth to /<path>/whep', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asStreamer()

      await whep('cam')

      const [post] = fake.whepPosts()
      expect(post.path).toBe('/cam/whep')
      expect(post.body).toBe(OFFER)
      expect(post.authorized).toBe(true)
    })

    it('forwards nested path names', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'live/cam')
      asStreamer()

      const { res } = await whep('live/cam')

      expect(res.status).toBe(201)
      expect(fake.whepPosts()[0].path).toBe('/live/cam/whep')
    })

    it('passes the status, body and the SDP headers through', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asStreamer()

      const { res, id } = await whep('cam')

      expect(res.status).toBe(201)
      expect(res.headers.get('content-type')).toBe('application/sdp')
      expect(res.headers.get('location')).toBe(`/cam/whep/${id}`)
      expect(res.headers.get('accept-patch')).toBe('application/trickle-ice-sdpfrag')
      expect(id).toBeTruthy()
      expect(await res.text()).toContain('v=0')
    })

    it('only forwards whitelisted response headers', async () => {
      const fake = useFakeMediamtx()
      asStreamer()
      server.use(
        http.post(
          `${mediamtxWebrtcBase()}/cam/whep`,
          () =>
            new HttpResponse('answer-sdp', {
              status: 201,
              headers: {
                'Content-Type': 'application/sdp',
                Location: '/cam/whep/abc',
                Link: '<stun:stun.example.test>; rel="ice-server"',
                'Accept-Patch': 'application/trickle-ice-sdpfrag',
                Id: 'abc',
                'X-Internal': 'secret',
                Server: 'mediamtx',
                'Set-Cookie': 'a=b',
              },
            }),
        ),
      )

      const { res } = await whep('cam')

      expect(res.status).toBe(201)
      expect(await res.text()).toBe('answer-sdp')
      expect([...res.headers.keys()].sort()).toEqual([
        'accept-patch',
        'content-type',
        'id',
        'link',
        'location',
      ])
      expect(fake.requests).toHaveLength(0)
    })

    it('passes a 404 through when the path is offline', async () => {
      const fake = useFakeMediamtx()
      asStreamer()

      const { res } = await whep('cam')

      expect(res.status).toBe(404)
      expect(await res.text()).toBe('no stream is available on path')
      expect(fake.whepPosts()).toHaveLength(1)
      expect(fake.sessions()).toHaveLength(0)
    })

    it('does not remember an identity when MediaMTX refuses', async () => {
      const fake = useFakeMediamtx()
      asDiscord('42', 'Luna')
      setPathVisibility('cam', 'public')

      const { res, id } = await whep('cam')

      expect(res.status).toBe(404)
      expect(id).toBeNull()
      expect(fake.sessions()).toHaveLength(0)
    })
  })

  describe('MediaMTX unreachable', () => {
    it('answers 502 and remembers no identity', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asDiscord('42', 'Luna')
      setPathVisibility('cam', 'public')
      fake.setDown(true)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { res, id } = await whep('cam')

      expect(res.status).toBe(502)
      expect(await res.text()).toBe('Media server unreachable')
      expect(id).toBeNull()
      expect(error).toHaveBeenCalled()
      expect(fake.sessions()).toHaveLength(0)
    })
  })

  describe('remembering the viewer identity', () => {
    it('stores a guest by IP address', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const { id } = await whep('cam', GUEST_IP)

      expect(getViewerIdentity(id!)).toMatchObject({
        name: GUEST_IP,
        image: null,
        role: 'viewer',
        ip: GUEST_IP,
        discordId: null,
        path: 'cam',
      })
      expect(fake.sessions().map((s) => s.id)).toEqual([id])
    })

    it('stores a Discord viewer with real name, image and account id', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      asDiscord('42', 'Luna', 'https://cdn.discord.test/luna.png')
      approveAccess('cam', 'discord:42', 'discord')

      const { id } = await whep('cam', GUEST_IP)

      expect(getViewerIdentity(id!)).toMatchObject({
        name: 'Luna',
        image: 'https://cdn.discord.test/luna.png',
        role: 'discord',
        ip: GUEST_IP,
        discordId: '42',
        path: 'cam',
      })
    })

    it('stores each session under its own id', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))

      const a = await whep('cam', GUEST_IP)
      const b = await whep('cam', OTHER_IP)

      expect(a.id).not.toBe(b.id)
      expect(getViewerIdentity(a.id!)?.ip).toBe(GUEST_IP)
      expect(getViewerIdentity(b.id!)?.ip).toBe(OTHER_IP)
    })
  })
})

describe('POST /api/whep/[path]/leave', () => {
  const leave = (
    path: string,
    body: unknown,
    ip: string = GUEST_IP,
  ) =>
    leavePost(
      nextRequest(`/api/whep/${path}/leave`, { json: body, ip }),
      routeParams(path),
    )

  async function joinAsGuest(
    fake: ReturnType<typeof useFakeMediamtx>,
    ip = GUEST_IP,
  ) {
    goLive(fake, 'cam')
    setPathVisibility('cam', 'public')
    asGuest(rotateViewerPassword('default'))
    const { id } = await whep('cam', ip)
    return id!
  }

  it('401 without a session', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake)
    signedOut()

    const res = await leave('cam', { sessionId: id })

    expect(res.status).toBe(401)
    expect(fake.kicks()).toHaveLength(0)
  })

  it('400 when sessionId is missing or not a string', async () => {
    const fake = useFakeMediamtx()
    await joinAsGuest(fake)

    expect((await leave('cam', {})).status).toBe(400)
    expect((await leave('cam', { sessionId: 7 })).status).toBe(400)
    expect(
      (
        await leavePost(
          nextRequest('/api/whep/cam/leave', { body: 'nope', ip: GUEST_IP }),
          routeParams('cam'),
        )
      ).status,
    ).toBe(400)
    expect(fake.kicks()).toHaveLength(0)
  })

  it('kicks the caller\'s own session and answers 204', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake)

    const res = await leave('cam', { sessionId: id })

    expect(res.status).toBe(204)
    expect(fake.kickedIds()).toEqual([id])
    expect(fake.sessions()).toHaveLength(0)
  })

  it('does not kick a session that belongs to a different IP', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake, GUEST_IP)

    const res = await leave('cam', { sessionId: id }, OTHER_IP)

    expect(res.status).toBe(204)
    expect(fake.kicks()).toHaveLength(0)
    expect(fake.sessions()).toHaveLength(1)
  })

  it('does not kick when the path in the URL differs from the session\'s path', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake)

    const res = await leave('other', { sessionId: id })

    expect(res.status).toBe(204)
    expect(fake.kicks()).toHaveLength(0)
  })

  it('does not kick a session belonging to a different role from the same IP', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake)
    asStreamer()

    const res = await leave('cam', { sessionId: id })

    expect(res.status).toBe(204)
    expect(fake.kicks()).toHaveLength(0)
  })

  it('does not kick another Discord account\'s session', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    setPathVisibility('cam', 'public')
    asDiscord('42', 'Luna')
    const { id } = await whep('cam', GUEST_IP)

    asDiscord('43', 'Celestia')
    expect((await leave('cam', { sessionId: id! })).status).toBe(204)
    expect(fake.kicks()).toHaveLength(0)

    asDiscord('42', 'Luna')
    expect((await leave('cam', { sessionId: id! })).status).toBe(204)
    expect(fake.kickedIds()).toEqual([id])
  })

  it('answers 204 without calling MediaMTX for an unknown session id', async () => {
    const fake = useFakeMediamtx()
    await joinAsGuest(fake)

    const res = await leave('cam', { sessionId: 'does-not-exist' })

    expect(res.status).toBe(204)
    expect(fake.kicks()).toHaveLength(0)
  })

  it('still answers 204 when MediaMTX is down', async () => {
    const fake = useFakeMediamtx()
    const id = await joinAsGuest(fake)
    fake.setDown(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await leave('cam', { sessionId: id })

    expect(res.status).toBe(204)
  })
})
