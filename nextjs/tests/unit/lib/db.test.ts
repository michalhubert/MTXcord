import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveViewer,
  closeDb,
  createStreamSession,
  DEFAULT_STREAM_SETTINGS,
  deleteStreamSession,
  getAccessRequest,
  getAllViewerPasswords,
  getGuestIdentity,
  getPathVisibility,
  getStreamSessionByPath,
  getStreamSettings,
  getViewerPassword,
  isViewerApproved,
  rotateViewerPassword,
  saveStreamSettings,
  setPathVisibility,
  setViewerPassword,
  touchAccessRequest,
} from '@/lib/db'

describe('db defaults and helpers (in-memory)', () => {
  it('creates the schema on first use', () => {
    // Any query would throw if a table were missing.
    expect(getPathVisibility('x')).toBe('private')
    expect(getAllViewerPasswords()).toEqual({})
    expect(getStreamSessionByPath('x')).toBeNull()
    expect(getAccessRequest('x', '1.1.1.1', 'viewer')).toBeNull()
    expect(isViewerApproved('x', '1.1.1.1', 'viewer')).toBe(false)
  })

  it('defaults path visibility to private and stores changes', () => {
    expect(getPathVisibility('a')).toBe('private')
    setPathVisibility('a', 'public')
    expect(getPathVisibility('a')).toBe('public')
    setPathVisibility('a', 'private')
    expect(getPathVisibility('a')).toBe('private')
    expect(getPathVisibility('b')).toBe('private')
  })

  it('rotateViewerPassword stores a fresh 32-hex password each time', () => {
    const first = rotateViewerPassword('live')
    const second = rotateViewerPassword('live')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
    expect(getViewerPassword('live')).toBe(second)
  })

  it('stores viewer passwords per path', () => {
    setViewerPassword('a', 'pw-a')
    setViewerPassword('b', 'pw-b')
    expect(getViewerPassword('a')).toBe('pw-a')
    expect(getViewerPassword('missing')).toBeNull()
    expect(getAllViewerPasswords()).toEqual({ a: 'pw-a', b: 'pw-b' })
  })

  it('createStreamSession replaces the old session and gives a new id', () => {
    const first = createStreamSession('live', 'r1')
    const second = createStreamSession('live', 'r2')
    expect(second.id).not.toBe(first.id)
    expect(second.resource_id).toBe('r2')
    expect(getStreamSessionByPath('live')?.id).toBe(second.id)

    deleteStreamSession('live')
    expect(getStreamSessionByPath('live')).toBeNull()
    expect(createStreamSession('live').id).toBeGreaterThan(second.id)
  })

  it('getStreamSettings returns defaults, then merges stored values over them', () => {
    expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS)
    saveStreamSettings({ ...DEFAULT_STREAM_SETTINGS, fps: 60, path: 'p' })
    expect(getStreamSettings()).toEqual({
      ...DEFAULT_STREAM_SETTINGS,
      fps: 60,
      path: 'p',
    })
  })

  it('merges defaults for fields missing from stored settings', () => {
    saveStreamSettings({ fps: 15 } as never)
    expect(getStreamSettings()).toEqual({ ...DEFAULT_STREAM_SETTINGS, fps: 15 })
  })

  it('approvals are keyed by path, ip and role', () => {
    approveViewer('p', '1.1.1.1', 'viewer')
    expect(isViewerApproved('p', '1.1.1.1', 'viewer')).toBe(true)
    expect(isViewerApproved('p', '1.1.1.1', 'discord')).toBe(false)
    expect(isViewerApproved('q', '1.1.1.1', 'viewer')).toBe(false)
  })
})

describe('db with a file database', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mtxcord-db-'))
    file = join(dir, 'test.db')
    closeDb()
    vi.stubEnv('MTXCORD_DB_PATH', file)
  })

  afterEach(() => {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })

  const columns = (conn: Database.Database, table: string) =>
    (conn.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)

  it('migrates an old-schema database', () => {
    const old = new Database(file)
    old.exec(`
      CREATE TABLE guest_identities (
        path TEXT NOT NULL, ip TEXT NOT NULL, seed TEXT NOT NULL,
        avatar_url TEXT, avatar_ratings TEXT,
        keep INTEGER NOT NULL DEFAULT 0, stream_session_id INTEGER,
        PRIMARY KEY (path, ip)
      );
      CREATE TABLE access_requests (
        path TEXT NOT NULL, ip TEXT NOT NULL, role TEXT NOT NULL,
        name TEXT, image TEXT, discord_id TEXT,
        requested_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (path, ip, role)
      );
      CREATE TABLE denial_records (path TEXT, ip TEXT);
      INSERT INTO guest_identities (path, ip, seed, avatar_url, avatar_ratings, keep)
        VALUES ('live', '1.2.3.4', 'seed', 'https://x/y.png', 'safe', 1);
      INSERT INTO access_requests (path, ip, role, requested_at, last_seen_at)
        VALUES ('live', '1.2.3.4', 'viewer', 1, 1);
    `)
    old.close()

    // Opens (and migrates) on first use.
    expect(getGuestIdentity('live', '1.2.3.4')).toEqual({
      path: 'live',
      ip: '1.2.3.4',
      seed: 'seed',
      avatar_url: 'https://x/y.png',
      avatar_settings: 'safe',
      keep: 1,
      stream_session_id: null,
      favorite_tag: null,
    })
    expect(getAccessRequest('live', '1.2.3.4', 'viewer')).toMatchObject({
      client_ip: null,
      requested_at: 1,
    })

    const check = new Database(file, { readonly: true })
    try {
      expect(columns(check, 'guest_identities')).toContain('avatar_settings')
      expect(columns(check, 'guest_identities')).not.toContain('avatar_ratings')
      expect(columns(check, 'guest_identities')).toContain('favorite_tag')
      expect(columns(check, 'access_requests')).toContain('client_ip')
      const tables = (
        check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((t) => t.name)
      expect(tables).not.toContain('denial_records')
      expect(tables).toEqual(
        expect.arrayContaining(['access_blocks', 'discord_webhook_messages']),
      )
    } finally {
      check.close()
    }
  })

  it('reopening an already migrated database keeps its data', () => {
    setViewerPassword('live', 'pw')
    touchAccessRequest(
      {
        path: 'live',
        ip: '1.1.1.1',
        role: 'viewer',
        name: null,
        image: null,
        discord_id: null,
        client_ip: '1.1.1.1',
      },
      5,
    )
    closeDb()
    expect(getViewerPassword('live')).toBe('pw')
    expect(getAccessRequest('live', '1.1.1.1', 'viewer')?.requested_at).toBe(5)
  })

  it('getStreamSettings survives corrupt JSON', () => {
    saveStreamSettings({ ...DEFAULT_STREAM_SETTINGS, fps: 24 })
    closeDb()
    const raw = new Database(file)
    raw.prepare('UPDATE stream_settings SET data = ?').run('{not json')
    raw.close()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS)
  })
})
