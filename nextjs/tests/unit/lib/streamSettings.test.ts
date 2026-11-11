import { describe, expect, it } from 'vitest'
import { PATH_NAME_RE } from '@/lib/streamSettings'
import { isReaction, REACTIONS, REACTION_RATE_LIMIT } from '@/lib/watchRoomShared'

describe('PATH_NAME_RE', () => {
  it.each(['a', 'live', 'Stream01', 'a/b', 'x'.repeat(64)])('accepts %s', (p) => {
    expect(PATH_NAME_RE.test(p)).toBe(true)
  })

  it.each([
    '',
    'x'.repeat(65),
    'has space',
    'dash-ed',
    'under_score',
    'dot.dot',
    '../etc',
    'a\nb',
    'ünï',
    'a?b',
  ])('rejects %j', (p) => {
    expect(PATH_NAME_RE.test(p)).toBe(false)
  })
})

describe('isReaction', () => {
  it('accepts every listed reaction', () => {
    for (const r of REACTIONS) expect(isReaction(r)).toBe(true)
  })

  it('rejects other values', () => {
    expect(isReaction('🙃')).toBe(false)
    expect(isReaction('')).toBe(false)
    expect(isReaction(null)).toBe(false)
    expect(isReaction(5)).toBe(false)
    expect(isReaction(['❤️'])).toBe(false)
  })

  it('has a 6-per-3s rate limit', () => {
    expect(REACTION_RATE_LIMIT).toEqual({ max: 6, windowMs: 3000 })
  })
})
