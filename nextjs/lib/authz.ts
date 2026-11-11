import { auth } from "@/lib/auth";
import { getViewerPassword } from "@/lib/db";
import { isTrustedIp } from "@/lib/trustedNetworks";

/**
 * Returns true when the caller is allowed to use streamer-only areas
 * (the /dock HUD and the /stream browser-capture panel), either because
 * they hold a valid "streamer" session or because DISABLE_DOCK_AUTH is set
 * (useful when the app is only reachable from a trusted local network).
 */
export async function isStreamerAuthorized(): Promise<boolean> {
  if (process.env.DISABLE_DOCK_AUTH === "true") return true;

  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  return !!session?.user && role === "streamer";
}

export type SessionUser =
  | { id: string; name: string; image: string | null; role: "discord" }
  | { id?: string; name: null; image: null; role: "viewer" | "streamer"; password?: string; trusted?: boolean };

// True once the streamer rotates the viewer password: the session still carries the
// old password. Only about the password: sessions without one (discord, streamer and
// trusted-network viewers) are never stale here. Private on purpose: callers must use
// isSessionRevoked, which also covers trusted-network sessions.
function isViewerPasswordStale(user: SessionUser, path: string): boolean {
  if (user.role !== "viewer" || user.trusted) return false;
  const validPassword = getViewerPassword(path) ?? getViewerPassword("default");
  return !!validPassword && user.password !== validPassword;
}

/**
 * Whether a trusted-network session (`trusted` flag on the token) is still backed by the
 * network: the client's IP is in TRUSTED_NETWORKS right now. False for any other session.
 */
export function isTrustedSessionValid(
  trusted: boolean | undefined,
  ip: string | null | undefined,
): boolean {
  return !!trusted && !!ip && isTrustedIp(ip);
}

// The session no longer grants access, so the viewer must be sent back to /login instead
// of being treated as authenticated: the viewer password changed since sign-in, or a
// trusted-network session is used from outside TRUSTED_NETWORKS (cookie carried off the
// LAN, or the setting changed). The single source of truth for both cases.
// `path` is the stream the session is used for; null when there is none (the login page
// without a stream), where a password session can't be judged and only counts as revoked
// if it's a trusted session off the network.
export function isSessionRevoked(user: SessionUser, path: string | null, ip: string): boolean {
  if (path !== null && isViewerPasswordStale(user, path)) return true;
  return user.role === "viewer" && !!user.trusted && !isTrustedSessionValid(user.trusted, ip);
}
