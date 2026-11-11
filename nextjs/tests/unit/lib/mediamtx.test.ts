import { describe, expect, it } from 'vitest'
import {
  fetchWebrtcSessions,
  forwardSdpHeaders,
  kickWebrtcSession,
  listConfiguredPaths,
  listPaths,
  listWebrtcSessions,
  mediamtxApiBase,
  mediamtxAuthHeader,
  mediamtxWebrtcBase,
  pathNames,
} from '@/lib/mediamtx'
import { http, HttpResponse } from 'msw'
import { createFakeMediamtx } from '../../fakes/mediamtx'
import { server, useFakeMediamtx } from '../../helpers/msw'

describe('config helpers', () => {
  it('builds the API and WebRTC base URLs from the environment', () => {
    expect(mediamtxApiBase()).toBe('http://mediamtx.test:9997')
    expect(mediamtxWebrtcBase()).toBe('http://mediamtx.test:8889')
  })

  it('builds the Basic auth header for the streamer user', () => {
    expect(mediamtxAuthHeader()).toBe(
      'Basic ' + Buffer.from('streamer:test-streamer-password').toString('base64'),
    )
  })
})

describe('pathNames', () => {
  it('merges lists, dedupes and sorts', () => {
    expect(
      pathNames([{ name: 'b' }, { name: 'a' }], [{ name: 'b' }, { name: 'c' }]),
    ).toEqual(['a', 'b', 'c'])
  })

  it('skips null lists', () => {
    expect(pathNames(null, [{ name: 'x' }], null)).toEqual(['x'])
    expect(pathNames(null)).toEqual([])
    expect(pathNames()).toEqual([])
  })
})

describe('forwardSdpHeaders', () => {
  it('keeps only the SDP-related headers', () => {
    const res = new Response(null, {
      headers: {
        'Content-Type': 'application/sdp',
        Location: '/live/whep/abc',
        Link: '<stun:stun.example>; rel="ice-server"',
        'Accept-Patch': 'application/trickle-ice-sdpfrag',
        Id: 'abc',
        'Set-Cookie': 'secret=1',
        Authorization: 'Basic xyz',
        'X-Custom': 'nope',
        Server: 'mediamtx',
      },
    })
    const headers = forwardSdpHeaders(res)
    expect(Object.fromEntries(headers.entries())).toEqual({
      'content-type': 'application/sdp',
      location: '/live/whep/abc',
      link: '<stun:stun.example>; rel="ice-server"',
      'accept-patch': 'application/trickle-ice-sdpfrag',
      id: 'abc',
    })
  })
})

describe('list functions', () => {
  it('lists paths and configured paths with the streamer credentials', async () => {
    const fake = useFakeMediamtx()
    fake.addConfiguredPath('cfg')
    fake.setReady('live', true)

    const paths = await listPaths()
    expect(paths?.map((p) => [p.name, p.ready])).toEqual([
      ['cfg', false],
      ['live', true],
    ])
    expect(await listConfiguredPaths()).toEqual([{ name: 'cfg' }])
    expect(fake.requests.every((r) => r.authorized)).toBe(true)
  })

  it('lists WebRTC sessions', async () => {
    const fake = useFakeMediamtx()
    const session = fake.addSession({ path: 'live' })
    expect((await fetchWebrtcSessions())?.map((s) => s.id)).toEqual([session.id])
    expect((await listWebrtcSessions()).map((s) => s.id)).toEqual([session.id])
  })

  it('returns null when MediaMTX is down', async () => {
    const fake = useFakeMediamtx()
    fake.setDown(true)
    expect(await listPaths()).toBeNull()
    expect(await listConfiguredPaths()).toBeNull()
    expect(await fetchWebrtcSessions()).toBeNull()
  })

  it('returns null on a non-2xx answer, such as rejected credentials', async () => {
    // The app sends the streamer password; make the fake expect another one.
    const wrong = createFakeMediamtx({ password: 'something-else' })
    server.resetHandlers()
    useFakeMediamtx(wrong)
    expect(await listPaths()).toBeNull()
    expect(wrong.requests[0].authorized).toBe(false)
  })

  it('treats a missing items array as an empty list', async () => {
    server.use(
      http.get('http://mediamtx.test:9997/v3/paths/list', () => HttpResponse.json({})),
    )
    expect(await listPaths()).toEqual([])
  })

  it('listWebrtcSessions is empty when MediaMTX fails', async () => {
    const fake = useFakeMediamtx()
    fake.setDown(true)
    expect(await listWebrtcSessions()).toEqual([])
  })
})

describe('kickWebrtcSession', () => {
  it('posts to the kick endpoint with auth and reports success', async () => {
    const fake = useFakeMediamtx()
    const session = fake.addSession({ path: 'live' })
    expect(await kickWebrtcSession(session.id)).toBe(true)
    expect(fake.kickedIds()).toEqual([session.id])
    expect(fake.kicks()[0].authorized).toBe(true)
    expect(fake.sessions()).toEqual([])
  })

  it('URL-encodes the session id', async () => {
    const fake = useFakeMediamtx()
    fake.addSession({ path: 'live', id: 'a/b c' })
    expect(await kickWebrtcSession('a/b c')).toBe(true)
    expect(fake.kicks()[0].path).toBe('/v3/webrtcsessions/kick/a%2Fb%20c')
  })

  it('is false for an unknown session and when MediaMTX is down', async () => {
    const fake = useFakeMediamtx()
    expect(await kickWebrtcSession('missing')).toBe(false)
    fake.setDown(true)
    expect(await kickWebrtcSession('missing')).toBe(false)
  })
})
