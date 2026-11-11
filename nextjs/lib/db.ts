// noinspection SqlNoDataSourceInspection

import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'

import { DEFAULT_STREAM_SETTINGS, type StreamSettings } from './streamSettings'

export * from './streamSettings'
export type PathVisibility = 'public' | 'private'

const DEFAULT_DB_PATH = '/data/sqlite/mtxcord.db'
// Pre-rename (DiscordMTX) databases; not migrated, only cleaned up.
const OLD_DB_PATHS = ['/data/sqlite/discordmtx.db', '/data/discordmtx.db']

function removeOldDbs(): void {
  for (const path of OLD_DB_PATHS) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix, { force: true })
      } catch (err) {
        console.error(
          `Failed to remove the old database ${path + suffix}:`,
          err,
        )
      }
    }
  }
}

let db: Database.Database | null = null

// Closes the connection; the next call reopens it (a fresh schema for ':memory:').
export function closeDb(): void {
  db?.close()
  db = null
}

function getDb(): Database.Database {
  if (db) return db

  // MTXCORD_DB_PATH is for tests (':memory:' or a temp file); the default
  // location is the container's /data volume.
  const override = process.env.MTXCORD_DB_PATH
  const dbPath = override || DEFAULT_DB_PATH
  if (dbPath !== ':memory:') {
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
    } catch {}
  }
  if (!override) removeOldDbs()

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON') // needed for ON DELETE CASCADE to actually run
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS path_visibility (
      path TEXT PRIMARY KEY,
      visibility TEXT NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS viewer_passwords (
      path TEXT PRIMARY KEY,
      password TEXT NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      started_at INTEGER NOT NULL,
      resource_id TEXT
    );
  `)
  db.exec('DROP TABLE IF EXISTS denial_records')
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_blocks (
      path TEXT NOT NULL,
      subject TEXT NOT NULL,
      reason TEXT NOT NULL,
      denial_count INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL,
      PRIMARY KEY (path, subject)
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      path TEXT NOT NULL,
      ip TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT,
      image TEXT,
      discord_id TEXT,
      client_ip TEXT,
      requested_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (path, ip, role)
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS approved_viewers (
      path TEXT NOT NULL,
      ip TEXT NOT NULL,
      role TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      PRIMARY KEY (path, ip, role)
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_identities (
      path TEXT NOT NULL,
      ip TEXT NOT NULL,
      seed TEXT NOT NULL,
      avatar_url TEXT,
      avatar_settings TEXT,
      keep INTEGER NOT NULL DEFAULT 0,
      stream_session_id INTEGER,
      PRIMARY KEY (path, ip)
    );
  `)
  const guestColumns = db.pragma('table_info(guest_identities)') as {
    name: string
  }[]
  if (guestColumns.some((c) => c.name === 'avatar_ratings')) {
    db.exec(
      'ALTER TABLE guest_identities RENAME COLUMN avatar_ratings TO avatar_settings',
    )
  }
  if (!guestColumns.some((c) => c.name === 'favorite_tag')) {
    db.exec('ALTER TABLE guest_identities ADD COLUMN favorite_tag TEXT')
  }
  const requestColumns = db.pragma('table_info(access_requests)') as {
    name: string
  }[]
  if (!requestColumns.some((c) => c.name === 'client_ip')) {
    db.exec('ALTER TABLE access_requests ADD COLUMN client_ip TEXT')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_webhook_messages (
      path TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );
  `)
  return db
}

export function getStreamSettings(): StreamSettings {
  try {
    const row = getDb()
      .prepare('SELECT data FROM stream_settings WHERE id = 1')
      .get() as { data: string } | undefined
    if (!row) return DEFAULT_STREAM_SETTINGS
    return { ...DEFAULT_STREAM_SETTINGS, ...JSON.parse(row.data) }
  } catch (err) {
    console.error('Failed to read stream settings:', err)
    return DEFAULT_STREAM_SETTINGS
  }
}

export function saveStreamSettings(settings: StreamSettings): void {
  const data = JSON.stringify(settings)
  getDb()
    .prepare(
      `INSERT INTO stream_settings (id, data) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    )
    .run(data)
}

export function getPathVisibility(path: string): PathVisibility {
  try {
    const row = getDb()
      .prepare('SELECT visibility FROM path_visibility WHERE path = ?')
      .get(path) as { visibility: string } | undefined
    return row?.visibility === 'public' ? 'public' : 'private'
  } catch (err) {
    console.error('Failed to read path visibility:', err)
    return 'private'
  }
}

export function getAllPathVisibilities(): Record<string, PathVisibility> {
  try {
    const rows = getDb()
      .prepare('SELECT path, visibility FROM path_visibility')
      .all() as { path: string; visibility: string }[]
    const result: Record<string, PathVisibility> = {}
    for (const row of rows) {
      result[row.path] = row.visibility === 'public' ? 'public' : 'private'
    }
    return result
  } catch (err) {
    console.error('Failed to read path visibilities:', err)
    return {}
  }
}

