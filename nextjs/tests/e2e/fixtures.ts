import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import {
  APP_URL,
  CLIENT_IP_HEADER,
  FAKE_URL,
  HOOK_SECRET,
  STREAMER_PASSWORD,
} from './env'

export { expect }

// ---------- unique names ----------

let counter = 0
const runId = Date.now().toString(36)

/** A stream path no other test uses (matches PATH_NAME_RE: /^[A-Za-z0-9/]{1,64}$/). */
export function uniquePath(): string {
  return `e2e${runId}x${(counter++).toString(36)}`
}

/** A client IP no other test uses (the login throttle is per IP). */
export function uniqueIp(): string {
  const n = counter++
  return `198.51.${100 + Math.floor(n / 250)}.${(n % 250) + 1}`
}

/** Matches an IP as a whole token ("198.51.100.1" must not match "198.51.100.12"). */
export function ipPattern(ip: string): RegExp {
  return new RegExp(ip.replaceAll('.', '\\.') + '(?!\\d)')
}

// ---------- fake MediaMTX control ----------

export type FakeState = {
  sessions: { id: string; path: string; state: string; peerConnectionEstablished: boolean }[]
  requests: { method: string; path: string; authorized: boolean; body?: string }[]
  kickedIds: string[]
  whepPosts: { method: string; path: string; authorized: boolean }[]
}

async function control<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${FAKE_URL}/__fake/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`fake ${path} failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

export const fake = {
  reset: () => control('reset'),
  setReady: (path: string, ready: boolean) => control('setReady', { path, ready }),
  state: () => control<FakeState>('state'),
  /** Number of WHEP offers the app has forwarded for `path`. */
  async whepCount(path: string): Promise<number> {
    const { whepPosts } = await fake.state()
    return whepPosts.filter((r) => r.path === `/${path}/whep`).length
  },
}

/** What MediaMTX's hook scripts do: the stream becomes ready, and the app is told. */
async function hook(path: string, action: 'ready' | 'notReady') {
  const res = await fetch(`${APP_URL}/api/streams/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hook-secret': HOOK_SECRET },
    body: JSON.stringify({ path, action }),
  })
  if (!res.ok) throw new Error(`hook ${action} failed: HTTP ${res.status}`)
}

export async function goLive(path: string) {
  await fake.setReady(path, true)
  await hook(path, 'ready')
}

export async function goOffline(path: string) {
  await fake.setReady(path, false)
  await hook(path, 'notReady')
}

// ---------- browser clients (one context per person) ----------

export type Client = { context: BrowserContext; page: Page; ip: string }

function isExternal(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1'
}

export async function newClient(browser: Browser, ip = uniqueIp()): Promise<Client> {
  const context = await browser.newContext({
    baseURL: APP_URL,
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { [CLIENT_IP_HEADER]: ip },
  })
  // Nothing outside this machine (Discord CDN, STUN hosts over HTTP, ...) is reachable.
  await context.route(isExternal, (route) => route.abort())
  return { context, page: await context.newPage(), ip }
}

// ---------- UI flows ----------

export async function loginAsStreamer(page: Page) {
  await page.goto('/login?mode=streamer&callbackUrl=/dock')
  await page.getByLabel('Streamer Password').fill(STREAMER_PASSWORD)
  await page.getByRole('button', { name: 'Open Dock' }).click()
  await page.waitForURL((url) => url.pathname === '/dock')
}

/** Opens the stream as an anonymous guest and submits the viewer password at the login form. */
export async function loginAsGuest(page: Page, path: string, password: string) {
  await page.goto(`/${path}`)
  await page.waitForURL(/\/login/)
  await page.getByLabel('Viewer Password').fill(password)
  await page.getByRole('button', { name: 'Watch Stream' }).click()
}

/** Rotates the viewer password through the dock's API (needs a streamer session). */
export async function rotatePassword(streamerPage: Page, path: string): Promise<string> {
  const res = await streamerPage.request.post(
    `/api/dock/password?path=${encodeURIComponent(path)}`,
  )
  expect(res.ok()).toBe(true)
  const { password } = (await res.json()) as { password: string }
  expect(password).toMatch(/^[0-9a-f]{32}$/)
  return password
}

export async function setVisibility(
  streamerPage: Page,
  path: string,
  visibility: 'public' | 'private',
) {
  const res = await streamerPage.request.post('/api/streams/visibility', {
    data: { path, visibility },
  })
  expect(res.ok()).toBe(true)
}

/**
 * The innermost dock row that contains `text` and a button called `button`.
 * Dock rows are plain divs, so this narrows by content instead of by test id.
 */
export function dockRow(
  page: Page,
  text: string | RegExp,
  button: string | RegExp,
  exact = true,
): Locator {
  return page
    .locator('div')
    .filter({ hasText: text })
    .filter({ has: page.getByRole('button', { name: button, exact }) })
    .last()
}

// ---------- test ----------

type Fixtures = {
  /** Resets the fake before every test (auto). */
  _resetFake: void
  /** Opens contexts that are closed after the test. */
  client: (ip?: string) => Promise<Client>
}

export const test = base.extend<Fixtures>({
  _resetFake: [
    async ({}, use) => {
      await fake.reset()
      await use()
    },
    { auto: true },
  ],
  client: async ({ browser }, use) => {
    const opened: Client[] = []
    await use(async (ip) => {
      const client = await newClient(browser, ip)
      opened.push(client)
      return client
    })
    for (const { context } of opened) await context.close()
  },
})
