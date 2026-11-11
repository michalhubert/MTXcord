import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/stream/paths/route'
import { mediamtxApiBase } from '@/lib/mediamtx'
import { isStreamOnline } from '@/lib/streamState'
import { server, useFakeMediamtx } from '../helpers/msw'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'

describe('GET /api/stream/paths', () => {
  it.each([
    ['signed out', () => signedOut()],
    ['a guest', () => asGuest('pw')],
    ['a Discord viewer', () => asDiscord('42', 'Luna')],
  ])('401 for %s, without contacting MediaMTX', async (_label, signIn) => {
    const fake = useFakeMediamtx()
    signIn()
    expect((await GET()).status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
    useFakeMediamtx()
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    signedOut()
    expect((await GET()).status).toBe(200)
  })

  it('returns an empty list for an idle MediaMTX', async () => {
    useFakeMediamtx()
    asStreamer()
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paths: [] })
  })

  it('merges configured and listed paths, de-duplicated and sorted', async () => {
    const fake = useFakeMediamtx()
    fake.addConfiguredPath('zeta')
    fake.addConfiguredPath('alpha')
    fake.addConfiguredPath('live1')
    fake.setReady('live1', true)
    fake.setReady('adhoc', true)
    asStreamer()

    const res = await GET()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paths: ['adhoc', 'alpha', 'live1', 'zeta'] })
  })

  it('queries both MediaMTX lists with the streamer credentials', async () => {
    const fake = useFakeMediamtx()
    asStreamer()

    await GET()

    const calls = fake.requests.map((r) => r.path).sort()
    expect(calls).toEqual(['/v3/config/paths/list', '/v3/paths/list'])
    expect(fake.requests.every((r) => r.authorized)).toBe(true)
  })

  it('also syncs the stream state from the live paths', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('live1', true)
    asStreamer()

    await GET()

    expect(isStreamOnline('live1')).toBe(true)
  })

  it('still lists the configured paths when only the live list fails', async () => {
    const fake = useFakeMediamtx()
    fake.addConfiguredPath('alpha')
    server.use(
      http.get(`${mediamtxApiBase()}/v3/paths/list`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    asStreamer()

    const res = await GET()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paths: ['alpha'] })
  })

  it('still lists the live paths when only the configured list fails', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('live1', true)
    server.use(
      http.get(`${mediamtxApiBase()}/v3/config/paths/list`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    asStreamer()

    const res = await GET()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paths: ['live1'] })
  })

  it('502 when MediaMTX cannot be reached at all', async () => {
    const fake = useFakeMediamtx()
    fake.setDown(true)
    asStreamer()

    const res = await GET()

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'MediaMTX API unreachable' })
  })

  it('502 when both lists answer with an error', async () => {
    useFakeMediamtx()
    server.use(
      http.get(`${mediamtxApiBase()}/v3/paths/list`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get(`${mediamtxApiBase()}/v3/config/paths/list`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    )
    asStreamer()

    expect((await GET()).status).toBe(502)
  })
})