export function setPathVisibility(
  path: string,
  visibility: PathVisibility,
): void {
  getDb()
    .prepare(
      `INSERT INTO path_visibility (path, visibility) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET visibility = excluded.visibility`,
    )
    .run(path, visibility)
}

export function getViewerPassword(path: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT password FROM viewer_passwords WHERE path = ?')
      .get(path) as { password: string } | undefined
    return row?.password ?? null
  } catch (err) {
    console.error('Failed to read viewer password:', err)
    return null
  }
}

export function getAllViewerPasswords(): Record<string, string> {
  try {
    const rows = getDb()
      .prepare('SELECT path, password FROM viewer_passwords')
      .all() as Array<{ path: string; password: string }>
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.path] = row.password
    }
    return result
  } catch (err) {
    console.error('Failed to read all viewer passwords:', err)
    return {}
  }
}

export function setViewerPassword(path: string, password: string): void {
  getDb()
    .prepare(
      `INSERT INTO viewer_passwords (path, password) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET password = excluded.password`,
    )
    .run(path, password)
}

export function rotateViewerPassword(path: string): string {
  const crypto = require('crypto')
  const newPassword = crypto.randomBytes(16).toString('hex')
  setViewerPassword(path, newPassword)
  return newPassword
}

export type AccessBlockRow = {
  path: string
  subject: string
  reason: 'kicked' | 'denied'
  denial_count: number
  blocked_until: number
}

export type StreamSession = {
  id: number
  path: string
  started_at: number
  resource_id: string | null
}

export function getStreamSessionByPath(path: string): StreamSession | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT id, path, started_at, resource_id FROM stream_sessions WHERE path = ?',
      )
      .get(path) as StreamSession | undefined
    return row ?? null
  } catch (err) {
    console.error('Failed to read stream session:', err)
    return null
  }
}

export function createStreamSession(
  path: string,
  resourceId: string | null = null,
): StreamSession {
  const now = Date.now()
  // Force-finish any stale session for this path before inserting the new one.
  const db = getDb()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM stream_sessions WHERE path = ?').run(path)
    db.prepare(
      'INSERT INTO stream_sessions (path, started_at, resource_id) VALUES (?, ?, ?)',
    ).run(path, now, resourceId)
  })
  run()

  return getStreamSessionByPath(path)!
}

export function deleteStreamSession(path: string): void {
  getDb().prepare('DELETE FROM stream_sessions WHERE path = ?').run(path)
}

export function getAccessBlock(
  path: string,
  subject: string,
): AccessBlockRow | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT path, subject, reason, denial_count, blocked_until FROM access_blocks WHERE path = ? AND subject = ?',
      )
      .get(path, subject) as AccessBlockRow | undefined
    return row ?? null
  } catch (err) {
    console.error('Failed to read access block:', err)
    return null
  }
}

export function setAccessBlock(row: AccessBlockRow): void {
  getDb()
    .prepare(
      `INSERT INTO access_blocks (path, subject, reason, denial_count, blocked_until)
       VALUES (@path, @subject, @reason, @denial_count, @blocked_until)
       ON CONFLICT(path, subject) DO UPDATE SET
         reason = excluded.reason,
         denial_count = excluded.denial_count,
         blocked_until = excluded.blocked_until`,
    )
    .run(row)
}

export function deleteAccessBlock(path: string, subject: string): void {
  getDb()
    .prepare('DELETE FROM access_blocks WHERE path = ? AND subject = ?')
    .run(path, subject)
}

export function deleteAccessBlocks(
  path: string,
  reason: AccessBlockRow['reason'],
): void {
  getDb()
    .prepare('DELETE FROM access_blocks WHERE path = ? AND reason = ?')
    .run(path, reason)
}

export function pruneAccessBlocks(endedBefore: number): void {
  getDb()
    .prepare('DELETE FROM access_blocks WHERE blocked_until < ?')
    .run(endedBefore)
}

export type AccessRequestRow = {
  path: string
  ip: string
  role: string
  name: string | null
  image: string | null
  discord_id: string | null
  // `ip` is the approval key (`discord:<id>` for Discord viewers); this is the real address.
  client_ip: string | null
  requested_at: number
  last_seen_at: number
}

