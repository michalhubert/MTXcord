import { describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/dock/password/route'
import { approveAccess, isApproved } from '@/lib/accessRequests'
import {
  getViewerPassword,
  rotateViewerPassword,
  setPathVisibility,
  setViewerPassword,
} from '@/lib/db'
import { useFakeMediamtx } from '../helpers/msw'
import { nextRequest } from '../helpers/request'
import { asDiscord, asGuest, asStreamer, asTrusted, signedOut } from '../helpers/session'
import { trustNetworks } from '../helpers/trust'
import { GUEST_IP, OTHER_IP, goLive, installFakeMediamtx, whep } from './_support'

const rotate = (path?: string) =>
  POST(
    nextRequest(`/api/dock/password${path ? `?path=${path}` : ''}`, {
      method: 'POST',
    }),
  )

describe('POST /api/dock/password', () => {
  describe('authorization', () => {
    it.each([
      ['signed out', () => signedOut()],
      ['a guest', () => asGuest('pw')],
      ['a Discord viewer', () => asDiscord('42', 'Luna')],
    ])('401 for %s, and nothing changes', async (_label, signIn) => {
      const fake = useFakeMediamtx()
      signIn()

      const res = await rotate()

      expect(res.status).toBe(401)
      expect(getViewerPassword('default')).toBeNull()
      expect(fake.requests).toHaveLength(0)
    })

    it('allows anyone when DISABLE_DOCK_AUTH is true', async () => {
      useFakeMediamtx()
      vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
      signedOut()

      const res = await rotate()

      expect(res.status).toBe(200)
      expect(getViewerPassword('default')).not.toBeNull()
    })
  })

  describe('rotation', () => {
    it('returns a new 32-hex password and stores it for "default"', async () => {
      useFakeMediamtx()
      asStreamer()

      const res = await rotate()

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      const { password } = await res.json()
      expect(password).toMatch(/^[0-9a-f]{32}$/)
      expect(getViewerPassword('default')).toBe(password)
    })

    it('stores the password for the path given in ?path=, leaving others alone', async () => {
      useFakeMediamtx()
      asStreamer()
      const defaultPassword = rotateViewerPassword('default')

      const { password } = await (await rotate('cam')).json()

      expect(getViewerPassword('cam')).toBe(password)
      expect(password).not.toBe(defaultPassword)
      expect(getViewerPassword('default')).toBe(defaultPassword)
    })

    it('generates a different password every time', async () => {
      useFakeMediamtx()
      asStreamer()

      const a = (await (await rotate()).json()).password
      const b = (await (await rotate()).json()).password

      expect(a).not.toBe(b)
    })

    it('still rotates when MediaMTX is unreachable', async () => {
      const fake = useFakeMediamtx()
      fake.setDown(true)
      asStreamer()

      const res = await rotate()

      expect(res.status).toBe(200)
      expect(getViewerPassword('default')).toBe((await res.json()).password)
    })
  })

  describe('old sessions', () => {
    it('makes guests holding the old password get 401 on WHEP, and the new one work', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      const oldPassword = rotateViewerPassword('default')
      asGuest(oldPassword)
      expect((await whep('cam')).res.status).toBe(201)

      asStreamer()
      const { password } = await (await rotate()).json()

      asGuest(oldPassword)
      expect((await whep('cam')).res.status).toBe(401)
      asGuest(password)
      expect((await whep('cam')).res.status).toBe(201)
    })

    it('a path-specific rotation leaves guests of the default password alone', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      const defaultPassword = rotateViewerPassword('default')
      asGuest(defaultPassword)

      asStreamer()
      await rotate('other')

      asGuest(defaultPassword)
      expect((await whep('cam')).res.status).toBe(201)
    })
  })

  describe('approvals', () => {
    it('drops approvals of password viewers on that path, but keeps Discord approvals', async () => {
      useFakeMediamtx()
      asStreamer()
      approveAccess('cam', GUEST_IP, 'viewer')
      approveAccess('cam', 'discord:42', 'discord')

      await rotate('cam')

      expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
      expect(isApproved('cam', 'discord:42', 'discord')).toBe(true)
    })

    it('rotating "default" also drops approvals on paths without their own password', async () => {
      useFakeMediamtx()
      asStreamer()
      setViewerPassword('own', 'own-password')
      approveAccess('inherits', GUEST_IP, 'viewer')
      approveAccess('own', GUEST_IP, 'viewer')

      await rotate()

      expect(isApproved('inherits', GUEST_IP, 'viewer')).toBe(false)
      expect(isApproved('own', GUEST_IP, 'viewer')).toBe(true)
    })

    it('keeps the approval of a guest on a trusted network, and drops other guests approvals', async () => {
      useFakeMediamtx()
      trustNetworks('10.250.0.0/16')
      asStreamer()
      approveAccess('cam', '10.250.0.5', 'viewer')
      approveAccess('cam', GUEST_IP, 'viewer')

      await rotate('cam')

      expect(isApproved('cam', '10.250.0.5', 'viewer')).toBe(true)
      expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
    })

    it('rotating a path-specific password leaves other paths\' approvals', async () => {
      useFakeMediamtx()
      asStreamer()
      approveAccess('cam', GUEST_IP, 'viewer')
      approveAccess('other', GUEST_IP, 'viewer')

      await rotate('cam')

      expect(isApproved('cam', GUEST_IP, 'viewer')).toBe(false)
      expect(isApproved('other', GUEST_IP, 'viewer')).toBe(true)
    })
  })

  describe('kicking live sessions', () => {
    // Real WHEP POSTs as different users, so the route's getViewerIdentity() works.
    async function setup() {
      const fake = installFakeMediamtx()
      for (const path of ['inherits', 'own']) {
        goLive(fake, path)
        setPathVisibility(path, 'public')
      }
      const defaultPassword = rotateViewerPassword('default')
      const ownPassword = rotateViewerPassword('own')

      asGuest(defaultPassword)
      const inherits = (await whep('inherits', GUEST_IP)).id!
      asGuest(ownPassword)
      const own = (await whep('own', OTHER_IP)).id!
      asDiscord('42', 'Luna')
      const discord = (await whep('inherits', '198.51.100.9')).id!
      asStreamer()
      const streamer = (await whep('inherits', '198.51.100.10')).id!
      return { fake, inherits, own, discord, streamer }
    }

    it('rotating "default" kicks only viewer sessions on paths that fall back to it', async () => {
      const { fake, inherits } = await setup()

      await rotate()

      expect(fake.kickedIds()).toEqual([inherits])
    })

    it('rotating a path kicks only the viewer sessions on that path', async () => {
      const { fake, own } = await setup()

      await rotate('own')

      expect(fake.kickedIds()).toEqual([own])
    })

    it('rotating an unrelated path kicks nobody', async () => {
      const { fake } = await setup()

      await rotate('unrelated')

      expect(fake.kicks()).toHaveLength(0)
    })

    it('keeps trusted-network sessions connected and kicks password guests, whatever their IP', async () => {
      const fake = installFakeMediamtx()
      goLive(fake, 'cam')
      trustNetworks('10.250.0.0/16')
      asTrusted()
      approveAccess('cam', '10.250.0.5', 'viewer')
      const trustedId = (await whep('cam', '10.250.0.5')).id!
      asGuest(rotateViewerPassword('default'))
      approveAccess('cam', GUEST_IP, 'viewer')
      const guestId = (await whep('cam', GUEST_IP)).id!
      // A password guest who happens to sit on a trusted IP: the session is stale after
      // rotation, so it must be kicked even though the IP is trusted.
      approveAccess('cam', '10.250.0.6', 'viewer')
      const trustedIpGuestId = (await whep('cam', '10.250.0.6')).id!
      asStreamer()

      await rotate()

      expect(fake.kickedIds().sort()).toEqual([guestId, trustedIpGuestId].sort())
      expect(fake.kickedIds()).not.toContain(trustedId)
      asTrusted()
      expect((await whep('cam', '10.250.0.5')).res.status).toBe(201)
    })

    it('kicks a trusted-network session whose IP is no longer trusted', async () => {
      const fake = installFakeMediamtx()
      goLive(fake, 'cam')
      trustNetworks('10.250.0.0/16')
      asTrusted()
      approveAccess('cam', '10.250.0.5', 'viewer')
      const trustedId = (await whep('cam', '10.250.0.5')).id!
      trustNetworks('192.168.0.0/16')
      asStreamer()

      await rotate()

      expect(fake.kickedIds()).toEqual([trustedId])
    })

    it('never kicks Discord viewers or the streamer', async () => {
      const { fake, discord, streamer } = await setup()

      await rotate()
      await rotate('own')

      expect(fake.kickedIds()).not.toContain(discord)
      expect(fake.kickedIds()).not.toContain(streamer)
    })

    it('does not kick sessions MediaMTX knows but the app never saw (no identity)', async () => {
      const fake = useFakeMediamtx()
      asStreamer()
      fake.addSession({ path: 'default', state: 'read' })

      await rotate()

      expect(fake.kicks()).toHaveLength(0)
    })

    it('kicks every matching viewer session', async () => {
      const fake = useFakeMediamtx()
      goLive(fake, 'cam')
      setPathVisibility('cam', 'public')
      asGuest(rotateViewerPassword('default'))
      const a = (await whep('cam', GUEST_IP)).id!
      const b = (await whep('cam', OTHER_IP)).id!
      asStreamer()

      await rotate()

      expect(fake.kickedIds().sort()).toEqual([a, b].sort())
      expect(fake.sessions()).toHaveLength(0)
    })
  })
})
