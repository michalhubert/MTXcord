import { isStreamerAuthorized, isTrustedSessionValid } from '@/lib/authz'
import { rotateViewerPassword } from '@/lib/db'
import { getViewerIdentity } from '@/lib/viewerIdentities'
import { listWebrtcSessions, kickWebrtcSession } from '@/lib/mediamtx'
import { clearApprovedPasswordViewers, usesPasswordOf } from '@/lib/accessRequests'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  if (!(await isStreamerAuthorized())) {
    return new Response('Unauthorized', { status: 401 })
  }

  const path = req.nextUrl.searchParams.get('path') || 'default'
  const newPassword = rotateViewerPassword(path)

  // Discord viewers and viewers signed in through TRUSTED_NETWORKS don't use the viewer
  // password, so they stay connected. A password guest on a trusted IP is still kicked.
  clearApprovedPasswordViewers(path)
  const sessions = await listWebrtcSessions()
  await Promise.all(
    sessions
      .filter((item) => {
        const identity = getViewerIdentity(item.id)
        // A trusted session only skips the kick while its IP is still trusted.
        const stillTrusted = isTrustedSessionValid(identity?.trusted, identity?.ip)
        return (
          identity?.role === 'viewer' &&
          !!identity.path &&
          !stillTrusted &&
          usesPasswordOf(identity.path, path)
        )
      })
      .map((item) => kickWebrtcSession(item.id)),
  )

  return new Response(JSON.stringify({ password: newPassword }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
