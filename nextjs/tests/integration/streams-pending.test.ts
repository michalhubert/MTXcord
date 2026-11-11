import { describe, expect, it, vi } from 'vitest'
import { POST as approvePost } from '@/app/api/streams/pending/approve/route'
import { POST as denyPost } from '@/app/api/streams/pending/deny/route'
import { GET as watchGet } from '@/app/api/watch/[path]/route'
import { getBlock, kickViewer } from '@/lib/accessBlocks'
import {
  isApproved,
  listPendingRequests,
  openAccessRequest,
  type AccessRequester,
} from '@/lib/accessRequests'
import { rotateViewerPassword } from '@/lib/db'
import type { WatchEvent } from '@/lib/watchRoomShared'
import { useFakeClock } from '../helpers/clock'
import { useFakeMediamtx } from '../helpers/msw'
import { nextRequest, routeParams } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, signedOut } from '../helpers/session'
import {
  GUEST_IP,
  OTHER_IP,
  goLive,
  installFakeMediamtx,
  openStream,
  whep,
} from './_support'

const post = (handler: typeof approvePost, body: unknown) =>
  handler(
    nextRequest('/api/streams/pending/x', { json: body }),
  )
const approve = (body: unknown) => post(approvePost, body)
const deny = (body: unknown) => post(denyPost, body)

const guestRequest = (ip = GUEST_IP, path = 'cam'): AccessRequester => ({
  path,
  ip,
  role: 'viewer',
  name: null,
  image: null,
  discordId: null,
  clientIp: ip,
})
const discordRequest = (id = '42', path = 'cam'): AccessRequester => ({
  path,
  ip: `discord:${id}`,
  role: 'discord',
  name: 'Luna',
  image: null,
  discordId: id,
  clientIp: GUEST_IP,
})

