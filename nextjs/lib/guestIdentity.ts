// Pony names and avatars ("guest identities", see ponyKeyFor for who gets one).
// Avatars are hotlinked from Derpibooru's CDN; only the chosen URL is stored.
// Identities are per path + key and last for one stream session, unless kept.
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import {
  getGuestIdentity,
  getPathVisibility,
  getStreamSessionByPath,
  saveGuestIdentity,
  type GuestIdentityRow,
} from './db'
import { PONY_NAMES } from './ponyNames'

// Any Philomena-based booru works; read at call time so tests can redirect it.
function booruSearchUrl(): string {
  const base = (
    process.env.GUEST_AVATAR_BOORU_URL || 'https://derpibooru.org'
  ).replace(/\/+$/, '')
  return `${base}/api/v1/json/search/images`
}
const POOL_SIZE = 20
// More than one, so there's still a pick when the first is the current picture.
const REROLL_BATCH_SIZE = 3
const POOL_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_AFTER_FAILURE_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 5000
// Derpibooru answers bursts with HTTP 429, e.g. when many guests join at once.
const MIN_REQUEST_GAP_MS = 500
const RATE_LIMIT_BACKOFF_MS = 5000
// Used when a pony has no matching pictures.
const FALLBACK_TAG = 'pony'
// How long joining the watch room waits for a new avatar; slower picks still get stored.
const AVATAR_WAIT_MS = 2000
// Between a guest's own rerolls (favorite tag changes count too); the streamer isn't limited.
export const GUEST_REROLL_COOLDOWN_MS = 30 * 1000
const FAVORITE_TAG_MAX_LENGTH = 60

type PonyName = readonly [name: string, tag: string]

// Quotes and backslashes removed, so a tag can't alter the query.
function cleanTag(tag: string): string {
  return tag.replace(/["\\]/g, '').trim().toLowerCase()
}

// GUEST_PONY_NAMES_FILE replaces the built-in list: one pony per line, as
// "Name" or "Name | derpibooru tag" (the tag defaults to the name). Lines
// starting with # are ignored.
function loadPonyNames(): readonly PonyName[] {
  const file = (process.env.GUEST_PONY_NAMES_FILE ?? '').trim()
  if (!file) return PONY_NAMES
  try {
    const names = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line): PonyName[] => {
        const text = line.trim()
        if (!text || text.startsWith('#')) return []
        const [rawName, rawTag] = text.split('|', 2)
        const name = rawName.trim()
        const tag = cleanTag(rawTag ?? name)
        return name && tag ? [[name, tag]] : []
      })
    if (names.length > 0) return names
    console.error(`No pony names in ${file}, using the built-in list`)
  } catch (err) {
    console.error(
      `Failed to read pony names from ${file}, using the built-in list:`,
      err,
    )
  }
  return PONY_NAMES
}

const ponyNames = loadPonyNames()

// Empty = Derpibooru's default filter.
const filterId = (process.env.GUEST_AVATAR_FILTER_ID ?? '').trim()

// Comma-separated tags, "-" prefix excludes. Quoted so they can't alter the query.
const extraTags = (process.env.GUEST_AVATAR_TAGS ?? '')
  .split(',')
  .map((t) => {
    const negated = t.trim().startsWith('-')
    const tag = cleanTag(t.trim().replace(/^-/, ''))
    return tag ? `${negated ? '-' : ''}"${tag}"` : ''
  })
  .filter(Boolean)

// Stored with each avatar, so changing the settings re-picks avatars. A custom
// name list gives guests different ponies, so it's part of the settings too.
const settingsKey = [
  filterId,
  ...extraTags,
  ...(ponyNames === PONY_NAMES
    ? []
    : [
        `names:${createHash('sha256').update(JSON.stringify(ponyNames)).digest('hex').slice(0, 12)}`,
      ]),
].join('|')

