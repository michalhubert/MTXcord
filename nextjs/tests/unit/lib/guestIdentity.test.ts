import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cachedGuestIdentity,
  claimGuestReroll,
  GUEST_REROLL_COOLDOWN_MS,
  guestIdentity,
  guestRerollWaitMs,
  normalizeFavoriteTag,
  ponyKeyFor,
  ponyKeyForSession,
  rerollGuestAvatar,
  setGuestFavoriteTag,
  setGuestKeep,
} from '@/lib/guestIdentity'
import {
  createStreamSession,
  deleteStreamSession,
  getGuestIdentity,
  setPathVisibility,
} from '@/lib/db'
import { PONY_NAMES } from '@/lib/ponyNames'
import { useFakeDerpibooru } from '../../helpers/msw'
import { useFakeClock } from '../../helpers/clock'

const IP = '203.0.113.10'

// The booru is rate-limited to one request per 500 ms; tests skip that wait.
const freeRequestSlot = () => {
  delete (globalThis as { __derpibooruNextSlotAt?: number }).__derpibooruNextSlotAt
}

const queryOf = (url: URL) => url.searchParams.get('q')

describe('normalizeFavoriteTag', () => {
  it.each([
    ['Rainbow Dash', 'rainbow dash'],
    ['  spaced   out   tag  ', 'spaced out tag'],
    ['"quoted"', 'quoted'],
    ['back\\slash', 'backslash'],
    ['-negated', 'negated'],
    ['---many', 'many'],
    ['- spaced', 'spaced'],
    ['UPPER', 'upper'],
  ])('cleans %j to %j', (input, expected) => {
    expect(normalizeFavoriteTag(input)).toBe(expected)
  })

  it.each(['', '   ', '""', '-', 'a,b', ',', 'x'.repeat(61)])('rejects %j', (input) => {
    expect(normalizeFavoriteTag(input)).toBeNull()
  })

  it('accepts exactly 60 characters', () => {
    expect(normalizeFavoriteTag('x'.repeat(60))).toBe('x'.repeat(60))
  })
})

describe('ponyKeyFor', () => {
  it('keys password viewers by IP', () => {
    expect(ponyKeyFor('viewer', null, IP, 'live')).toBe(IP)
    setPathVisibility('live', 'public')
    expect(ponyKeyFor('viewer', null, IP, 'live')).toBe(IP)
  })

  it('keys Discord viewers by name on public streams only', () => {
    expect(ponyKeyFor('discord', 'Luna', IP, 'live')).toBeNull()
    setPathVisibility('live', 'public')
    expect(ponyKeyFor('discord', 'Luna', IP, 'live')).toBe('discord:Luna')
    expect(ponyKeyFor('discord', null, IP, 'live')).toBeNull()
    expect(ponyKeyFor('discord', '', IP, 'live')).toBeNull()
  })

  it('gives the streamer and unknown roles no pony', () => {
    setPathVisibility('live', 'public')
    expect(ponyKeyFor('streamer', 'x', IP, 'live')).toBeNull()
    expect(ponyKeyFor(undefined, 'x', IP, 'live')).toBeNull()
  })

  it('derives the key for a remembered session identity', () => {
    expect(ponyKeyForSession(undefined)).toBeNull()
    expect(ponyKeyForSession({ role: 'viewer', ip: IP })).toBeNull() // no path
    expect(ponyKeyForSession({ role: 'viewer', path: 'live' })).toBeNull() // no ip
    expect(ponyKeyForSession({ role: 'viewer', ip: IP, path: 'live' })).toEqual({
      path: 'live',
      ponyKey: IP,
    })
    expect(ponyKeyForSession({ role: 'streamer', ip: IP, path: 'live' })).toBeNull()
  })
})

