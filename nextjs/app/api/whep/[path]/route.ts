import { auth } from '@/lib/auth'
import { rememberViewerIdentity } from '@/lib/viewerIdentities'
import { getClientIp } from '@/lib/net'
import { type SessionUser } from '@/lib/authz'
import { watchAccessDenied } from '@/lib/watchAccess'
import {
  forwardSdpHeaders,
  mediamtxAuthHeader,
  mediamtxWebrtcBase,
} from '@/lib/mediamtx'
import { notifyChanged } from '@/lib/events'
import { PATH_NAME_RE } from '@/lib/streamSettings'
import { NextRequest } from 'next/server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string }> },
) {
  const session = await auth()
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { path } = await params
  if (!PATH_NAME_RE.test(path)) return new Response(null, { status: 404 })
  const user = session.user as SessionUser
  const ip = getClientIp(req)

  const denied = watchAccessDenied(user, path, ip)
  if (denied === 401) {
    return new Response('Viewer password changed', { status: 401 })
  }
  if (denied === 403) {
    return new Response('Forbidden', { status: 403 })
  }

  const upstream = `${mediamtxWebrtcBase()}/${path}/whep`

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
    console.error('WHEP upstream fetch failed:', err)
    return new Response('Media server unreachable', { status: 502 })
  }

  const responseHeaders = forwardSdpHeaders(res)

  const location = res.headers.get('location')
  // MediaMTX's "Id" response header carries the same session id used by
  // /v3/webrtcsessions/list. The Location header's path segment is a
  // separate WHEP resource identifier and is NOT guaranteed to match it,
  // so we must key off "Id" rather than parsing Location.
  const sessionId =
    res.headers.get('id') || location?.split('/').filter(Boolean).pop()
  if (res.ok && sessionId) {
    rememberViewerIdentity(sessionId, {
      // Discord viewers show their real name/avatar; everyone else (viewer-password) is
      // identified by IP address instead, since there's no per-person account for them.
      name: user.role === 'discord' ? user.name : ip,
      image: user.role === 'discord' ? user.image : null,
      role: user.role,
      ip,
      discordId: user.role === 'discord' ? user.id : null,
      path,
    })
    notifyChanged(path)
  }

  return new Response(await res.text(), {
    status: res.status,
    headers: responseHeaders,
  })
}