function ponyFor(seed: string): PonyName {
  const digest = createHash('sha256')
    .update(`${process.env.NEXTAUTH_SECRET ?? ''}:guest:${seed}`)
    .digest()
  return ponyNames[digest.readUInt32BE(0) % ponyNames.length]
}

const store = globalThis as typeof globalThis & {
  __guestAvatarPools?: Map<string, { urls: string[]; expiresAt: number }>
  __guestAvatarRequests?: Map<string, Promise<string[] | null>>
  __guestAvatarPicks?: Map<string, Promise<string | null>>
  __guestRerolledAt?: Map<string, number>
  __derpibooruNextSlotAt?: number
}
const pools = (store.__guestAvatarPools ??= new Map())
const inflight = (store.__guestAvatarRequests ??= new Map())
// Keyed by identityKey(), so parallel requests agree on one image.
const avatarPicks = (store.__guestAvatarPicks ??= new Map())
// Keyed by identityKey(): when a guest last rerolled, for the cooldown.
const rerolledAt = (store.__guestRerolledAt ??= new Map())

async function waitForRequestSlot(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, store.__derpibooruNextSlotAt ?? 0)
  store.__derpibooruNextSlotAt = at + MIN_REQUEST_GAP_MS
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
}

function backOff(res: Response): void {
  const retryAfterS = Number(res.headers.get('retry-after'))
  const waitMs = retryAfterS > 0 ? retryAfterS * 1000 : RATE_LIMIT_BACKOFF_MS
  store.__derpibooruNextSlotAt = Math.max(
    store.__derpibooruNextSlotAt ?? 0,
    Date.now() + waitMs,
  )
}

