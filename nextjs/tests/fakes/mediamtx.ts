// Stateful fake of the MediaMTX control API (:9997) and WebRTC server (:8889).
//
// `handle(req)` is a plain fetch-style handler, routed by URL *path* only (host
// and port are ignored), so the same fake serves:
//   - MSW in Vitest (tests/helpers/msw.ts matches both mediamtx.test ports), and
//   - a node:http server for e2e, which can listen on a single port for both.
//
// Contract for "down" mode (setDown(true)): handle() answers 503 with a JSON
// error. A real unreachable server is a network error instead, so the MSW
// wrapper checks isDown() first and returns HttpResponse.error(); the e2e
// wrapper should destroy the socket when isDown() is true.
import { answerFor } from './sdp'

export type FakeSession = {
  id: string
  path: string
  state: 'read' | 'publish'
  peerConnectionEstablished: boolean
  remoteAddr: string
  created: string
  [key: string]: unknown
}

export type RecordedRequest = {
  method: string
  /** URL pathname, e.g. `/v3/paths/list` or `/default/whep`. */
  path: string
  /** Whether the request carried the expected streamer Basic auth. */
  authorized: boolean
  /** Request body (text), when there was one. */
  body?: string
}

export type FakeMediamtxOptions = {
  /** Expected streamer password; read from STREAMER_PASSWORD per request by default. */
  password?: string
}

export type FakeMediamtx = {
  /** Fetch-style handler; see the header comment. */
  handle(req: Request): Promise<Response>
  /** Marks a path ready (live) or not. Known paths are listed by /v3/paths/list. */
  setReady(path: string, ready: boolean): void
  /** Adds a path to /v3/config/paths/list (and to /v3/paths/list as not ready). */
  addConfiguredPath(name: string): void
  /** Adds a WebRTC session directly; returns it (id/created/etc. are defaulted). */
  addSession(partial: Partial<FakeSession> & { path: string }): FakeSession
  sessions(): FakeSession[]
  /** While down, handle() answers 503 and wrappers should simulate a network error. */
  setDown(down: boolean): void
  isDown(): boolean
  /** Every request received (including unauthorized ones), oldest first. */
  requests: RecordedRequest[]
  /** POST /v3/webrtcsessions/kick/:id requests. */
  kicks(): RecordedRequest[]
  /** Ids passed to kick requests, in order. */
  kickedIds(): string[]
  /** POST /:path/whep requests. */
  whepPosts(): RecordedRequest[]
  /** POST /:path/whip requests. */
  whipPosts(): RecordedRequest[]
  /** Clears all state: paths, sessions, request log, down mode. */
  reset(): void
}

const KICK_PREFIX = '/v3/webrtcsessions/kick/'

export function createFakeMediamtx(
  options: FakeMediamtxOptions = {},
): FakeMediamtx {
  const ready = new Map<string, string>() // path -> readyTime (ISO)
  const known = new Set<string>() // names listed by paths/list
  const configured = new Set<string>()
  let sessions: FakeSession[] = []
  let down = false
  const requests: RecordedRequest[] = []

  const expectedAuth = () => {
    const password = options.password ?? process.env.STREAMER_PASSWORD ?? ''
    return 'Basic ' + Buffer.from(`streamer:${password}`).toString('base64')
  }

  const json = (body: unknown, status = 200) => Response.json(body, { status })

  function newSession(
    partial: Partial<FakeSession> & { path: string },
  ): FakeSession {
    const session: FakeSession = {
      id: crypto.randomUUID(),
      state: 'read',
      peerConnectionEstablished: true,
      remoteAddr: '127.0.0.1:50000',
      created: new Date().toISOString(),
      ...partial,
    }
    sessions.push(session)
    return session
  }

  function list(items: unknown[]) {
    return json({ itemCount: items.length, pageCount: 1, items })
  }

  async function handle(req: Request): Promise<Response> {
    const pathname = new URL(req.url).pathname
    const method = req.method.toUpperCase()
    const authorized = req.headers.get('authorization') === expectedAuth()
    const body = method === 'GET' || method === 'HEAD' ? '' : await req.text()
    requests.push({
      method,
      path: pathname,
      authorized,
      ...(body ? { body } : {}),
    })

    if (down) return json({ error: 'fake MediaMTX is down' }, 503)
    if (!authorized) return new Response('Unauthorized', { status: 401 })

    // ---- control API ----
    if (pathname.startsWith('/v3/')) {
      if (method === 'GET' && pathname === '/v3/paths/list') {
        return list(
          [...known].sort().map((name) => ({
            name,
            ready: ready.has(name),
            readyTime: ready.get(name) ?? null,
            readers: [],
          })),
        )
      }
      if (method === 'GET' && pathname === '/v3/config/paths/list') {
        return list([...configured].sort().map((name) => ({ name })))
      }
      if (method === 'GET' && pathname === '/v3/webrtcsessions/list') {
        return list(sessions)
      }
      if (method === 'POST' && pathname.startsWith(KICK_PREFIX)) {
        const id = decodeURIComponent(pathname.slice(KICK_PREFIX.length))
        if (!sessions.some((s) => s.id === id)) {
          return json({ error: 'session not found' }, 404)
        }
        sessions = sessions.filter((s) => s.id !== id)
        return new Response(null, { status: 200 })
      }
      return json({ error: 'not found' }, 404)
    }

    // ---- WebRTC server: /<path>/whep[/<id>] and /<path>/whip[/<id>] ----
    // Path names may contain "/", so split on the last whep/whip segment.
    const segments = pathname.split('/').filter(Boolean)
    const at = segments.findLastIndex((s) => s === 'whep' || s === 'whip')
    if (at < 1) return new Response('Not found', { status: 404 })
    const kind = segments[at] as 'whep' | 'whip'
    const path = segments.slice(0, at).join('/')
    const id = segments[at + 1]

    if (method === 'POST' && id === undefined) {
      if (kind === 'whep' && !ready.has(path)) {
        return new Response('no stream is available on path', { status: 404 })
      }
      const session = newSession({
        path,
        state: kind === 'whep' ? 'read' : 'publish',
      })
      return new Response(answerFor(body), {
        status: 201,
        headers: {
          'Content-Type': 'application/sdp',
          Location: `/${path}/${kind}/${session.id}`,
          // MediaMTX's session id header, which the app keys viewers by.
          Id: session.id,
          'Accept-Patch': 'application/trickle-ice-sdpfrag',
        },
      })
    }
    if (method === 'DELETE' && id !== undefined) {
      sessions = sessions.filter((s) => s.id !== id)
      return new Response(null, { status: 200 })
    }
    return new Response('Method not allowed', { status: 405 })
  }

  const posts = (suffix: string) => () =>
    requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix))
  const kicks = () =>
    requests.filter((r) => r.method === 'POST' && r.path.startsWith(KICK_PREFIX))

  return {
    handle,
    setReady(path, isReady) {
      if (isReady) {
        known.add(path)
        ready.set(path, new Date().toISOString())
      } else {
        ready.delete(path)
      }
    },
    addConfiguredPath(name) {
      configured.add(name)
      known.add(name)
    },
    addSession: newSession,
    sessions: () => [...sessions],
    setDown(value) {
      down = value
    },
    isDown: () => down,
    requests,
    kicks,
    kickedIds: () =>
      kicks().map((r) => decodeURIComponent(r.path.slice(KICK_PREFIX.length))),
    whepPosts: posts('/whep'),
    whipPosts: posts('/whip'),
    reset() {
      ready.clear()
      known.clear()
      configured.clear()
      sessions = []
      down = false
      requests.length = 0
    },
  }
}
