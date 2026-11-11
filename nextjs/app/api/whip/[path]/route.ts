import { isStreamerAuthorized } from '@/lib/authz'
import {
  forwardSdpHeaders,
  mediamtxAuthHeader,
  mediamtxWebrtcBase,
} from '@/lib/mediamtx'
import { PATH_NAME_RE } from '@/lib/streamSettings'
import { NextRequest } from 'next/server'

// WHIP publish: browser posts an SDP offer, MediaMTX answers and starts
// ingesting the "browser" path. Mirrors /api/whep but for the publisher
// side and restricted to authorized streamers only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string }> },
) {
  if (!(await isStreamerAuthorized())) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { path } = await params
  if (!PATH_NAME_RE.test(path)) return new Response(null, { status: 404 })
  const upstream = `${mediamtxWebrtcBase()}/${path}/whip`

  // The stream session starts with MediaMTX's online hook.

  const body = await req.text()
  let res: Response
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Authorization: mediamtxAuthHeader(),
      },
      body,
    })
  } catch (err) {
    console.error('WHIP upstream fetch failed:', err)
    return new Response('Media server unreachable', { status: 502 })
  }

  return new Response(await res.text(), {
    status: res.status,
    headers: forwardSdpHeaders(res),
  })
}

// WHIP teardown: browser calls this (with the WHIP resource id from the
// "Id"/"Location" header) when the user stops streaming, so MediaMTX ends
// the session immediately instead of waiting for an ICE timeout.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string }> },
) {
  if (!(await isStreamerAuthorized())) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { path } = await params
  if (!PATH_NAME_RE.test(path)) return new Response(null, { status: 404 })
  const resourceId = req.nextUrl.searchParams.get('id')
  if (!resourceId) {
    return new Response('Missing id', { status: 400 })
  }

  const upstream = `${mediamtxWebrtcBase()}/${path}/whip/${resourceId}`

  try {
    const res = await fetch(upstream, {
      method: 'DELETE',
      headers: { Authorization: mediamtxAuthHeader() },
    })
    return new Response(null, { status: res.status })
  } catch {
    return new Response(null, { status: 204 })
  }
}