export function touchAccessRequest(
  row: Omit<AccessRequestRow, 'requested_at' | 'last_seen_at'>,
  now: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO access_requests (path, ip, role, name, image, discord_id, client_ip, requested_at, last_seen_at)
       VALUES (@path, @ip, @role, @name, @image, @discord_id, @client_ip, @now, @now)
       ON CONFLICT(path, ip, role) DO UPDATE SET
         name = excluded.name,
         image = excluded.image,
         discord_id = excluded.discord_id,
         client_ip = excluded.client_ip,
         last_seen_at = excluded.last_seen_at`,
    )
    .run({ ...row, now })
}

export function getAccessRequest(
  path: string,
  ip: string,
  role: string,
): AccessRequestRow | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT * FROM access_requests WHERE path = ? AND ip = ? AND role = ?',
      )
      .get(path, ip, role) as AccessRequestRow | undefined
    return row ?? null
  } catch (err) {
    console.error('Failed to read access request:', err)
    return null
  }
}

export function listAccessRequests(seenSince: number): AccessRequestRow[] {
  try {
    const db = getDb()
    db.prepare('DELETE FROM access_requests WHERE last_seen_at < ?').run(
      seenSince,
    )
    return db
      .prepare('SELECT * FROM access_requests ORDER BY requested_at')
      .all() as AccessRequestRow[]
  } catch (err) {
    console.error('Failed to list access requests:', err)
    return []
  }
}

export function deleteAccessRequest(
  path: string,
  ip: string,
  role: string,
): void {
  getDb()
    .prepare(
      'DELETE FROM access_requests WHERE path = ? AND ip = ? AND role = ?',
    )
    .run(path, ip, role)
}

export function deleteAccessRequestsForPath(path: string): void {
  getDb().prepare('DELETE FROM access_requests WHERE path = ?').run(path)
}

export type ApprovedViewerRow = { path: string; ip: string; role: string }

export function isViewerApproved(
  path: string,
  ip: string,
  role: string,
): boolean {
  try {
    return !!getDb()
      .prepare(
        'SELECT 1 FROM approved_viewers WHERE path = ? AND ip = ? AND role = ?',
      )
      .get(path, ip, role)
  } catch (err) {
    console.error('Failed to read approval:', err)
    return false
  }
}

export function approveViewer(path: string, ip: string, role: string): void {
  getDb()
    .prepare(
      `INSERT INTO approved_viewers (path, ip, role, approved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path, ip, role) DO UPDATE SET approved_at = excluded.approved_at`,
    )
    .run(path, ip, role, Date.now())
}

export function listApprovedViewers(): ApprovedViewerRow[] {
  try {
    return getDb()
      .prepare('SELECT path, ip, role FROM approved_viewers')
      .all() as ApprovedViewerRow[]
  } catch (err) {
    console.error('Failed to list approvals:', err)
    return []
  }
}

export function deleteApproval(path: string, ip: string, role: string): void {
  getDb()
    .prepare(
      'DELETE FROM approved_viewers WHERE path = ? AND ip = ? AND role = ?',
    )
    .run(path, ip, role)
}

export function deleteApprovalsForPath(path: string): void {
  getDb().prepare('DELETE FROM approved_viewers WHERE path = ?').run(path)
}

export function getDiscordWebhookMessageId(path: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT message_id FROM discord_webhook_messages WHERE path = ?')
      .get(path) as { message_id: string } | undefined
    return row?.message_id ?? null
  } catch (err) {
    console.error('Failed to read discord webhook message id:', err)
    return null
  }
}

export function setDiscordWebhookMessageId(
  path: string,
  messageId: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO discord_webhook_messages (path, message_id) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET message_id = excluded.message_id`,
    )
    .run(path, messageId)
}

export function deleteDiscordWebhookMessageId(path: string): void {
  getDb()
    .prepare('DELETE FROM discord_webhook_messages WHERE path = ?')
    .run(path)
}

export type GuestIdentityRow = {
  path: string
  ip: string
  seed: string
  avatar_url: string | null
  avatar_settings: string | null
  keep: number
  stream_session_id: number | null
  favorite_tag: string | null
}

export function getGuestIdentity(
  path: string,
  ip: string,
): GuestIdentityRow | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT path, ip, seed, avatar_url, avatar_settings, keep, stream_session_id, favorite_tag FROM guest_identities WHERE path = ? AND ip = ?',
      )
      .get(path, ip) as GuestIdentityRow | undefined
    return row ?? null
  } catch (err) {
    console.error('Failed to read guest identity:', err)
    return null
  }
}

export function saveGuestIdentity(row: GuestIdentityRow): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO guest_identities (path, ip, seed, avatar_url, avatar_settings, keep, stream_session_id, favorite_tag)
         VALUES (@path, @ip, @seed, @avatar_url, @avatar_settings, @keep, @stream_session_id, @favorite_tag)
         ON CONFLICT(path, ip) DO UPDATE SET
           seed = excluded.seed,
           avatar_url = excluded.avatar_url,
           avatar_settings = excluded.avatar_settings,
           keep = excluded.keep,
           stream_session_id = excluded.stream_session_id,
           favorite_tag = excluded.favorite_tag`,
      )
      .run(row)
  } catch (err) {
    console.error('Failed to save guest identity:', err)
  }
}
