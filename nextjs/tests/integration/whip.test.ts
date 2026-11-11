import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { DELETE, POST } from '@/app/api/whip/[path]/route'
import { mediamtxWebrtcBase } from '@/lib/mediamtx'
import { server, useFakeMediamtx } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import { OFFER } from './_support'

const publish = (path: string) =>
  POST(nextRequest(`/api/whip/${path}`, { body: OFFER }), routeParams(path))
const teardown = (path: string, id?: string) =>
  DELETE(
    nextRequest(`/api/whip/${path}${id === undefined ? '' : `?id=${id}`}`, {
      method: 'DELETE',
    }),
    routeParams(path),
  )

const signIns: [string, () => unknown][] = [
  ['signed out', () => signedOut()],
  ['a guest', () => asGuest('pw')],
  ['a Discord viewer', () => asDiscord('42', 'Luna')],
]

describe('POST /api/whip/[path]', () => {
  it.each(signIns)('401 for %s, without contacting MediaMTX', async (_label, signIn) => {
    const fake = useFakeMediamtx()
    signIn()
    expect((await publish('cam')).status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('404 for an invalid path name', async () => {
    const fake = useFakeMediamtx()
    asStreamer()
    expect((await publish('a.b')).status).toBe(404)
    expect(fake.requests).toHaveLength(0)
  })

  it('forwards the offer with the streamer Basic auth and passes the 201 answer through', async () => {
    const fake = useFakeMediamtx()
    asStreamer()

    const res = await publish('cam')

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/sdp')
    expect(res.headers.get('location')).toMatch(/^\/cam\/whip\/.+/)
    expect(res.headers.get('id')).toBeTruthy()
    expect(await res.text()).toContain('v=0')
    expect(fake.whipPosts()).toHaveLength(1)
    expect(fake.whipPosts()[0]).toMatchObject({
      path: '/cam/whip',
      authorized: true,
      body: OFFER,
    })
    expect(fake.sessions()).toMatchObject([{ path: 'cam', state: 'publish' }])
  })

  it('forwards nested path names', async () => {
    const fake = useFakeMediamtx()
    asStreamer()

    expect((await publish('live/cam')).status).toBe(201)
    expect(fake.whipPosts()[0].path).toBe('/live/cam/whip')
  })

  it('passes an error status from MediaMTX through, with only whitelisted headers', async () => {
    useFakeMediamtx()
    asStreamer()
    server.use(
      http.post(
        `${mediamtxWebrtcBase()}/cam/whip`,
        () =>
          new HttpResponse('bad offer', {
            status: 400,
            headers: { 'X-Internal': 'secret', 'Content-Type': 'text/plain' },
          }),
      ),
    )

    const res = await publish('cam')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('bad offer')
    expect(res.headers.get('x-internal')).toBeNull()
    expect(res.headers.get('content-type')).toBe('text/plain')
  })

  it('does not create a stream session itself (that comes from the MediaMTX hook)', async () => {
    useFakeMediamtx()
    asStreamer()
    const { isStreamOnline } = await import('@/lib/streamState')

    await publish('cam')

    expect(isStreamOnline('cam')).toBe(false)
  })

  it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
    const fake = useFakeMediamtx()
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    signedOut()

    expect((await publish('cam')).status).toBe(201)
    expect(fake.whipPosts()).toHaveLength(1)
  })
})

describe('DELETE /api/whip/[path]', () => {
  it.each(signIns)('401 for %s, without contacting MediaMTX', async (_label, signIn) => {
    const fake = useFakeMediamtx()
    signIn()
    expect((await teardown('cam', 'abc')).status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('404 for an invalid path name', async () => {
    useFakeMediamtx()
    asStreamer()
    expect((await teardown('a.b', 'abc')).status).toBe(404)
  })

  it('400 "Missing id" without an id', async () => {
    const fake = useFakeMediamtx()
    asStreamer()

    const res = await teardown('cam')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Missing id')
    expect(fake.requests).toHaveLength(0)
  })

  it('forwards the DELETE to the WHIP resource, ending the publisher session', async () => {
    const fake = useFakeMediamtx()
    asStreamer()
    const publishRes = await publish('cam')
    const id = publishRes.headers.get('id')!

    const res = await teardown('cam', id)

    expect(res.status).toBe(200)
    const deleteCall = fake.requests.find((r) => r.method === 'DELETE')
    expect(deleteCall).toMatchObject({ path: `/cam/whip/${id}`, authorized: true })
    expect(fake.sessions()).toHaveLength(0)
  })

  it('passes MediaMTX\'s status through', async () => {
    useFakeMediamtx()
    asStreamer()
    server.use(
      http.delete(`${mediamtxWebrtcBase()}/cam/whip/gone`, () =>
        HttpResponse.text('not found', { status: 404 }),
      ),
    )

    expect((await teardown('cam', 'gone')).status).toBe(404)
  })

  it('answers 204 when MediaMTX cannot be reached (best-effort teardown)', async () => {
    const fake = useFakeMediamtx()
    fake.setDown(true)
    asStreamer()

    expect((await teardown('cam', 'abc')).status).toBe(204)
  })
})
