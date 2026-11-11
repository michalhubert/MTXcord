import { describe, expect, it, vi } from 'vitest'

// auth(handler) returns the handler itself, so tests call it with a fake request.
vi.mock('next-auth', () => ({
  default: () => ({ auth: (handler: unknown) => handler }),
}))

import { proxy } from '@/proxy'
import { nextRequest } from '../helpers/request'

type Role = 'streamer' | 'viewer' | 'discord'

function run(
  path: string,
  opts: {
    method?: string
    role?: Role | null
    fetchSite?: string
  } = {},
): Response | undefined {
  const req = nextRequest(path, {
    method: opts.method ?? 'GET',
    headers: opts.fetchSite ? { 'sec-fetch-site': opts.fetchSite } : undefined,
  })
  const withAuth = Object.assign(req, {
    auth: opts.role ? { user: { role: opts.role } } : null,
  })
  return (proxy as unknown as (r: typeof withAuth) => Response | undefined)(withAuth)
}

/** 'pass' for fall-through / NextResponse.next(); otherwise the redirect target or status. */
function outcome(res: Response | undefined): string {
  if (!res) return 'pass'
  if (res.headers.get('x-middleware-next') === '1') return 'pass'
  const location = res.headers.get('location')
  if (location) {
    const url = new URL(location)
    return `${res.status} ${url.pathname}${url.search}`
  }
  return String(res.status)
}

describe('cross-site protection', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks cross-site %s', (method) => {
    expect(outcome(run('/api/anything', { method, role: 'streamer', fetchSite: 'cross-site' }))).toBe('403')
  })

  it('blocks same-site (other subdomain) writes', () => {
    expect(outcome(run('/api/anything', { method: 'POST', role: 'streamer', fetchSite: 'same-site' }))).toBe('403')
  })

  it('blocks unknown sec-fetch-site values', () => {
    expect(outcome(run('/api/x', { method: 'POST', role: 'viewer', fetchSite: 'weird' }))).toBe('403')
  })

  it.each(['same-origin', 'none'])('allows %s writes', (fetchSite) => {
    expect(outcome(run('/api/x', { method: 'POST', role: 'viewer', fetchSite }))).toBe('pass')
  })

  it('allows writes without the header (non-browser clients)', () => {
    expect(outcome(run('/api/x', { method: 'POST', role: 'viewer' }))).toBe('pass')
  })

  it.each(['GET', 'HEAD'])('allows cross-site %s', (method) => {
    expect(outcome(run('/live', { method, role: 'viewer', fetchSite: 'cross-site' }))).toBe('pass')
  })

  it('blocks cross-site writes even to the hook and for anonymous users', () => {
    expect(outcome(run('/api/streams/hook', { method: 'POST', fetchSite: 'cross-site' }))).toBe('403')
    expect(outcome(run('/login', { method: 'POST', fetchSite: 'cross-site' }))).toBe('403')
  })
})

describe('the MediaMTX hook', () => {
  it('is always allowed through, signed in or not', () => {
    expect(outcome(run('/api/streams/hook', { method: 'POST' }))).toBe('pass')
    expect(outcome(run('/api/streams/hook', { method: 'POST', role: 'viewer' }))).toBe('pass')
  })

  it('only matches that exact path', () => {
    expect(outcome(run('/api/streams/hook/extra', { method: 'POST' }))).toBe(
      '302 /login?callbackUrl=%2Fapi%2Fstreams%2Fhook%2Fextra',
    )
    expect(outcome(run('/api/streamsX', { method: 'POST' }))).toBe(
      '302 /login?callbackUrl=%2Fapi%2FstreamsX',
    )
  })
})

