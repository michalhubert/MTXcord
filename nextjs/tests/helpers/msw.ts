// The shared MSW server (started/reset in tests/setup/common.ts) plus handler
// factories for the three outbound services: MediaMTX, the Discord webhook and
// the booru (Derpibooru). Unhandled requests error out, so every test declares
// exactly the network it expects.
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { mediamtxApiBase, mediamtxWebrtcBase } from '@/lib/mediamtx'
import { createFakeMediamtx, type FakeMediamtx } from '../fakes/mediamtx'

export const server = setupServer()

/**
 * Routes MediaMTX's API (:MEDIAMTX_API_PORT) and WebRTC (:MEDIAMTX_PORT) ports
 * on MEDIAMTX_HOST to a fake. While fake.setDown(true), requests fail with a
 * network error (like an unreachable host). Handlers are dropped after each
 * test (server.resetHandlers()).
 */
export function useFakeMediamtx(
  fake: FakeMediamtx = createFakeMediamtx(),
): FakeMediamtx {
  const handler = ({ request }: { request: Request }) =>
    fake.isDown() ? HttpResponse.error() : fake.handle(request)
  server.use(
    http.all(`${mediamtxApiBase()}/*`, handler),
    http.all(`${mediamtxWebrtcBase()}/*`, handler),
  )
  return fake
}

export type DiscordCall = {
  method: 'POST' | 'PATCH'
  url: string
  /** Parsed JSON body ({ embeds: [...] }). */
  body: { embeds?: { title?: string; description?: string }[] }
}

export type FakeDiscordWebhook = {
  /** Webhook URL to put in DISCORD_WEBHOOK_URL(S) via vi.stubEnv. */
  url: string
  calls: DiscordCall[]
  posts(): DiscordCall[]
  patches(): DiscordCall[]
  /** Message ids that exist; PATCH on any other id answers 404 (deleted message). */
  messages: Set<string>
  /** Simulates the message being deleted on Discord. */
  deleteMessage(id: string): void
}

/** Fake Discord webhook: POST ?wait=true creates messages (ids "msg-1", ...), PATCH edits them. */
export function useFakeDiscordWebhook(
  url = 'https://discord.test/api/webhooks/123/token',
): FakeDiscordWebhook {
  const calls: DiscordCall[] = []
  const messages = new Set<string>()
  let next = 1

  server.use(
    http.post(url, async ({ request }) => {
      calls.push({
        method: 'POST',
        url: request.url,
        body: await request.json(),
      } as DiscordCall)
      const id = `msg-${next++}`
      messages.add(id)
      return HttpResponse.json({ id })
    }),
    http.patch(`${url}/messages/:id`, async ({ request, params }) => {
      calls.push({
        method: 'PATCH',
        url: request.url,
        body: await request.json(),
      } as DiscordCall)
      return messages.has(String(params.id))
        ? HttpResponse.json({ id: params.id })
        : HttpResponse.json({ message: 'Unknown Message' }, { status: 404 })
    }),
  )

  return {
    url,
    calls,
    messages,
    posts: () => calls.filter((c) => c.method === 'POST'),
    patches: () => calls.filter((c) => c.method === 'PATCH'),
    deleteMessage: (id) => void messages.delete(id),
  }
}

export type FakeBooru = {
  /** Search URLs received (query string included), oldest first. */
  requests: URL[]
  /** Overrides what the booru answers from now on. */
  respondWith(opts: { urls?: string[]; status?: number; retryAfterS?: number }): void
}

/**
 * Fake Derpibooru-style search endpoint (/api/v1/json/search/images). Answers
 * `{ images: [{ representations: { thumb_small } }] }`; by default 20 distinct
 * https avatar URLs.
 */
export function useFakeDerpibooru(
  opts: { base?: string; urls?: string[]; status?: number } = {},
): FakeBooru {
  const base = (opts.base ?? 'https://derpibooru.org').replace(/\/+$/, '')
  let urls =
    opts.urls ??
    Array.from(
      { length: 20 },
      (_, i) => `https://cdn.booru.test/img/${i + 1}/thumb_small.png`,
    )
  let status = opts.status ?? 200
  let retryAfterS: number | undefined
  const requests: URL[] = []

  server.use(
    http.get(`${base}/api/v1/json/search/images`, ({ request }) => {
      requests.push(new URL(request.url))
      if (status !== 200) {
        return new HttpResponse(null, {
          status,
          headers: retryAfterS ? { 'retry-after': String(retryAfterS) } : {},
        })
      }
      return HttpResponse.json({
        images: urls.map((u) => ({ representations: { thumb_small: u } })),
      })
    }),
  )

  return {
    requests,
    respondWith(next) {
      if (next.urls) urls = next.urls
      if (next.status !== undefined) status = next.status
      retryAfterS = next.retryAfterS
    },
  }
}
