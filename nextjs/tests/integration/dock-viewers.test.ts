import { describe, expect, it, vi } from 'vitest'
import { POST as avatarPost } from '@/app/api/dock/viewers/avatar/route'
import { DELETE } from '@/app/api/dock/viewers/route'
import { getBlock } from '@/lib/accessBlocks'
import { approveAccess, isApproved } from '@/lib/accessRequests'
import { rotateViewerPassword, setPathVisibility } from '@/lib/db'
import { useFakeClock } from '../helpers/clock'
import { useFakeDerpibooru, useFakeMediamtx } from '../helpers/msw'
import { nextRequest } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import { GUEST_IP, OTHER_IP, goLive, installFakeMediamtx, whep } from './_support'

const kick = (id?: string) =>
  DELETE(
    nextRequest(`/api/dock/viewers${id === undefined ? '' : `?id=${id}`}`, {
      method: 'DELETE',
    }),
  )
const reroll = (id?: string) =>
  avatarPost(
    nextRequest(`/api/dock/viewers/avatar${id === undefined ? '' : `?id=${id}`}`, {
      method: 'POST',
    }),
  )

describe.each([
  ['DELETE /api/dock/viewers', kick],
  ['POST /api/dock/viewers/avatar', reroll],
])('%s authorization', (_name, run) => {
  it.each([
    ['signed out', () => signedOut()],
    ['a guest', () => asGuest('pw')],
    ['a Discord viewer', () => asDiscord('42', 'Luna')],
  ])('401 for %s', async (_label, signIn) => {
    const fake = useFakeMediamtx()
    signIn()
    expect((await run('some-id')).status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('400 when the session id is missing', async () => {
    useFakeMediamtx()
    asStreamer()
    expect((await run()).status).toBe(400)
  })
})

describe('DELETE /api/dock/viewers (kick)', () => {
  async function guestWatching(path = 'cam', ip = GUEST_IP) {
    const fake = installFakeMediamtx()
    goLive(fake, path)
    setPathVisibility(path, 'public')
    asGuest(rotateViewerPassword('default'))
    const { id } = await whep(path, ip)
    asStreamer()
    return { fake, id: id! }
  }

  it('ends the MediaMTX session and answers {ok: true}', async () => {
    const { fake, id } = await guestWatching()

    const res = await kick(id)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(fake.kickedIds()).toEqual([id])
    expect(fake.kicks()[0].authorized).toBe(true)
    expect(fake.sessions()).toHaveLength(0)
  })

  it('blocks the viewer so an immediate reconnect gets 403', async () => {
    const { id } = await guestWatching()

    await kick(id)

    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toMatchObject({
      reason: 'kicked',
    })
    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam', GUEST_IP)).res.status).toBe(403)
  })

  it('only blocks that viewer\'s address', async () => {
    const { id } = await guestWatching()

    await kick(id)

    expect(getBlock('cam', { role: 'viewer', ip: OTHER_IP })).toBeNull()
    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam', OTHER_IP)).res.status).toBe(201)
  })

  it('only blocks them on that path', async () => {
    const { fake, id } = await guestWatching('cam')
    goLive(fake, 'other')
    setPathVisibility('other', 'public')

    await kick(id)

    asGuest(rotateViewerPassword('default'))
    expect((await whep('other', GUEST_IP)).res.status).toBe(201)
  })

  it('revokes the approval of a viewer on a private path', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asGuest(rotateViewerPassword('default'))
    approveAccess('cam', GUEST_IP, 'viewer')
    const { id } = await whep('cam', GUEST_IP)
    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)
    asStreamer()

    await kick(id!)

    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam', GUEST_IP)).res.status).toBe(403)
  })

  it('blocks and revokes a Discord viewer by account, wherever they connect from', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asDiscord('42', 'Luna')
    approveAccess('cam', 'discord:42', 'discord')
    const { id } = await whep('cam', GUEST_IP)
    asStreamer()

    await kick(id!)

    expect(isApproved('cam', 'discord:42', 'discord')).toBe(false)
    expect(getBlock('cam', { role: 'discord', discordId: '42' })).toMatchObject({
      reason: 'kicked',
    })
    asDiscord('42', 'Luna')
    expect((await whep('cam', OTHER_IP)).res.status).toBe(403)
    // A different account is unaffected.
    asDiscord('43', 'Celestia')
    approveAccess('cam', 'discord:43', 'discord')
    expect((await whep('cam', GUEST_IP)).res.status).toBe(201)
  })

  it('escalates the block on a repeated kick (1 minute, then 5)', async () => {
    useFakeClock(Date.now())
    const { id } = await guestWatching()

    await kick(id)
    const first = getBlock('cam', { role: 'viewer', ip: GUEST_IP })!
    expect(first.blockedUntil - Date.now()).toBe(60_000)

    // Back in after the block ran out, kicked again.
    await vi.advanceTimersByTimeAsync(61_000)
    asGuest(rotateViewerPassword('default'))
    const again = (await whep('cam', GUEST_IP)).id!
    asStreamer()
    await kick(again)

    const second = getBlock('cam', { role: 'viewer', ip: GUEST_IP })!
    expect(second.blockedUntil - Date.now()).toBe(5 * 60_000)
  })

  it('answers 502 for a session MediaMTX does not know, while still contacting MediaMTX', async () => {
    const fake = useFakeMediamtx()
    asStreamer()

    const res = await kick('ghost-session')

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'MediaMTX API unreachable or session not found',
    })
    expect(fake.kickedIds()).toEqual(['ghost-session'])
  })

  it('does not block anybody when the session has no remembered identity', async () => {
    const fake = useFakeMediamtx()
    asStreamer()
    const session = fake.addSession({ path: 'cam', state: 'read' })

    const res = await kick(session.id)

    expect(res.status).toBe(200)
    expect(fake.kickedIds()).toEqual([session.id])
    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
  })

  it('answers 502 when MediaMTX is down, without blocking the viewer', async () => {
    const { fake, id } = await guestWatching()
    fake.setDown(true)

    const res = await kick(id)

    expect(res.status).toBe(502)
    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
    fake.setDown(false)
    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam', GUEST_IP)).res.status).toBe(201)
  })

  it('keeps the approval intact when the MediaMTX kick fails', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asGuest(rotateViewerPassword('default'))
    approveAccess('cam', GUEST_IP, 'viewer')
    const { id } = await whep('cam', GUEST_IP)
    asStreamer()
    fake.setDown(true)

    expect((await kick(id!)).status).toBe(502)

    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)
    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
  })

  it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
    const { fake, id } = await guestWatching()
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    signedOut()

    expect((await kick(id)).status).toBe(200)
    expect(fake.kickedIds()).toEqual([id])
  })
})

