import { NextRequest } from "next/server";
import { auth } from "./auth";
import { getClientIp } from "./net";
import { getPathVisibility } from "./db";
import { approvalKey, isApproved } from "./accessRequests";
import { getBlock, blockedViewerOf } from "./accessBlocks";
import { isSessionRevoked, type SessionUser } from "./authz";
import { ponyKeyFor } from "./guestIdentity";
import { PATH_NAME_RE } from "./streamSettings";

export type ViewerAccess =
  | { status: "ok" }
  | { status: "pending" }
  | { status: "blocked"; reason: "kicked" | "denied"; blockedUntil: number }
  // The viewer password changed since sign-in, or a trusted-network session left its network.
  | { status: "unauthorized" };

export function viewerAccess(user: SessionUser, path: string, ip: string): ViewerAccess {
  if (isSessionRevoked(user, path, ip)) return { status: "unauthorized" };
  if (user.role === "streamer") return { status: "ok" };
  const block = getBlock(path, blockedViewerOf(user, ip));
  if (block) return { status: "blocked", ...block };
  const discordId = user.role === "discord" ? user.id : null;
  if (getPathVisibility(path) === "private" && !isApproved(path, approvalKey(user.role, ip, discordId), user.role)) {
    return { status: "pending" };
  }
  return { status: "ok" };
}

export function watchAccessDenied(user: SessionUser, path: string, ip: string): number | null {
  const { status } = viewerAccess(user, path, ip);
  if (status === "unauthorized") return 401;
  return status === "ok" ? null : 403;
}

export async function authorizeWatch(
  req: NextRequest,
  path: string
): Promise<{ user: SessionUser; ip: string; error?: undefined } | { user?: undefined; error: number }> {
  if (!PATH_NAME_RE.test(path)) return { error: 404 };
  const session = await auth();
  if (!session?.user) return { error: 401 };
  const user = session.user as SessionUser;
  const ip = getClientIp(req);
  const error = watchAccessDenied(user, path, ip);
  return error ? { error } : { user, ip };
}

export async function authorizeGuest(
  req: NextRequest,
  path: string
): Promise<{ user: SessionUser; ip: string; ponyKey: string } | Response> {
  const result = await authorizeWatch(req, path);
  if (!result.user) return new Response(null, { status: result.error });
  const ponyKey = ponyKeyFor(result.user.role, result.user.name, result.ip, path);
  if (!ponyKey) return new Response("No pony identity", { status: 400 });
  return { user: result.user, ip: result.ip, ponyKey };
}
