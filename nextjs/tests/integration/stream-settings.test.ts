import { describe, expect, it, vi } from 'vitest'
import { GET, POST } from '@/app/api/stream/settings/route'
import { DEFAULT_STREAM_SETTINGS, getStreamSettings } from '@/lib/db'
import { nextRequest } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'

const save = (body: unknown) =>
  POST(nextRequest('/api/stream/settings', { json: body }))

const signIns: [string, () => unknown][] = [
  ['signed out', () => signedOut()],
  ['a guest', () => asGuest('pw')],
  ['a Discord viewer', () => asDiscord('42', 'Luna')],
]

describe('GET /api/stream/settings', () => {
  it.each(signIns)('401 for %s', async (_label, signIn) => {
    signIn()
    expect((await GET()).status).toBe(401)
  })

  it('returns the defaults when nothing was saved', async () => {
    asStreamer()
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DEFAULT_STREAM_SETTINGS)
  })

  it('returns what was saved', async () => {
    asStreamer()
    await save({ path: 'cam', fps: 45 })
    const res = await GET()
    expect(await res.json()).toMatchObject({ path: 'cam', fps: 45 })
  })

  it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    signedOut()
    expect((await GET()).status).toBe(200)
  })
})

describe('POST /api/stream/settings', () => {
  it.each(signIns)('401 for %s, and nothing is saved', async (_label, signIn) => {
    signIn()
    expect((await save({ path: 'cam' })).status).toBe(401)
    expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS)
  })

  it('400 "Invalid JSON body" when the body is not JSON', async () => {
    asStreamer()
    const res = await POST(
      nextRequest('/api/stream/settings', { method: 'POST', body: 'nope' }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['a number', 7],
  ])('400 "Invalid settings payload" for %s', async (_label, body) => {
    asStreamer()
    const res = await save(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid settings payload' })
    expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS)
  })

  it('saves a complete valid payload unchanged and returns it', async () => {
    asStreamer()
    const settings = {
      path: 'live/cam1',
      sourceType: 'window',
      fixedResolution: true,
      width: 1280,
      height: 720,
      fps: 60,
      videoBitrateKbps: 4500,
      videoCodec: 'vp9',
      contentHint: 'detail',
      degradationPreference: 'maintain-resolution',
      includeAudio: false,
      audioBitrateKbps: 96,
    }

    const res = await save(settings)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(settings)
    expect(getStreamSettings()).toEqual(settings)
  })

  it('fills everything missing with the defaults', async () => {
    asStreamer()

    const res = await save({})

    expect(await res.json()).toEqual(DEFAULT_STREAM_SETTINGS)
    expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS)
  })

  describe('sanitization', () => {
    it.each([
      ['a path with a dot', 'a.b'],
      ['a path with a space', 'my cam'],
      ['an empty path', ''],
      ['a path that is too long', 'x'.repeat(65)],
      ['a non-string path', 5],
    ])('replaces %s with the default path', async (_label, path) => {
      asStreamer()
      const saved = await (await save({ path })).json()
      expect(saved.path).toBe(DEFAULT_STREAM_SETTINGS.path)
    })

    it('keeps a valid path, including slashes', async () => {
      asStreamer()
      expect((await (await save({ path: 'Live/Cam2' })).json()).path).toBe('Live/Cam2')
    })

    it.each([
      ['sourceType', 'tv', DEFAULT_STREAM_SETTINGS.sourceType],
      ['videoCodec', 'h265', DEFAULT_STREAM_SETTINGS.videoCodec],
      ['contentHint', 'sharp', DEFAULT_STREAM_SETTINGS.contentHint],
      [
        'degradationPreference',
        'whatever',
        DEFAULT_STREAM_SETTINGS.degradationPreference,
      ],
    ])('falls back to the default for an unknown %s', async (key, value, fallback) => {
      asStreamer()
      const saved = await (await save({ [key]: value })).json()
      expect(saved[key]).toBe(fallback)
    })

    it.each([
      ['width', 99999, 7680],
      ['width', 10, 160],
      ['height', 99999, 4320],
      ['height', 10, 120],
      ['fps', 0, 1],
      ['fps', 240, 60],
      ['videoBitrateKbps', 5, 100],
      ['videoBitrateKbps', 999999, 50000],
      ['audioBitrateKbps', 1, 6],
      ['audioBitrateKbps', 4000, 512],
    ])('clamps %s = %d to %d', async (key, value, expected) => {
      asStreamer()
      const saved = await (await save({ [key]: value })).json()
      expect(saved[key]).toBe(expected)
    })

    it('rounds fractional numbers and accepts numeric strings', async () => {
      asStreamer()
      const saved = await (await save({ fps: 29.6, width: '1280.4' })).json()
      expect(saved.fps).toBe(30)
      expect(saved.width).toBe(1280)
    })

    it.each([
      ['a non-numeric string', 'abc'],
      ['NaN-ish', {}],
      ['Infinity-ish', 'Infinity'],
    ])('uses the default for %s', async (_label, value) => {
      asStreamer()
      const saved = await (await save({ fps: value, width: value })).json()
      expect(saved.fps).toBe(DEFAULT_STREAM_SETTINGS.fps)
      expect(saved.width).toBe(DEFAULT_STREAM_SETTINGS.width)
    })

    it('coerces fixedResolution to a boolean', async () => {
      asStreamer()
      expect((await (await save({ fixedResolution: 1 })).json()).fixedResolution).toBe(true)
      expect((await (await save({ fixedResolution: 0 })).json()).fixedResolution).toBe(false)
      expect((await (await save({})).json()).fixedResolution).toBe(false)
    })

    it('defaults includeAudio to true but respects an explicit false', async () => {
      asStreamer()
      expect((await (await save({})).json()).includeAudio).toBe(true)
      expect((await (await save({ includeAudio: false })).json()).includeAudio).toBe(false)
      expect((await (await save({ includeAudio: 0 })).json()).includeAudio).toBe(false)
    })

    it('drops unknown fields', async () => {
      asStreamer()
      const saved = await (await save({ path: 'cam', evil: '<script>' })).json()
      expect(saved).not.toHaveProperty('evil')
      expect(getStreamSettings()).not.toHaveProperty('evil')
    })
  })

  it('overwrites earlier settings', async () => {
    asStreamer()
    await save({ path: 'first', fps: 15 })
    await save({ path: 'second' })

    expect(getStreamSettings()).toMatchObject({
      path: 'second',
      fps: DEFAULT_STREAM_SETTINGS.fps,
    })
  })
})
