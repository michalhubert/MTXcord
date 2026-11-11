import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createFakeMediamtx, type FakeMediamtx } from '../fakes/mediamtx'
import { FAKE_PORT, FAKE_URL, STREAMER_PASSWORD } from './env'

// A node:http server that stands in for MediaMTX (control API and WebRTC
// server, on one port), plus /__fake/* control endpoints for the specs and a
// Derpibooru stub for guest avatars.

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v))
    else if (value !== undefined) headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(new URL(req.url ?? '/', FAKE_URL), {
    method,
    headers,
    body: hasBody && body.length > 0 ? new Uint8Array(body) : undefined,
  })
}

export type FakeServer = {
  fake: FakeMediamtx
  stop(): Promise<void>
}

export async function startFakeServer(): Promise<FakeServer> {
  // The fake checks the streamer's Basic auth against this password.
  const fake = createFakeMediamtx({ password: STREAMER_PASSWORD })

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', FAKE_URL)
      const { pathname } = url

      if (pathname.startsWith('/__fake/')) {
        const body = await readBody(req)
        const data = body.length ? JSON.parse(body.toString('utf8')) : {}
        switch (pathname) {
          case '/__fake/reset':
            fake.reset()
            return json(res, { ok: true })
          case '/__fake/setReady':
            fake.setReady(String(data.path), !!data.ready)
            return json(res, { ok: true })
          case '/__fake/state':
            return json(res, {
              sessions: fake.sessions(),
              requests: fake.requests,
              kickedIds: fake.kickedIds(),
              whepPosts: fake.whepPosts(),
            })
          default:
            return json(res, { error: 'unknown control endpoint' }, 404)
        }
      }

      // Derpibooru stub. thumb_small must be https:// for the app to accept it.
      if (pathname === '/booru/api/v1/json/search/images') {
        const images = Array.from({ length: 25 }, () => ({
          representations: { thumb_small: `https://127.0.0.1:${FAKE_PORT}/booru/avatar.png` },
        }))
        return json(res, { images })
      }
      if (pathname === '/booru/avatar.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(PNG)
      }

      // MediaMTX down: a real server would be unreachable, not answer 503.
      if (fake.isDown()) {
        req.socket.destroy()
        return
      }

      const response = await fake.handle(toRequest(req, await readBody(req)))
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => (headers[name] = value))
      res.writeHead(response.status, headers)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      console.error('[fake-server]', err)
      if (!res.headersSent) json(res, { error: String(err) }, 500)
      else res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(FAKE_PORT, '127.0.0.1', resolve)
  })

  return {
    fake,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
