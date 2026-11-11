import { describe, expect, it } from 'vitest'
import { POST } from '@/app/api/whep/[path]/route'
import { rotateViewerPassword, setPathVisibility } from '@/lib/db'
import { useFakeMediamtx } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asGuest, signedOut } from '../helpers/session'

const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=recvonly',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n')

const whep = (path = 'default') =>
  POST(
    nextRequest(`/api/whep/${path}`, { body: OFFER, ip: '198.51.100.7' }),
    routeParams(path),
  )

describe('harness smoke (integration)', () => {
  it('lets a public-stream guest through the whep route to the fake MediaMTX', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('default', true)
    setPathVisibility('default', 'public')
    asGuest(rotateViewerPassword('default'))

    const res = await whep()

    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toMatch(/^\/default\/whep\/.+/)
    expect(res.headers.get('content-type')).toBe('application/sdp')
    expect(await res.text()).toContain('a=sendonly')
    expect(fake.whepPosts()).toHaveLength(1)
    expect(fake.whepPosts()[0].authorized).toBe(true)
    expect(fake.sessions()).toMatchObject([{ path: 'default', state: 'read' }])
  })

  it('answers 401 when signed out (the auth mock reaches the route)', async () => {
    const fake = useFakeMediamtx()
    signedOut()
    expect((await whep()).status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('reaches lib/watchAccess.ts through the same mock (private + unapproved = 403)', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('default', true)
    asGuest(rotateViewerPassword('default'))

    expect((await whep()).status).toBe(403)
    expect(fake.requests).toHaveLength(0)
  })
})
