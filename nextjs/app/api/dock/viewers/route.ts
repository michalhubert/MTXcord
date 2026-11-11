import { isStreamerAuthorized } from '@/lib/authz'
import { getViewerIdentity } from '@/lib/viewerIdentities'
import { kickViewer } from '@/lib/accessBlocks'
import { kickWebrtcSession } from '@/lib/mediamtx'
import { approvalKey, revokeApproval } from '@/lib/accessRequests'
import { NextRequest } from 'next/server'

export async function DELETE(req: NextRequest) {
  if (!(await isStreamerAuthorized())) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('id')

  if (!sessionId) {
    return new Response('Missing session ID', { status: 400 })
  }

  const kicked = await kickWebrtcSession(sessionId)
  if (!kicked) {
    return Response.json(
      { error: 'MediaMTX API unreachable or session not found' },
      { status: 502 },
    )
  }

  // Block right after the kick succeeded (synchronously, before the player's
  // reconnect backoff can retry). Otherwise its auto-reconnect would undo the kick.
  const identity = getViewerIdentity(sessionId)
  if (identity?.ip && identity.path) {
    kickViewer(identity.path, identity)
    revokeApproval(
      identity.path,
      approvalKey(identity.role, identity.ip, identity.discordId),
      identity.role,
    )
  }

  return Response.json({ ok: true })
}