// null = request failed (as opposed to [] = no matching images).
async function fetchPool(
  tag: string,
  favoriteTag: string | null,
  count = POOL_SIZE,
  retryOnRateLimit = true,
): Promise<string[] | null> {
  const params = new URLSearchParams({
    q: [
      `"${tag}"`,
      ...(favoriteTag ? [`"${favoriteTag}"`] : []),
      'solo',
      ...extraTags,
      'score.gte:50',
      '-animated',
    ].join(', '),
    per_page: String(count),
    sf: 'random',
  })
  if (filterId) params.set('filter_id', filterId)

  try {
    await waitForRequestSlot()
    const res = await fetch(`${booruSearchUrl()}?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MTXcord guest avatars',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) {
      if (res.status === 429) {
        backOff(res)
        if (retryOnRateLimit) return fetchPool(tag, favoriteTag, count, false)
      }
      console.error(
        `Failed to fetch guest avatars for "${tag}": HTTP ${res.status}`,
      )
      return null
    }
    const data = (await res.json()) as {
      images?: { representations?: { thumb_small?: string } }[]
    }
    return (data.images ?? [])
      .map((image) => image.representations?.thumb_small)
      .filter((url): url is string => !!url?.startsWith('https://'))
  } catch (err) {
    console.error(`Failed to fetch guest avatars for "${tag}":`, err)
    return null
  }
}

async function poolFor(
  tag: string,
  favoriteTag: string | null,
): Promise<string[]> {
  const key = favoriteTag ? `${tag}\n${favoriteTag}` : tag
  const cached = pools.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.urls

  let request = inflight.get(key)
  if (!request) {
    request = fetchPool(tag, favoriteTag).finally(() => inflight.delete(key))
    inflight.set(key, request)
  }
  const urls = await request
  if (urls === null) {
    // Keep serving the stale pool, and retry soon.
    const stale = cached?.urls ?? []
    pools.set(key, {
      urls: stale,
      expiresAt: Date.now() + RETRY_AFTER_FAILURE_MS,
    })
    return stale
  }
  pools.set(key, { urls, expiresAt: Date.now() + POOL_TTL_MS })
  return urls
}

// Who gets a pony: password viewers (by IP), and Discord viewers on public
// streams (by account name). null = shown with their own identity.
export function ponyKeyFor(
  role: string | undefined,
  name: string | null | undefined,
  ip: string,
  path: string,
): string | null {
  if (role === 'viewer') return ip
  if (role === 'discord' && name && getPathVisibility(path) === 'public')
    return `discord:${name}`
  return null
}

export function ponyKeyForSession(
  identity: { role?: string; name?: string; ip?: string; path?: string } | undefined,
): { path: string; ponyKey: string } | null {
  if (!identity?.ip || !identity.path) return null
  const ponyKey = ponyKeyFor(identity.role, identity.name, identity.ip, identity.path)
  return ponyKey ? { path: identity.path, ponyKey } : null
}

function identityKey(path: string, key: string): string {
  return `${path}::${key}`
}

// The row for the current stream; a fresh one when there's none yet or it
// belongs to a previous stream and wasn't kept.
function currentRow(path: string, key: string): GuestIdentityRow {
  const row = getGuestIdentity(path, key)
  const session = getStreamSessionByPath(path)?.id ?? null
  // While offline (no session) keep whatever they had.
  const expired =
    row && !row.keep && session !== null && row.stream_session_id !== session
  if (row && !expired) return row

  const fresh: GuestIdentityRow = {
    path,
    ip: key,
    // Deterministic, so concurrent first requests produce the same identity.
    seed: `${key}:${session ?? 'none'}`,
    avatar_url: null,
    avatar_settings: null,
    keep: 0,
    stream_session_id: session,
    // A guest's taste outlives their pony.
    favorite_tag: row?.favorite_tag ?? null,
  }
  saveGuestIdentity(fresh)
  return fresh
}

function avatarSettings(row: GuestIdentityRow): string {
  return row.favorite_tag
    ? `${settingsKey}|favorite:${row.favorite_tag}`
    : settingsKey
}

function storedAvatar(row: GuestIdentityRow): string | null {
  return row.avatar_settings === avatarSettings(row) ? row.avatar_url : null
}

// The favorite tag is dropped when the pony has no pictures with it.
async function pickAvatar(
  row: GuestIdentityRow,
  exclude: string | null,
): Promise<string | null> {
  const [, tag] = ponyFor(row.seed)
  const searches: [string, string | null][] = [
    ...(row.favorite_tag
      ? [[tag, row.favorite_tag] as [string, string | null]]
      : []),
    [tag, null],
    [FALLBACK_TAG, null],
  ]
  for (const [search, favoriteTag] of searches) {
    const choices = (await poolFor(search, favoriteTag)).filter(
      (u) => u !== exclude,
    )
    if (choices.length > 0)
      return choices[Math.floor(Math.random() * choices.length)]
  }
  return null
}

function assignAvatar(row: GuestIdentityRow): Promise<string | null> {
  const key = identityKey(row.path, row.ip)
  let pick = avatarPicks.get(key)
  if (!pick) {
    pick = pickAvatar(row, null)
      .then((url) => {
        // Only store it if the identity hasn't moved on meanwhile.
        const latest = getGuestIdentity(row.path, row.ip)
        if (url && latest?.seed === row.seed) {
          saveGuestIdentity({
            ...latest,
            avatar_url: url,
            avatar_settings: avatarSettings(row),
          })
        }
        return url
      })
      .finally(() => avatarPicks.delete(key))
    avatarPicks.set(key, pick)
  }
  return pick
}

export type GuestIdentity = {
  name: string
  // null until picked, or when Derpibooru is unreachable (UI shows initials).
  image: string | null
  kept: boolean
  favoriteTag: string | null
}

function toIdentity(
  row: GuestIdentityRow,
  image: string | null,
): GuestIdentity {
  return {
    name: ponyFor(row.seed)[0],
    image,
    kept: row.keep === 1,
    favoriteTag: row.favorite_tag,
  }
}

export async function guestIdentity(
  path: string,
  key: string,
): Promise<GuestIdentity> {
  const row = currentRow(path, key)
  const stored = storedAvatar(row)
  if (stored) return toIdentity(row, stored)
  const image = await Promise.race([
    assignAvatar(row),
    new Promise<null>((resolve) => setTimeout(resolve, AVATAR_WAIT_MS, null)),
  ])
  return toIdentity(row, image)
}

// Non-blocking: returns the avatar only if already known, and starts picking one otherwise.
export function cachedGuestIdentity(path: string, key: string): GuestIdentity {
  const row = currentRow(path, key)
  const image = storedAvatar(row)
  if (!image) void assignAvatar(row)
  return toIdentity(row, image)
}

// Kept identities survive future streams; releasing keeps it for the current one.
export function setGuestKeep(
  path: string,
  key: string,
  keep: boolean,
): GuestIdentity {
  const row = currentRow(path, key)
  const updated: GuestIdentityRow = {
    ...row,
    keep: keep ? 1 : 0,
    stream_session_id:
      getStreamSessionByPath(path)?.id ?? row.stream_session_id,
  }
  saveGuestIdentity(updated)
  return toIdentity(updated, storedAvatar(updated))
}

export type RerollResult = GuestIdentity & {
  // false when the pony has no pictures with the favorite tag (so it was
  // ignored); null when there's no favorite tag or Derpibooru didn't answer.
  favoriteTagMatched: boolean | null
}

export async function rerollGuestAvatar(
  path: string,
  key: string,
): Promise<RerollResult> {
  // Let a running pick finish first, so it can't overwrite the reroll.
  await avatarPicks.get(identityKey(path, key))
  const row = currentRow(path, key)
  // The previous picture, even if it was picked with other settings.
  const current = row.avatar_url

  // A fresh random batch rather than the cached pool, so rerolls don't cycle
  // through the same pictures.
  const [, tag] = ponyFor(row.seed)
  const fresh = await fetchPool(tag, row.favorite_tag, REROLL_BATCH_SIZE)
  const url =
    fresh?.find((u) => u !== current) ?? (await pickAvatar(row, current))

  if (url)
    saveGuestIdentity({
      ...row,
      avatar_url: url,
      avatar_settings: avatarSettings(row),
    })
  return {
    ...toIdentity(row, url ?? current),
    favoriteTagMatched: row.favorite_tag && fresh ? fresh.length > 0 : null,
  }
}

export function guestRerollWaitMs(path: string, key: string): number {
  const at = rerolledAt.get(identityKey(path, key))
  return at ? Math.max(0, at + GUEST_REROLL_COOLDOWN_MS - Date.now()) : 0
}

// Starts the cooldown if it's over, and returns 0; otherwise the remaining ms.
export function claimGuestReroll(path: string, key: string): number {
  const wait = guestRerollWaitMs(path, key)
  if (wait > 0) return wait
  const now = Date.now()
  rerolledAt.set(identityKey(path, key), now)
  if (rerolledAt.size > 1000) {
    for (const [k, at] of rerolledAt) {
      if (now - at >= GUEST_REROLL_COOLDOWN_MS) rerolledAt.delete(k)
    }
  }
  return 0
}

// A single tag to require (not exclude); null = not usable as one.
export function normalizeFavoriteTag(input: string): string | null {
  const tag = cleanTag(input).replace(/^-+/, '').replace(/\s+/g, ' ').trim()
  if (!tag || tag.length > FAVORITE_TAG_MAX_LENGTH || tag.includes(','))
    return null
  return tag
}

// null clears it. Picks a new picture that has the tag, when there's one.
export async function setGuestFavoriteTag(
  path: string,
  key: string,
  favoriteTag: string | null,
): Promise<RerollResult> {
  await avatarPicks.get(identityKey(path, key))
  saveGuestIdentity({
    ...currentRow(path, key),
    favorite_tag: favoriteTag,
  })
  return rerollGuestAvatar(path, key)
}
