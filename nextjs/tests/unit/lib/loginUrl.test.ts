import { describe, expect, it } from 'vitest'
import { loginUrlFor, sameSitePath, streamPathOf, withManualLogin } from '@/lib/loginUrl'

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

describe('withManualLogin', () => {
  it('adds manual=1 and keeps the callbackUrl', () => {
    expect(withManualLogin('/login?callbackUrl=%2Flive')).toBe('/login?callbackUrl=%2Flive&manual=1')
  })

  it('works without a query and replaces an existing manual', () => {
    expect(withManualLogin('/login')).toBe('/login?manual=1')
    expect(withManualLogin('/login?manual=0&callbackUrl=%2Flive')).toBe(
      '/login?manual=1&callbackUrl=%2Flive',
    )
  })

  it('never leaves the site', () => {
    expect(withManualLogin('https://evil.com/login?x=1')).toBe('/login?x=1&manual=1')
  })
})
