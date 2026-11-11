import {
  approveViewer,
  deleteAccessRequest,
  deleteAccessRequestsForPath,
  deleteApproval,
  deleteApprovalsForPath,
  getAccessRequest,
  getViewerPassword,
  isViewerApproved,
  listAccessRequests,
  listApprovedViewers,
  touchAccessRequest,
} from './db'
import { clearBlock, denyViewer } from './accessBlocks'
import { ALL_PATHS, notifyChanged } from './events'
import { isTrustedIp } from './trustedNetworks'

export type PendingRequest = {
  ip: string
  clientIp: string | null
  path: string
  name: string | null
  image: string | null
  role: string
  requestedAt: number
}

export type AccessRequester = {
  path: string
  // See approvalKey.
  ip: string
  role?: string
  name: string | null
  image: string | null
  discordId: string | null
  clientIp: string
}

// Only for requests left behind by a restart.
const STALE_MS = 45 * 1000

const roleKey = (role?: string) => role ?? 'guest'
const requestKey = (path: string, ip: string, role?: string) =>
  `${path}\n${ip}\n${roleKey(role)}`

// Per request; one person can have several tabs.
const store = globalThis as typeof globalThis & {
  __openAccessRequests?: Map<string, number>
}
const openRequests = (store.__openAccessRequests ??= new Map<string, number>())

// Discord viewers are approved by account, others (shared password) only by IP.
export function approvalKey(
  role: string | undefined,
  ip: string,
  discordId?: string | null,
): string {
  return role === 'discord' && discordId ? `discord:${discordId}` : ip
}

export function isApproved(path: string, ip: string, role?: string): boolean {
  return isViewerApproved(path, ip, roleKey(role))
}

function touch(r: AccessRequester): void {
  touchAccessRequest(
    {
      path: r.path,
      ip: r.ip,
      role: roleKey(r.role),
      name: r.name,
      image: r.image,
      discord_id: r.discordId,
      client_ip: r.clientIp,
    },
    Date.now(),
  )
}

export function openAccessRequest(r: AccessRequester): void {
  const key = requestKey(r.path, r.ip, r.role)
  openRequests.set(key, (openRequests.get(key) ?? 0) + 1)
  const isNew = !getAccessRequest(r.path, r.ip, roleKey(r.role))
  touch(r)
  if (isNew) notifyChanged(r.path)
}

// Only refreshes: an answered or cleared request stays gone.
export function keepAccessRequest(r: AccessRequester): void {
  if (getAccessRequest(r.path, r.ip, roleKey(r.role))) touch(r)
}

export function closeAccessRequest(r: AccessRequester): void {
  const key = requestKey(r.path, r.ip, r.role)
  const remaining = (openRequests.get(key) ?? 1) - 1
  if (remaining > 0) {
    openRequests.set(key, remaining)
    return
  }
  openRequests.delete(key)
  if (!getAccessRequest(r.path, r.ip, roleKey(r.role))) return
  deleteAccessRequest(r.path, r.ip, roleKey(r.role))
  notifyChanged(r.path)
}

export function approveAccess(path: string, ip: string, role?: string): void {
  const discordId = getAccessRequest(path, ip, roleKey(role))?.discord_id
  approveViewer(path, ip, roleKey(role))
  deleteAccessRequest(path, ip, roleKey(role))
  clearBlock(path, { role, ip, discordId })
  notifyChanged(path)
}

export function denyAccess(path: string, ip: string, role?: string): void {
  const discordId = getAccessRequest(path, ip, roleKey(role))?.discord_id
  deleteAccessRequest(path, ip, roleKey(role))
  deleteApproval(path, ip, roleKey(role))
  denyViewer(path, { role, ip, discordId })
}

export function revokeApproval(path: string, ip: string, role?: string): void {
  deleteApproval(path, ip, roleKey(role))
  notifyChanged(path)
}

export function listPendingRequests(): PendingRequest[] {
  return listAccessRequests(Date.now() - STALE_MS).map((r) => ({
    ip: r.ip,
    clientIp: r.client_ip,
    path: r.path,
    name: r.name,
    image: r.image,
    role: r.role,
    requestedAt: r.requested_at,
  }))
}

export function clearApprovedViewers(path: string): void {
  deleteApprovalsForPath(path)
  notifyChanged(path)
}

export function clearPendingRequests(path: string): void {
  deleteAccessRequestsForPath(path)
  notifyChanged(path)
}

// Rotating the password for `rotatedPath` also invalidates any other path that has no
// password override of its own and therefore falls back to it - so those paths' password
// viewers must be cleared too, not just `rotatedPath` itself.
export function usesPasswordOf(path: string, rotatedPath: string): boolean {
  return (
    path === rotatedPath ||
    (rotatedPath === 'default' && !getViewerPassword(path))
  )
}

// Approvals are keyed by IP, not by how the guest signed in. Anyone on a TRUSTED_NETWORKS IP
// can sign in without the password anyway, so dropping their approval would only make
// trusted guests ask again; and an approval grants nothing without a valid session, so a
// password guest on a trusted IP who is kicked by the rotation keeps no access through it.
export function clearApprovedPasswordViewers(rotatedPath: string): void {
  for (const a of listApprovedViewers()) {
    if (
      a.role !== 'discord' &&
      !isTrustedIp(a.ip) &&
      usesPasswordOf(a.path, rotatedPath)
    ) {
      deleteApproval(a.path, a.ip, a.role)
    }
  }
  notifyChanged(ALL_PATHS)
}