describe('reroll cooldown', () => {
  it('starts on the first claim and counts down', () => {
    useFakeClock()
    expect(guestRerollWaitMs('live', IP)).toBe(0)
    expect(claimGuestReroll('live', IP)).toBe(0)
    expect(guestRerollWaitMs('live', IP)).toBe(GUEST_REROLL_COOLDOWN_MS)

    vi.advanceTimersByTime(10_000)
    expect(claimGuestReroll('live', IP)).toBe(20_000)
    // A refused claim does not extend the cooldown.
    vi.advanceTimersByTime(20_000)
    expect(claimGuestReroll('live', IP)).toBe(0)
    expect(guestRerollWaitMs('live', IP)).toBe(30_000)
  })

  it('is 30 seconds', () => {
    expect(GUEST_REROLL_COOLDOWN_MS).toBe(30_000)
  })

  it('is tracked per path and per guest', () => {
    useFakeClock()
    claimGuestReroll('live', IP)
    expect(claimGuestReroll('other', IP)).toBe(0)
    expect(claimGuestReroll('live', '198.51.100.1')).toBe(0)
    expect(claimGuestReroll('live', IP)).toBeGreaterThan(0)
  })
})

describe('guest identities', () => {
  it('picks a pony name and an avatar, and asks the booru for a matching picture', async () => {
    const booru = useFakeDerpibooru()
    const identity = await guestIdentity('live', IP)

    expect(PONY_NAMES.map(([name]) => name)).toContain(identity.name)
    expect(identity.image).toMatch(/^https:\/\/cdn\.booru\.test\/img\/\d+\/thumb_small\.png$/)
    expect(identity).toMatchObject({ kept: false, favoriteTag: null })

    expect(booru.requests).toHaveLength(1)
    const url = booru.requests[0]
    const tag = PONY_NAMES.find(([name]) => name === identity.name)![1]
    expect(queryOf(url)).toBe(`"${tag}", solo, score.gte:50, -animated`)
    expect(url.searchParams.get('per_page')).toBe('20')
    expect(url.searchParams.get('sf')).toBe('random')
    expect(url.searchParams.has('filter_id')).toBe(false)
  })

  it('stays the same within one stream session, without asking the booru again', async () => {
    const booru = useFakeDerpibooru()
    createStreamSession('live')
    const first = await guestIdentity('live', IP)
    const again = await guestIdentity('live', IP)
    expect(again).toEqual(first)
    expect(cachedGuestIdentity('live', IP)).toEqual(first)
    expect(booru.requests).toHaveLength(1)
  })

  it('gives different guests their own identity rows', async () => {
    useFakeDerpibooru()
    await guestIdentity('live', IP)
    freeRequestSlot()
    await guestIdentity('live', '198.51.100.1')
    expect(getGuestIdentity('live', IP)?.seed).not.toBe(
      getGuestIdentity('live', '198.51.100.1')?.seed,
    )
  })

  it('gets a new pony in the next stream session', async () => {
    useFakeDerpibooru()
    createStreamSession('live')
    await guestIdentity('live', IP)
    const before = getGuestIdentity('live', IP)!

    createStreamSession('live')
    freeRequestSlot()
    await guestIdentity('live', IP)
    const after = getGuestIdentity('live', IP)!

    expect(after.seed).not.toBe(before.seed)
    expect(after.stream_session_id).not.toBe(before.stream_session_id)
  })

  it('keeps its pony while the stream is offline', async () => {
    useFakeDerpibooru()
    createStreamSession('live')
    await guestIdentity('live', IP)
    const before = getGuestIdentity('live', IP)!
    deleteStreamSession('live')
    await guestIdentity('live', IP)
    expect(getGuestIdentity('live', IP)?.seed).toBe(before.seed)
  })

  it('replaces an identity made while offline once a stream starts', async () => {
    useFakeDerpibooru()
    await guestIdentity('live', IP)
    const offline = getGuestIdentity('live', IP)!
    createStreamSession('live')
    freeRequestSlot()
    await guestIdentity('live', IP)
    expect(getGuestIdentity('live', IP)?.seed).not.toBe(offline.seed)
  })

  it('survives later stream sessions when kept, until released', async () => {
    useFakeDerpibooru()
    createStreamSession('live')
    await guestIdentity('live', IP)
    const seed = getGuestIdentity('live', IP)!.seed

    expect(setGuestKeep('live', IP, true).kept).toBe(true)
    createStreamSession('live')
    expect((await guestIdentity('live', IP)).kept).toBe(true)
    expect(getGuestIdentity('live', IP)?.seed).toBe(seed)

    // Releasing keeps the pony for the current stream only.
    expect(setGuestKeep('live', IP, false).kept).toBe(false)
    expect(getGuestIdentity('live', IP)?.seed).toBe(seed)
    createStreamSession('live')
    freeRequestSlot()
    await guestIdentity('live', IP)
    expect(getGuestIdentity('live', IP)?.seed).not.toBe(seed)
  })

  it('serves a cached identity at once and finishes picking the avatar in the background', async () => {
    const booru = useFakeDerpibooru()
    const first = cachedGuestIdentity('live', IP)
    expect(first.image).toBeNull()
    for (let i = 0; i < 100 && !cachedGuestIdentity('live', IP).image; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(cachedGuestIdentity('live', IP).image).toMatch(/^https:\/\//)
    expect(cachedGuestIdentity('live', IP).name).toBe(first.name)
    expect(booru.requests).toHaveLength(1)
  })

  it('ignores avatar URLs that are not https', async () => {
    useFakeDerpibooru({ urls: ['http://insecure.test/a.png', 'https://ok.test/b.png'] })
    const identity = await guestIdentity('live', IP)
    expect(identity.image).toBe('https://ok.test/b.png')
  })
})

describe('favorite tag and rerolls', () => {
  it('rerolls to a different picture, from a small fresh batch', async () => {
    const booru = useFakeDerpibooru()
    const first = await guestIdentity('live', IP)
    freeRequestSlot()
    const rerolled = await rerollGuestAvatar('live', IP)

    expect(rerolled.image).not.toBe(first.image)
    expect(rerolled.name).toBe(first.name)
    expect(rerolled.favoriteTagMatched).toBeNull()
    expect(booru.requests.at(-1)?.searchParams.get('per_page')).toBe('3')
    expect(getGuestIdentity('live', IP)?.avatar_url).toBe(rerolled.image)
  })

  it('adds the favorite tag to the query and remembers it', async () => {
    const booru = useFakeDerpibooru()
    await guestIdentity('live', IP)
    freeRequestSlot()
    const result = await setGuestFavoriteTag('live', IP, 'cute tag')

    expect(result.favoriteTag).toBe('cute tag')
    expect(result.favoriteTagMatched).toBe(true)
    expect(queryOf(booru.requests.at(-1)!)).toMatch(
      /^"[^"]+", "cute tag", solo, score\.gte:50, -animated$/,
    )
  })

  it('clears the favorite tag with null', async () => {
    useFakeDerpibooru()
    await guestIdentity('live', IP)
    freeRequestSlot()
    await setGuestFavoriteTag('live', IP, 'cute tag')
    freeRequestSlot()
    const cleared = await setGuestFavoriteTag('live', IP, null)
    expect(cleared.favoriteTag).toBeNull()
    expect(getGuestIdentity('live', IP)?.favorite_tag).toBeNull()
  })

  it('carries the favorite tag over to the next stream session', async () => {
    useFakeDerpibooru()
    createStreamSession('live')
    await guestIdentity('live', IP)
    freeRequestSlot()
    await setGuestFavoriteTag('live', IP, 'cute tag')
    const before = getGuestIdentity('live', IP)!

    createStreamSession('live')
    freeRequestSlot()
    const next = await guestIdentity('live', IP)
    const after = getGuestIdentity('live', IP)!
    expect(after.seed).not.toBe(before.seed)
    expect(after.favorite_tag).toBe('cute tag')
    expect(next.favoriteTag).toBe('cute tag')
  })
})

describe('booru settings read at import', () => {
  afterEach(() => vi.resetModules())

  async function load() {
    vi.resetModules()
    return import('@/lib/guestIdentity')
  }

  it('sends filter_id and extra tags (negated ones excluded) from the environment', async () => {
    vi.stubEnv('GUEST_AVATAR_FILTER_ID', ' 56027 ')
    vi.stubEnv('GUEST_AVATAR_TAGS', 'safe, -grimdark, "bad\\" tag"')
    const booru = useFakeDerpibooru()
    const mod = await load()
    await mod.guestIdentity('live', IP)

    const url = booru.requests[0]
    expect(url.searchParams.get('filter_id')).toBe('56027')
    expect(queryOf(url)).toMatch(
      /^"[^"]+", solo, "safe", -"grimdark", "bad tag", score\.gte:50, -animated$/,
    )
  })

  it('can point at another booru', async () => {
    vi.stubEnv('GUEST_AVATAR_BOORU_URL', 'https://booru.example/')
    const booru = useFakeDerpibooru({ base: 'https://booru.example' })
    const mod = await load()
    expect((await mod.guestIdentity('live', IP)).image).toMatch(/^https:/)
    expect(booru.requests).toHaveLength(1)
  })
})

