import { describe, expect, it } from 'vitest'
import { loginUrlFor, sameSitePath, streamPathOf } from '@/lib/loginUrl'

describe('sameSitePath', () => {
  it.each([null, ''])('falls back for %j', (input) => {
    expect(sameSitePath(input, '/home')).toBe('/home')
  })

  it.each([
    'https://evil.com',
    'https://evil.com/path',
    '//evil.com',
    '/\\evil.com',
    'javascript:alert(1)',
    'data:text/html,hi',
  ])('rejects %s', (input) => {
    expect(sameSitePath(input, '/home')).toBe('/home')
  })

  it('keeps path, query and hash of same-site paths', () => {
    expect(sameSitePath('/live/room?x=1&y=2#top', '/home')).toBe(
      '/live/room?x=1&y=2#top',
    )
    expect(sameSitePath('/', '/home')).toBe('/')
  })
})

describe('streamPathOf', () => {
  it('returns the first path segment', () => {
    expect(streamPathOf('/mystream')).toBe('mystream')
    expect(streamPathOf('/mystream/extra?x=1')).toBe('mystream')
  })

  it('returns null for root, non-strings and empty', () => {
    expect(streamPathOf('/')).toBeNull()
    expect(streamPathOf('')).toBeNull()
    expect(streamPathOf(undefined)).toBeNull()
    expect(streamPathOf(42)).toBeNull()
  })
})

describe('loginUrlFor', () => {
  it('encodes the callback url', () => {
    expect(loginUrlFor('room')).toBe('/login?callbackUrl=%2Froom')
  })
})
