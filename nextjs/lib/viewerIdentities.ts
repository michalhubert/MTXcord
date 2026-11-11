export type ViewerIdentity = {
  name: string;
  image: string | null;
  role?: string;
  ip?: string;
  discordId?: string | null;
  // Signed in through TRUSTED_NETWORKS rather than the viewer password.
  trusted?: boolean;
  path?: string;
  addedAt: number;
};

const viewerIdentities = new Map<string, ViewerIdentity>();

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function rememberViewerIdentity(
  sessionId: string,
  identity: Omit<ViewerIdentity, "addedAt">
) {
  if (!sessionId) return;
  viewerIdentities.set(sessionId, { ...identity, addedAt: Date.now() });
}

export function getViewerIdentity(sessionId: string): ViewerIdentity | undefined {
  return viewerIdentities.get(sessionId);
}

export function pruneViewerIdentities(activeSessionIds: Iterable<string>) {
  const active = new Set(activeSessionIds);
  const now = Date.now();
  for (const [id, identity] of viewerIdentities) {
    if (!active.has(id) || now - identity.addedAt > MAX_AGE_MS) {
      viewerIdentities.delete(id);
    }
  }
}
