import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(header?: string) {
  vi.resetModules()
  vi.stubEnv('CLIENT_IP_HEADER', header ?? '')
  return (await import('@/lib/net')).getClientIp
}

const req = (headers: Record<string, string>) => ({
  headers: new Headers(headers),
})

afterEach(() => vi.resetModules())

describe('getClientIp (default x-forwarded-for)', () => {
  it('uses the last entry, trimmed', async () => {
    const getClientIp = await load()
    expect(
      getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2 ,  3.3.3.3 ' })),
    ).toBe('3.3.3.3')
  })

  it('uses a single entry', async () => {
    const getClientIp = await load()
    expect(getClientIp(req({ 'x-forwarded-for': '9.9.9.9' }))).toBe('9.9.9.9')
  })

  it('is "unknown" with a trailing comma or no header', async () => {
    const getClientIp = await load()
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1,' }))).toBe('unknown')
    expect(getClientIp(req({}))).toBe('unknown')
  })
})

describe('getClientIp (custom header)', () => {
  it('uses the whole header value, ignoring x-forwarded-for', async () => {
    const getClientIp = await load('CF-Connecting-IP')
    expect(
      getClientIp(
        req({ 'cf-connecting-ip': ' 4.4.4.4 ', 'x-forwarded-for': '5.5.5.5' }),
      ),
    ).toBe('4.4.4.4')
  })

  it('does not split on commas', async () => {
    const getClientIp = await load('x-real-ip')
    expect(getClientIp(req({ 'x-real-ip': 'a, b' }))).toBe('a, b')
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1' }))).toBe('unknown')
  })
})