describe('anonymous visitors', () => {
  it('are sent to the viewer login with a callback', () => {
    expect(outcome(run('/live'))).toBe('302 /login?callbackUrl=%2Flive')
    expect(outcome(run('/'))).toBe('302 /login?callbackUrl=%2F')
    expect(outcome(run('/api/watch/live'))).toBe('302 /login?callbackUrl=%2Fapi%2Fwatch%2Flive')
  })

  it.each([
    '/dock',
    '/dock/sub',
    '/stream',
    '/api/mediamtx/x',
    '/api/dock/viewers',
    '/api/stream/settings',
    '/api/streams/visibility',
    '/api/streams/pending',
    '/api/whip/live',
  ])('are sent to the streamer login from %s', (path) => {
    const res = outcome(run(path))
    expect(res).toBe(`302 /login?callbackUrl=${encodeURIComponent(path)}&mode=streamer`)
  })

  it.each(['/api/streams/hook-x', '/api/streamsX', '/docker', '/streams', '/dockx/y'])(
    'get the viewer login (not the dock) from %s',
    (path) => {
      expect(outcome(run(path))).toBe(`302 /login?callbackUrl=${encodeURIComponent(path)}`)
    },
  )

  it('may open the login page and the auth API', () => {
    expect(outcome(run('/login'))).toBe('pass')
    expect(outcome(run('/login', { method: 'POST' }))).toBe('pass')
    expect(outcome(run('/api/auth/session'))).toBe('pass')
    expect(outcome(run('/api/auth/callback/discord'))).toBe('pass')
  })
})

describe('signed-in visitors', () => {
  it.each<Role>(['viewer', 'discord', 'streamer'])('%s can open stream pages', (role) => {
    expect(outcome(run('/live', { role }))).toBe('pass')
    expect(outcome(run('/api/watch/live', { role }))).toBe('pass')
  })

  it('lets the streamer into the dock area', () => {
    expect(outcome(run('/dock', { role: 'streamer' }))).toBe('pass')
    expect(outcome(run('/api/dock/viewers', { role: 'streamer', method: 'POST' }))).toBe('pass')
    expect(outcome(run('/stream', { role: 'streamer' }))).toBe('pass')
  })

  it.each<Role>(['viewer', 'discord'])('sends %s from the dock area to the streamer login', (role) => {
    expect(outcome(run('/dock', { role }))).toBe('302 /login?callbackUrl=%2Fdock&mode=streamer')
    expect(outcome(run('/api/streams/pending', { role }))).toBe(
      '302 /login?callbackUrl=%2Fapi%2Fstreams%2Fpending&mode=streamer',
    )
    expect(outcome(run('/api/whip/live', { role, method: 'POST' }))).toBe(
      '302 /login?callbackUrl=%2Fapi%2Fwhip%2Flive&mode=streamer',
    )
  })

  it('does not treat a session without a role as the streamer', () => {
    const req = Object.assign(nextRequest('/dock'), { auth: { user: {} } })
    const res = (proxy as unknown as (r: typeof req) => Response | undefined)(req)
    expect(outcome(res)).toBe('302 /login?callbackUrl=%2Fdock&mode=streamer')
  })
})

describe('DISABLE_DOCK_AUTH=true', () => {
  it('lets anonymous visitors into the dock area', () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    expect(outcome(run('/dock'))).toBe('pass')
    expect(outcome(run('/api/streams/pending', { method: 'POST' }))).toBe('pass')
  })

  it('lets non-streamers into the dock area', () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    expect(outcome(run('/dock', { role: 'viewer' }))).toBe('pass')
  })

  it('still requires a login for everything else', () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    expect(outcome(run('/live'))).toBe('302 /login?callbackUrl=%2Flive')
  })

  it('still blocks cross-site writes', () => {
    vi.stubEnv('DISABLE_DOCK_AUTH', 'true')
    expect(outcome(run('/api/dock/viewers', { method: 'POST', fetchSite: 'cross-site' }))).toBe('403')
  })

  it.each(['1', 'TRUE', 'yes'])('is not triggered by %j', (value) => {
    vi.stubEnv('DISABLE_DOCK_AUTH', value)
    expect(outcome(run('/dock'))).toBe('302 /login?callbackUrl=%2Fdock&mode=streamer')
  })
})
