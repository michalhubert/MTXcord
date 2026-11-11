import { describe, expect, it, vi } from 'vitest'
import { POST as avatarPost } from '@/app/api/watch/[path]/avatar/route'
import { POST as keepPost } from '@/app/api/watch/[path]/keep/route'
import { POST as tagPost } from '@/app/api/watch/[path]/tag/route'
import { approveAccess } from '@/lib/accessRequests'
import { kickViewer } from '@/lib/accessBlocks'
import {
  getGuestIdentity,
  rotateViewerPassword,
  setPathVisibility,
} from '@/lib/db'
import { useFakeClock } from '../helpers/clock'
import { useFakeDerpibooru } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import { GUEST_IP, OTHER_IP } from './_support'

type Handler = typeof keepPost
const call = (
  handler: Handler,
  name: string,
  path: string,
  body?: unknown,
  ip: string = GUEST_IP,
) =>
  handler(
    nextRequest(`/api/watch/${path}/${name}`, {
      ...(body === undefined ? { method: 'POST' } : { json: body }),
      ip,
    }),
    routeParams(path),
  )
const keep = (body?: unknown, path = 'cam', ip?: string) =>
  call(keepPost, 'keep', path, body, ip)
const avatar = (path = 'cam', ip?: string) =>
  call(avatarPost, 'avatar', path, undefined, ip)
const tag = (body?: unknown, path = 'cam', ip?: string) =>
  call(tagPost, 'tag', path, body, ip)

/** A guest on a public path, which is the simplest way to have a pony. */
function publicGuest(path = 'cam') {
  setPathVisibility(path, 'public')
  asGuest(rotateViewerPassword('default'))
}

