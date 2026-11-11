// Small helpers shared by the integration test files (not a test file itself).
import { afterEach } from 'vitest'
import { POST as whepPost } from '@/app/api/whep/[path]/route'
import { syncStreamState } from '@/lib/streamState'
import type { WatchEvent } from '@/lib/watchRoomShared'
import type { FakeMediamtx } from '../fakes/mediamtx'
import { nextRequest, routeParams } from '../helpers/request'
import { openSse, type SseReader } from '../helpers/sse'

export const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=recvonly',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n')

export const GUEST_IP = '198.51.100.7'
export const OTHER_IP = '198.51.100.8'

/** Marks a path live both on the fake MediaMTX and in the app's stream sessions. */
export function goLive(fake: FakeMediamtx, path: string): void {
  fake.setReady(path, true)
  syncStreamState(path, { ready: true, readyTime: new Date().toISOString() })
}

/** WHEP POST as whoever the mocked auth() currently resolves to. */
export async function whep(
  path: string,
  ip: string = GUEST_IP,
): Promise<{ res: Response; id: string | null }> {
  const res = await whepPost(
    nextRequest(`/api/whep/${path}`, { body: OFFER, ip }),
    routeParams(path),
  )
  return { res, id: res.headers.get('id') }
}

type Opened = { controller: AbortController; sse: SseReader<unknown> }
const opened: Opened[] = []

/**
 * Opens an SSE route and tracks it: every stream opened through here is
 * aborted/closed after the test (the routes' intervals would otherwise keep
 * running). `call` receives the abort signal to put on the request.
 */
export async function openStream<T = WatchEvent>(
  call: (signal: AbortSignal) => Promise<Response>,
): Promise<{
  res: Response
  sse: SseReader<T>
  /** Aborts the request, which runs the route's cleanup. */
  abort: () => void
}> {
  const controller = new AbortController()
  const res = await call(controller.signal)
  const sse = openSse<T>(res)
  opened.push({ controller, sse: sse as SseReader<unknown> })
  return { res, sse, abort: () => controller.abort() }
}

afterEach(async () => {
  for (const { controller, sse } of opened.splice(0)) {
    controller.abort()
    await sse.close()
  }
})

// Aliases for calling the installers from plain helper functions: the name
// "use*" would otherwise trip react-hooks/rules-of-hooks.
export {
  useFakeMediamtx as installFakeMediamtx,
  useFakeDiscordWebhook as installFakeDiscordWebhook,
} from '../helpers/msw'
