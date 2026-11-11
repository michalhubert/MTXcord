import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockedViewerOf,
  clearBlock,
  clearDenials,
  denyViewer,
  getBlock,
  kickViewer,
} from '@/lib/accessBlocks'
import { getAccessBlock } from '@/lib/db'
import { useFakeClock } from '../../helpers/clock'

const MIN = 60_000
const guest = { role: 'viewer', ip: '1.1.1.1' }
const discord = { role: 'discord', ip: '1.1.1.1', discordId: '42' }

beforeEach(() => useFakeClock())

describe('subjects', () => {
  it('keys guests by role@ip and Discord viewers by account', () => {
    kickViewer('p', guest)
    kickViewer('p', discord)
    expect(getAccessBlock('p', 'viewer@1.1.1.1')).not.toBeNull()
    expect(getAccessBlock('p', 'discord:42')).not.toBeNull()
  })

  it('treats a missing role as guest', () => {
    kickViewer('p', { ip: '2.2.2.2' })
    expect(getAccessBlock('p', 'guest@2.2.2.2')).not.toBeNull()
  })

  it('ignores viewers it cannot identify', () => {
    kickViewer('p', { role: 'discord', ip: '1.1.1.1', discordId: null })
    kickViewer('p', { role: 'viewer' })
    expect(getBlock('p', { role: 'discord', discordId: null })).toBeNull()
    expect(getAccessBlock('p', 'discord:null')).toBeNull()
  })

  it('does not share blocks between a guest and a Discord viewer on one IP', () => {
    kickViewer('p', guest)
    expect(getBlock('p', discord)).toBeNull()
    expect(getBlock('p', guest)).not.toBeNull()
  })

  it('does not share blocks between paths or IPs', () => {
    kickViewer('p', guest)
    expect(getBlock('other', guest)).toBeNull()
    expect(getBlock('p', { ...guest, ip: '9.9.9.9' })).toBeNull()
  })

  it('blockedViewerOf only sets discordId for Discord users', () => {
    expect(blockedViewerOf({ role: 'discord', id: '7' }, '3.3.3.3')).toEqual({
      role: 'discord',
      ip: '3.3.3.3',
      discordId: '7',
    })
    expect(blockedViewerOf({ role: 'viewer', id: 'viewer' }, '3.3.3.3')).toEqual({
      role: 'viewer',
      ip: '3.3.3.3',
      discordId: null,
    })
  })
})

describe('default ladder (1, 5, 15 minutes)', () => {
  it('escalates and repeats the last step', () => {
    const now = Date.now()
    kickViewer('p', guest)
    expect(getBlock('p', guest)).toEqual({ reason: 'kicked', blockedUntil: now + 1 * MIN })

    vi.advanceTimersByTime(1 * MIN + 1)
    expect(getBlock('p', guest)).toBeNull()

    for (const [minutes, count] of [
      [5, 2],
      [15, 3],
      [15, 3],
    ] as const) {
      const at = Date.now()
      kickViewer('p', guest)
      expect(getBlock('p', guest)?.blockedUntil).toBe(at + minutes * MIN)
      expect(getAccessBlock('p', 'viewer@1.1.1.1')?.denial_count).toBe(count)
      vi.advanceTimersByTime(minutes * MIN + 1)
    }
  })

  it('kicks and denials share one ladder', () => {
    const t0 = Date.now()
    kickViewer('p', guest)
    vi.advanceTimersByTime(2 * MIN)
    denyViewer('p', guest)
    expect(getBlock('p', guest)).toEqual({
      reason: 'denied',
      blockedUntil: t0 + 2 * MIN + 5 * MIN,
    })
  })

  it('forgets after the block ended more than an hour ago', () => {
    kickViewer('p', guest) // ends after 1 minute
    vi.advanceTimersByTime(1 * MIN + 60 * MIN - 1000)
    kickViewer('p', guest)
    expect(getAccessBlock('p', 'viewer@1.1.1.1')?.denial_count).toBe(2)

    vi.advanceTimersByTime(5 * MIN + 60 * MIN + 1000)
    kickViewer('p', guest)
    expect(getAccessBlock('p', 'viewer@1.1.1.1')?.denial_count).toBe(1)
  })

  it('reports remaining state through getBlock until it expires', () => {
    kickViewer('p', guest)
    vi.advanceTimersByTime(MIN - 1)
    expect(getBlock('p', guest)).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(getBlock('p', guest)).toBeNull()
  })
})

describe('clearing', () => {
  it('clearBlock removes one viewer and resets their ladder', () => {
    kickViewer('p', guest)
    kickViewer('p', discord)
    clearBlock('p', guest)
    expect(getBlock('p', guest)).toBeNull()
    expect(getBlock('p', discord)).not.toBeNull()
    kickViewer('p', guest)
    expect(getAccessBlock('p', 'viewer@1.1.1.1')?.denial_count).toBe(1)
  })

  it('clearBlock ignores unidentifiable viewers', () => {
    expect(() => clearBlock('p', { role: 'discord', discordId: null })).not.toThrow()
  })

  it('clearDenials removes denials of the path only, keeping kicks', () => {
    denyViewer('p', guest)
    kickViewer('p', discord)
    denyViewer('other', guest)
    clearDenials('p')
    expect(getBlock('p', guest)).toBeNull()
    expect(getBlock('p', discord)?.reason).toBe('kicked')
    expect(getBlock('other', guest)?.reason).toBe('denied')
  })
})

describe('DENIAL_TIMEOUTS parsing', () => {
  afterEach(() => vi.resetModules())

  async function load(value: string) {
    vi.resetModules()
    vi.stubEnv('DENIAL_TIMEOUTS', value)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await import('@/lib/accessBlocks')
    return { ...mod, warn }
  }

  // Duration (ms) of the n-th consecutive block.
  function ladder(mod: Awaited<ReturnType<typeof load>>, n: number): number[] {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const at = Date.now()
      mod.kickViewer('p', guest)
      // Read through the module's own DB handle via a fresh block lookup.
      const until = mod.getBlock('p', guest)?.blockedUntil ?? at
      out.push(until - at)
      vi.advanceTimersByTime(Math.max(until - at, 0) + 1)
    }
    return out
  }

  it('uses the configured minutes', async () => {
    const mod = await load('2, 10')
    expect(ladder(mod, 3)).toEqual([2 * MIN, 10 * MIN, 10 * MIN])
    expect(mod.warn).not.toHaveBeenCalled()
  })

  it.each(['abc', '1,,5', '1,x'])('falls back to defaults for %j', async (value) => {
    const mod = await load(value)
    expect(ladder(mod, 3)).toEqual([1 * MIN, 5 * MIN, 15 * MIN])
    expect(mod.warn).toHaveBeenCalled()
  })

  it('uses defaults when empty', async () => {
    const mod = await load('')
    expect(ladder(mod, 2)).toEqual([1 * MIN, 5 * MIN])
  })

  it('treats 0 as a zero-length block (never actively blocked)', async () => {
    const mod = await load('0')
    mod.kickViewer('p', guest)
    expect(mod.getBlock('p', guest)).toBeNull()
  })
})