describe.each([
  ['keep', (ip?: string) => keep({ keep: true }, 'cam', ip)],
  ['avatar', (ip?: string) => avatar('cam', ip)],
  ['tag', (ip?: string) => tag({ tag: null }, 'cam', ip)],
])('/api/watch/[path]/%s access checks', (name, run) => {
  it('401 when signed out', async () => {
    signedOut()
    expect((await run()).status).toBe(401)
  })

  it('401 for a stale viewer password', async () => {
    asGuest(rotateViewerPassword('default'))
    rotateViewerPassword('default')
    expect((await run()).status).toBe(401)
  })

  it('403 for an unapproved guest on a private path', async () => {
    asGuest(rotateViewerPassword('default'))
    expect((await run()).status).toBe(403)
  })

  it('403 for a kicked guest', async () => {
    publicGuest()
    kickViewer('cam', { role: 'viewer', ip: GUEST_IP })
    expect((await run()).status).toBe(403)
  })

  it('400 "No pony identity" for the streamer', async () => {
    asStreamer()
    const res = await run()
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('No pony identity')
  })

  it('400 for a Discord viewer on a private path (shown with their own identity)', async () => {
    asDiscord('42', 'Luna')
    approveAccess('cam', 'discord:42', 'discord')
    expect((await run()).status).toBe(400)
  })

  it(`404 for an invalid path (${name})`, async () => {
    asStreamer()
    const handler = { keep: keepPost, avatar: avatarPost, tag: tagPost }[
      name as 'keep' | 'avatar' | 'tag'
    ]
    const res = await handler(
      nextRequest(`/api/watch/a.b/${name}`, { json: { keep: true, tag: null } }),
      routeParams('a.b'),
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/watch/[path]/keep', () => {
  it('keeps the pony and answers {kept: true}', async () => {
    publicGuest()
    useFakeDerpibooru()

    const res = await keep({ keep: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kept: true })
    expect(getGuestIdentity('cam', GUEST_IP)?.keep).toBe(1)
  })

  it('releases it again with {keep: false}', async () => {
    publicGuest()
    useFakeDerpibooru()
    await keep({ keep: true })

    const res = await keep({ keep: false })

    expect(await res.json()).toEqual({ kept: false })
    expect(getGuestIdentity('cam', GUEST_IP)?.keep).toBe(0)
  })

  it('is per guest address', async () => {
    publicGuest()
    useFakeDerpibooru()
    await keep({ keep: true }, 'cam', GUEST_IP)

    expect(getGuestIdentity('cam', OTHER_IP)?.keep).toBeFalsy()
  })

  it.each([
    ['a non-boolean keep', { keep: 'yes' }],
    ['a missing keep', {}],
    ['a null body', null],
  ])('400 for %s', async (_label, body) => {
    publicGuest()
    expect((await keep(body)).status).toBe(400)
  })

  it('400 for a body that is not JSON', async () => {
    publicGuest()
    const res = await keepPost(
      nextRequest('/api/watch/cam/keep', { body: 'nope', ip: GUEST_IP }),
      routeParams('cam'),
    )
    expect(res.status).toBe(400)
  })

  it('works for a Discord viewer on a public path, who gets a pony', async () => {
    setPathVisibility('cam', 'public')
    useFakeDerpibooru()
    asDiscord('42', 'Luna')

    const res = await keep({ keep: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kept: true })
  })
})

describe('POST /api/watch/[path]/avatar', () => {
  it('rerolls the avatar and reports the cooldown', async () => {
    publicGuest()
    const booru = useFakeDerpibooru()

    const res = await avatar()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      image: expect.stringMatching(/^https:\/\/cdn\.booru\.test\/img\/\d+\/thumb_small\.png$/),
      favoriteTag: null,
      favoriteTagMatched: null,
      rerollInMs: 30_000,
    })
    expect(booru.requests).toHaveLength(1)
    expect(booru.requests[0].searchParams.get('per_page')).toBe('3')
    expect(booru.requests[0].searchParams.get('sf')).toBe('random')
  })

  it('429 with rerollInMs for a second reroll within 30 seconds', async () => {
    publicGuest()
    const booru = useFakeDerpibooru()
    await avatar()

    const res = await avatar()

    expect(res.status).toBe(429)
    const { rerollInMs } = await res.json()
    expect(rerollInMs).toBeGreaterThan(0)
    expect(rerollInMs).toBeLessThanOrEqual(30_000)
    expect(booru.requests).toHaveLength(1)
  })

  it('allows another reroll after the cooldown', async () => {
    useFakeClock()
    publicGuest()
    useFakeDerpibooru()
    expect((await avatar()).status).toBe(200)
    expect((await avatar()).status).toBe(429)

    await vi.advanceTimersByTimeAsync(30_001)

    expect((await avatar()).status).toBe(200)
  })

  it('has a separate cooldown for each guest', async () => {
    publicGuest()
    useFakeDerpibooru()
    expect((await avatar('cam', GUEST_IP)).status).toBe(200)
    expect((await avatar('cam', OTHER_IP)).status).toBe(200)
  })

  it('still answers 200 (no new image) when the booru is unreachable', async () => {
    publicGuest()
    useFakeDerpibooru({ status: 500 })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await avatar()

    expect(res.status).toBe(200)
    expect((await res.json()).image).toBeNull()
  })
})

describe('POST /api/watch/[path]/tag', () => {
  it.each([
    ['a number', { tag: 5 }],
    ['a missing tag', {}],
    ['an undefined body field', { tag: undefined }],
  ])('400 for %s', async (_label, body) => {
    publicGuest()
    expect((await tag(body)).status).toBe(400)
  })

  it.each([
    ['blank', '   '],
    ['containing a comma', 'a,b'],
    ['only dashes', '--'],
    ['too long', 'x'.repeat(61)],
  ])('400 "Not a valid tag" for a tag that is %s', async (_label, value) => {
    publicGuest()
    const res = await tag({ tag: value })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Not a valid tag')
  })

  it('400 for a body that is not JSON', async () => {
    publicGuest()
    const res = await tagPost(
      nextRequest('/api/watch/cam/tag', { body: 'nope', ip: GUEST_IP }),
      routeParams('cam'),
    )
    expect(res.status).toBe(400)
  })

  it('sets a valid tag, normalized, and searches the booru for it', async () => {
    publicGuest()
    const booru = useFakeDerpibooru()

    const res = await tag({ tag: ' -Rainbow   Dash ' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      favoriteTag: 'rainbow dash',
      favoriteTagMatched: true,
      rerollInMs: 30_000,
    })
    expect(booru.requests.map((r) => r.searchParams.get('q'))).toContainEqual(
      expect.stringContaining('"rainbow dash"'),
    )
    expect(getGuestIdentity('cam', GUEST_IP)?.favorite_tag).toBe('rainbow dash')
  })

  it('reports favoriteTagMatched:false when the booru has nothing with the tag', async () => {
    publicGuest()
    const booru = useFakeDerpibooru()
    booru.respondWith({ urls: [] })

    const res = await tag({ tag: 'obscure' })

    expect(res.status).toBe(200)
    expect((await res.json()).favoriteTagMatched).toBe(false)
  })

  it('does not consume the cooldown when the tag is unchanged', async () => {
    publicGuest()
    useFakeDerpibooru()

    // The guest has no favorite tag yet, so clearing it changes nothing.
    const unchanged = await tag({ tag: null })
    expect(unchanged.status).toBe(200)
    expect(await unchanged.json()).toMatchObject({
      favoriteTag: null,
      favoriteTagMatched: null,
      rerollInMs: 0,
    })

    // So a real change right afterwards is not rate limited.
    expect((await tag({ tag: 'twilight sparkle' })).status).toBe(200)
  })

  it('answers an unchanged tag with the remaining cooldown, without a new search', async () => {
    publicGuest()
    const booru = useFakeDerpibooru()
    await tag({ tag: 'twilight sparkle' })
    const before = booru.requests.length

    const res = await tag({ tag: 'Twilight Sparkle' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.favoriteTag).toBe('twilight sparkle')
    expect(body.rerollInMs).toBeGreaterThan(0)
    expect(booru.requests).toHaveLength(before)
  })

  it('429 for a different tag within the cooldown', async () => {
    publicGuest()
    useFakeDerpibooru()
    await tag({ tag: 'twilight sparkle' })

    const res = await tag({ tag: 'rarity' })

    expect(res.status).toBe(429)
    expect((await res.json()).rerollInMs).toBeGreaterThan(0)
    expect(getGuestIdentity('cam', GUEST_IP)?.favorite_tag).toBe('twilight sparkle')
  })

  it('shares its cooldown with the avatar reroll', async () => {
    publicGuest()
    useFakeDerpibooru()
    await avatar()

    expect((await tag({ tag: 'rarity' })).status).toBe(429)
  })

  it('clears the tag with null (after the cooldown)', async () => {
    publicGuest()
    useFakeDerpibooru()
    await tag({ tag: 'rarity' })
    // Faked from now on (the booru request spacing and the cooldown both use Date).
    useFakeClock(Date.now())
    await vi.advanceTimersByTimeAsync(30_001)

    const res = await tag({ tag: null })

    expect(res.status).toBe(200)
    expect((await res.json()).favoriteTag).toBeNull()
    expect(getGuestIdentity('cam', GUEST_IP)?.favorite_tag).toBeNull()
  })
})
