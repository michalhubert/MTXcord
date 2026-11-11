import { expect, test } from './fixtures'
import { APP_URL, HOOK_SECRET } from './env'

// Plain HTTP checks against the running app: no browser, no sessions.
const noRedirects = { maxRedirects: 0 }

test.describe('access guards', () => {
  test('anonymous /dock redirects to the streamer login', async ({ request }) => {
    const res = await request.get('/dock', noRedirects)
    expect(res.status()).toBeGreaterThanOrEqual(300)
    expect(res.status()).toBeLessThan(400)
    const location = new URL(res.headers()['location'], APP_URL)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('callbackUrl')).toBe('/dock')
    expect(location.searchParams.get('mode')).toBe('streamer')
  })

  test('anonymous WHEP request redirects to the login page', async ({ request }) => {
    const res = await request.post('/api/whep/someStream', {
      ...noRedirects,
      headers: { 'Content-Type': 'application/sdp' },
      data: 'v=0',
    })
    expect(res.status()).toBeGreaterThanOrEqual(300)
    expect(res.status()).toBeLessThan(400)
    const location = new URL(res.headers()['location'], APP_URL)
    expect(location.pathname).toBe('/login')
    // A viewer route, so no streamer mode.
    expect(location.searchParams.get('mode')).toBeNull()
  })

  test('cross-site POSTs are blocked', async ({ request }) => {
    const res = await request.post('/api/whep/someStream', {
      ...noRedirects,
      headers: { 'Content-Type': 'application/sdp', 'sec-fetch-site': 'cross-site' },
      data: 'v=0',
    })
    expect(res.status()).toBe(403)
  })

  test('the stream hook needs the shared secret', async ({ request }) => {
    const hook = (headers: Record<string, string>) =>
      request.post('/api/streams/hook', {
        ...noRedirects,
        headers,
        data: { path: 'guardsHook', action: 'read' },
      })

    expect((await hook({})).status()).toBe(401)
    expect((await hook({ 'x-hook-secret': 'wrong-secret' })).status()).toBe(401)
    expect((await hook({ 'x-hook-secret': HOOK_SECRET })).status()).toBe(200)
  })
})