describe('custom pony names file', () => {
  let dir: string | undefined

  afterEach(() => {
    vi.resetModules()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function load(file: string) {
    vi.resetModules()
    vi.stubEnv('GUEST_PONY_NAMES_FILE', file)
    return import('@/lib/guestIdentity')
  }

  function namesFile(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'mtxcord-ponies-'))
    const file = join(dir, 'names.txt')
    writeFileSync(file, content)
    return file
  }

  const builtIn = PONY_NAMES.map(([name]) => name)

  it('uses the listed names and tags; comments and blank lines are ignored', async () => {
    const file = namesFile(
      ['# my ponies', '', '   ', 'Alpha | Alpha "Tag" Two', '  Beta  ', '# Gamma', '| notag', ''].join('\r\n'),
    )
    const booru = useFakeDerpibooru()
    const mod = await load(file)

    const seen = new Map<string, string>()
    for (let i = 1; i <= 12; i++) {
      freeRequestSlot()
      const identity = await mod.guestIdentity('live', `198.51.100.${i}`)
      seen.set(identity.name, identity.name)
    }
    expect([...seen.keys()].every((n) => n === 'Alpha' || n === 'Beta')).toBe(true)

    const tags = new Set(booru.requests.map((u) => queryOf(u)!.split(', ')[0]))
    for (const tag of tags) expect(['"alpha tag two"', '"beta"']).toContain(tag)
    if (seen.has('Alpha')) expect(tags).toContain('"alpha tag two"')
    if (seen.has('Beta')) expect(tags).toContain('"beta"')
  })

  it('defaults the tag to the name', async () => {
    const file = namesFile('Only Pony\n')
    const booru = useFakeDerpibooru()
    const mod = await load(file)
    expect((await mod.guestIdentity('live', IP)).name).toBe('Only Pony')
    expect(queryOf(booru.requests[0])).toMatch(/^"only pony", solo/)
  })

  it('falls back to the built-in list for an unreadable file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeDerpibooru()
    const mod = await load(join(tmpdir(), 'mtxcord-does-not-exist', 'names.txt'))
    expect(builtIn).toContain((await mod.guestIdentity('live', IP)).name)
    expect(error).toHaveBeenCalled()
  })

  it('falls back to the built-in list for a file without names', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = namesFile('# nothing here\n\n   \n')
    useFakeDerpibooru()
    const mod = await load(file)
    expect(builtIn).toContain((await mod.guestIdentity('live', IP)).name)
    expect(error).toHaveBeenCalled()
  })
})