describe('POST /api/dock/viewers/avatar', () => {
  it('400 "no pony identity" for an unknown session', async () => {
    useFakeMediamtx()
    asStreamer()
    const res = await reroll('ghost')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Viewer has no pony identity')
  })

  it('400 for a viewer who is shown with their own identity (Discord on a private path)', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asDiscord('42', 'Luna')
    approveAccess('cam', 'discord:42', 'discord')
    const { id } = await whep('cam')
    asStreamer()

    expect((await reroll(id!)).status).toBe(400)
  })

  it('400 for the streamer', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asStreamer()
    const { id } = await whep('cam')

    expect((await reroll(id!)).status).toBe(400)
  })

  it('rerolls a guest\'s avatar and returns the new image', async () => {
    const booru = useFakeDerpibooru()
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    setPathVisibility('cam', 'public')
    asGuest(rotateViewerPassword('default'))
    const { id } = await whep('cam')
    asStreamer()

    const res = await reroll(id!)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      image: expect.stringMatching(/^https:\/\/cdn\.booru\.test\//),
    })
    expect(booru.requests.length).toBeGreaterThan(0)
  })

  it('is not limited by the guest cooldown', async () => {
    useFakeDerpibooru()
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    setPathVisibility('cam', 'public')
    asGuest(rotateViewerPassword('default'))
    const { id } = await whep('cam')
    asStreamer()

    expect((await reroll(id!)).status).toBe(200)
    expect((await reroll(id!)).status).toBe(200)
  })
})
