import { NextRequest } from 'next/server'

export type NextRequestOptions = {
  method?: string
  /** Client IP, sent in x-forwarded-for (lib/net.ts). Default 203.0.113.10; null = no header. */
  ip?: string | null
  headers?: Record<string, string>
  /** Raw text body. */
  body?: string
  /** JSON body (sets content-type: application/json). */
  json?: unknown
  /** Abort signal, e.g. for SSE routes: aborting triggers the route's cleanup. */
  signal?: AbortSignal
}

/** Builds a NextRequest. Relative URLs are resolved against http://localhost:3000. */
export function nextRequest(
  url: string,
  opts: NextRequestOptions = {},
): NextRequest {
  const headers = new Headers(opts.headers)
  const ip = opts.ip === undefined ? '203.0.113.10' : opts.ip
  if (ip !== null && !headers.has('x-forwarded-for')) {
    headers.set('x-forwarded-for', ip)
  }

  let body = opts.body
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json)
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }

  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    signal: opts.signal,
  })
}

/** Second argument of dynamic route handlers (app/api/{watch,whep,whip}/[path]/...). */
export function routeParams<P extends string>(
  path: P,
): { params: Promise<{ path: P }> } {
  return { params: Promise.resolve({ path }) }
}
