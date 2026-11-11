import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))

import type { SessionUser } from '@/lib/authz'
import { trustedLogin } from '@/lib/trustedLogin'
import { trustNetworks } from '../../helpers/trust'

const TRUSTED_IP = '10.250.0.5'
const OUTSIDE_IP = '203.0.113.10'

const guest: SessionUser = { id: 'viewer', name: null, image: null, role: 'viewer', password: 'pw' }
const trustedSession: SessionUser = {
  id: 'viewer',
  name: null,
  image: null,
  role: 'viewer',
  trusted: true,
}
const discord: SessionUser = { id: '42', name: 'Luna', image: null, role: 'discord' }
const streamer: SessionUser = { id: 'streamer', name: null, image: null, role: 'streamer' }

type Input = Partial<Parameters<typeof trustedLogin>[0]>
const decide = (input: Input = {}) =>
  trustedLogin({
    user: undefined,
    revoked: false,
    mode: undefined,
    manual: undefined,
    ip: TRUSTED_IP,
    ...input,
  })
const OFFERED = { trusted: true, autoSignIn: true }
const NOT_OFFERED = { trusted: false, autoSignIn: false }

beforeEach(() => trustNetworks('10.250.0.0/16'))

describe('trustedLogin', () => {
  it('signs in automatically when nobody is signed in', () => {
    expect(decide()).toEqual(OFFERED)
  })

  it('does nothing for a client outside the trusted networks', () => {
    expect(decide({ ip: OUTSIDE_IP })).toEqual(NOT_OFFERED)
    expect(decide({ ip: 'unknown' })).toEqual(NOT_OFFERED)
  })

  it('does not offer it to a Discord session, so it is never replaced', () => {
    expect(decide({ user: discord })).toEqual(NOT_OFFERED)
  })

  it('does not offer it to a streamer session, so it is never replaced', () => {
    expect(decide({ user: streamer })).toEqual(NOT_OFFERED)
  })

  it('is not trusted at all in streamer mode', () => {
    expect(decide({ mode: 'streamer' })).toEqual(NOT_OFFERED)
  })

  it('offers the button but does not sign in again after signing out (manual=1)', () => {
    expect(decide({ manual: '1' })).toEqual({ trusted: true, autoSignIn: false })
  })

  it('only honours manual=1 exactly', () => {
    expect(decide({ manual: '0' }).autoSignIn).toBe(true)
    expect(decide({ manual: ['1', '1'] }).autoSignIn).toBe(true)
  })

  describe('a password guest', () => {
    it('is replaced when the session is revoked (stale viewer password)', () => {
      expect(decide({ user: guest, revoked: true })).toEqual(OFFERED)
    })

    it('keeps a session that is still valid, and is not offered the button', () => {
      expect(decide({ user: guest, revoked: false })).toEqual(NOT_OFFERED)
    })
  })

  it('keeps a valid trusted session', () => {
    expect(decide({ user: trustedSession })).toEqual(NOT_OFFERED)
  })

  it('does not auto sign in without CLIENT_IP_HEADER, as nobody is trusted then', () => {
    vi.stubEnv('CLIENT_IP_HEADER', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(decide()).toEqual(NOT_OFFERED)
  })
})