describe.each([
  ['approve', approve],
  ['deny', deny],
])('POST /api/streams/pending/%s request validation', (_name, run) => {
  it.each([
    ['signed out', () => signedOut()],
    ['a guest', () => asGuest('pw')],
    ['a Discord viewer', () => asDiscord('42', 'Luna')],
  ])('401 for %s, and nothing changes', async (_label, signIn) => {
    signIn()
    openAccessRequest(guestRequest())

    const res = await run({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(res.status).toBe(401)
    expect(listPendingRequests()).toHaveLength(1)
    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
  })

  it('allows an unauthenticated caller when DISABLE_DOCK_AUTH is true', async () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    signedOut()
    expect((await run({ path: 'cam', ip: GUEST_IP, role: 'viewer' })).status).toBe(200)
  })

  it('400 "Invalid JSON body" when the body is not JSON', async () => {
    asStreamer()
    const res = await (_name === 'approve' ? approvePost : denyPost)(
      nextRequest('/api/streams/pending/x', { method: 'POST', body: 'nope' }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it.each([
    ['an empty object', {}],
    ['a null body', null],
    ['a missing ip', { path: 'cam' }],
    ['a missing path', { ip: GUEST_IP }],
    ['an empty path', { path: '', ip: GUEST_IP }],
    ['an empty ip', { path: 'cam', ip: '' }],
    ['a non-string path', { path: 5, ip: GUEST_IP }],
    ['a non-string ip', { path: 'cam', ip: 5 }],
  ])('400 "Missing path or ip" for %s', async (_label, body) => {
    asStreamer()
    openAccessRequest(guestRequest())

    const res = await run(body)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing path or ip' })
    expect(listPendingRequests()).toHaveLength(1)
  })
})

describe('POST /api/streams/pending/approve', () => {
  it('approves the viewer and removes the request', async () => {
    asStreamer()
    openAccessRequest(guestRequest())

    const res = await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)
    expect(listPendingRequests()).toEqual([])
  })

  it('only approves that path, address and role', async () => {
    asStreamer()
    openAccessRequest(guestRequest())

    await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(isApproved('other', GUEST_IP, 'viewer')).toBe(false)
    expect(isApproved('cam', OTHER_IP, 'viewer')).toBe(false)
    expect(isApproved('cam', GUEST_IP, 'discord')).toBe(false)
  })

  it('leaves other pending requests alone', async () => {
    asStreamer()
    openAccessRequest(guestRequest(GUEST_IP))
    openAccessRequest(guestRequest(OTHER_IP))

    await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(listPendingRequests().map((r) => r.ip)).toEqual([OTHER_IP])
  })

  it('clears an existing block, so a kicked viewer can come back', async () => {
    asStreamer()
    kickViewer('cam', { role: 'viewer', ip: GUEST_IP })
    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).not.toBeNull()

    await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(getBlock('cam', { role: 'viewer', ip: GUEST_IP })).toBeNull()
  })

  it('approves Discord viewers by account (ip: "discord:<id>")', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    openAccessRequest(discordRequest('42'))
    asStreamer()

    await approve({ path: 'cam', ip: 'discord:42', role: 'discord' })

    expect(isApproved('cam', 'discord:42', 'discord')).toBe(true)
    expect(listPendingRequests()).toEqual([])
    // The account is let in from any address; another account is not.
    asDiscord('42', 'Luna')
    expect((await whep('cam', OTHER_IP)).res.status).toBe(201)
    asDiscord('43', 'Celestia')
    expect((await whep('cam', OTHER_IP)).res.status).toBe(403)
  })

  it('lets the approved guest through WHEP', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    asStreamer()
    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam')).res.status).toBe(403)

    asStreamer()
    await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    asGuest(rotateViewerPassword('default'))
    expect((await whep('cam')).res.status).toBe(201)
  })
})

describe('POST /api/streams/pending/deny', () => {
  it('removes the request and blocks the viewer as "denied" for a minute', async () => {
    useFakeClock(Date.now())
    asStreamer()
    openAccessRequest(guestRequest())

    const res = await deny({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(listPendingRequests()).toEqual([])
    const block = getBlock('cam', { role: 'viewer', ip: GUEST_IP })!
    expect(block.reason).toBe('denied')
    expect(block.blockedUntil - Date.now()).toBe(60_000)
    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
  })

  it('escalates on repeated denials (1 minute, 5, 15, then stays at 15)', async () => {
    useFakeClock(Date.now())
    asStreamer()
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      await deny({ path: 'cam', ip: GUEST_IP, role: 'viewer' })
      waits.push(
        getBlock('cam', { role: 'viewer', ip: GUEST_IP })!.blockedUntil -
          Date.now(),
      )
    }
    expect(waits).toEqual([60_000, 300_000, 900_000, 900_000])
  })

  it('revokes an existing approval', async () => {
    asStreamer()
    await approve({ path: 'cam', ip: GUEST_IP, role: 'viewer' })
    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(true)

    await deny({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
  })

  it('blocks only that address', async () => {
    asStreamer()

    await deny({ path: 'cam', ip: GUEST_IP, role: 'viewer' })

    expect(getBlock('cam', { role: 'viewer', ip: OTHER_IP })).toBeNull()
    expect(getBlock('other', { role: 'viewer', ip: GUEST_IP })).toBeNull()
  })

  it('blocks a Discord viewer by account', async () => {
    const fake = useFakeMediamtx()
    goLive(fake, 'cam')
    openAccessRequest(discordRequest('42'))
    asStreamer()

    await deny({ path: 'cam', ip: 'discord:42', role: 'discord' })

    expect(getBlock('cam', { role: 'discord', discordId: '42' })).toMatchObject({
      reason: 'denied',
    })
    expect(listPendingRequests()).toEqual([])
    asDiscord('42', 'Luna')
    expect((await whep('cam', OTHER_IP)).res.status).toBe(403)
  })
})

describe('approve / deny while the viewer waits on the gate', () => {
  async function waiting() {
    const fake = installFakeMediamtx()
    fake.setReady('cam', true)
    asGuest(rotateViewerPassword('default'))
    const stream = await openStream((signal) =>
      watchGet(
        nextRequest('/api/watch/cam?mode=gate', { ip: GUEST_IP, signal }),
        routeParams('cam'),
      ),
    )
    const state = (status: string) => (e: WatchEvent) =>
      e.type === 'state' && e.access.status === status
    await stream.sse.waitFor(state('pending'))
    expect(listPendingRequests()).toHaveLength(1)
    asStreamer()
    return { ...stream, state }
  }

  it('approve moves the waiting viewer to ok', async () => {
    const { sse, state } = await waiting()

    // The dock lists exactly the fields it posts back.
    const [pending] = listPendingRequests()
    await approve({ path: pending.path, ip: pending.ip, role: pending.role })

    await sse.waitFor(state('ok'))
    expect(listPendingRequests()).toEqual([])
  })

  it('deny moves the waiting viewer to blocked(denied)', async () => {
    const { sse, state } = await waiting()

    const [pending] = listPendingRequests()
    await deny({ path: pending.path, ip: pending.ip, role: pending.role })

    const events = await sse.waitFor(state('blocked'))
    expect(events.at(-1)).toMatchObject({
      access: { status: 'blocked', reason: 'denied' },
    })
  })
})
