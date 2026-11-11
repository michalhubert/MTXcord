// Resets every in-memory server singleton so tests don't leak into each other.
//
// Modules capture their registries at import time (`globalThis.__x ??= new Map()`),
// so deleting the globalThis key would NOT reset an already-imported module:
// everything is cleared IN PLACE instead. Called automatically in beforeEach
// (tests/setup/common.ts).
//
// Limitation: if a test uses vi.resetModules(), lib/viewerIdentities.ts (a plain
// module-level Map, not on globalThis) is re-created and this helper only
// reaches the first instance. Everything on globalThis stays shared.
import { closeDb } from '@/lib/db'
import { pruneViewerIdentities } from '@/lib/viewerIdentities'

type Store = Record<string, unknown>

export function resetServerState(): void {
  // Fresh ':memory:' DB (and schema) on the next getDb().
  closeDb()

  const store = globalThis as unknown as Store

  // lib/events.ts: pending paths, listeners, scheduled flag.
  const hub = store.__changeHub as
    | { listeners: Set<unknown>; pending: Set<string>; scheduled: boolean }
    | undefined
  if (hub) {
    hub.listeners.clear()
    hub.pending.clear()
    hub.scheduled = false
  }

  // Plain registries (Maps).
  for (const key of [
    '__loginFailures', // lib/credentials.ts
    '__openAccessRequests', // lib/accessRequests.ts
    '__watchRooms', // lib/watchRoom.ts
    '__watchConnections',
    '__watchReactionLog',
    '__guestAvatarPools', // lib/guestIdentity.ts
    '__guestAvatarRequests',
    '__guestAvatarPicks',
    '__guestRerolledAt',
  ]) {
    ;(store[key] as Map<unknown, unknown> | undefined)?.clear()
  }

  // lib/guestIdentity.ts: a plain number, read from the store on every use.
  delete store.__derpibooruNextSlotAt

  // lib/streamState.ts: stop the reconciler interval and forget its watchers.
  const reconciler = store.__streamStateReconciler as
    | { watchers: number; timer: ReturnType<typeof setInterval> | null }
    | undefined
  if (reconciler) {
    if (reconciler.timer) clearInterval(reconciler.timer)
    reconciler.timer = null
    reconciler.watchers = 0
  }

  // lib/viewerIdentities.ts: no active sessions -> everything is dropped.
  pruneViewerIdentities([])
}
