import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTrustedIp,
  matchesNetworks,
  parseTrustedNetworks,
} from '@/lib/trustedNetworks'
import { trustNetworks } from '../../helpers/trust'

const matches = (list: string, ip: string) =>
  matchesNetworks(ip, parseTrustedNetworks(list))

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('parseTrustedNetworks', () => {
  it('returns nothing for unset and empty values', () => {
    expect(parseTrustedNetworks(undefined).count).toBe(0)
    expect(parseTrustedNetworks('').count).toBe(0)
    expect(parseTrustedNetworks(' , ,').count).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

  it('trims whitespace around entries', () => {
    expect(parseTrustedNetworks('  10.0.0.1 ,\t192.168.0.0/16\n').count).toBe(2)
  })

  it('skips invalid entries and logs each one', () => {
    const bad = [
      'nope',
      '10.0.0.256',
      '10.0.0',
      '10.0.0.1/33',
      '10.0.0.1/-1',
      '10.0.0.1/x',
      'fd00::/129',
      'fd00:::1',
      '1::2::3',
      '12345::1',
      '/8',
      '010.0.0.0/8',
      '10.00.0.1',
      '::ffff:010.0.0.1',
    ]
    const networks = parseTrustedNetworks(`${bad.join(',')},10.0.0.1`)
    expect(networks.count).toBe(1)
    expect(errors).toHaveBeenCalledTimes(bad.length)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"nope"'))
  })
})

describe('IPv6 entries', () => {
  it('accepts mapped-range networks wider than /96', () => {
    expect(parseTrustedNetworks('::ffff:0:0/80').count).toBe(1)
    expect(parseTrustedNetworks('::ffff:0:0/96, ::/0').count).toBe(2)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('IPv4', () => {
  it('rejects octets with leading zeros, on both the network and the client side', () => {
    const networks = parseTrustedNetworks('10.0.0.0/8')
    expect(matchesNetworks('10.0.0.1', networks)).toBe(true)
    expect(matchesNetworks('010.0.0.1', networks)).toBe(false)
    expect(matchesNetworks('10.0.0.01', networks)).toBe(false)
    expect(matchesNetworks('::ffff:010.0.0.1', networks)).toBe(false)
    expect(matches('0.0.0.0/0', '0.0.0.0')).toBe(true)
  })

  it('matches a single address exactly', () => {
    expect(matches('10.0.0.5', '10.0.0.5')).toBe(true)
    expect(matches('10.0.0.5', '10.0.0.6')).toBe(false)
    expect(matches('10.0.0.5', '10.0.0.50')).toBe(false)
  })

  it('matches a CIDR range including its network and broadcast address', () => {
    expect(matches('192.168.1.0/24', '192.168.1.0')).toBe(true)
    expect(matches('192.168.1.0/24', '192.168.1.255')).toBe(true)
    expect(matches('192.168.1.0/24', '192.168.1.77')).toBe(true)
    expect(matches('192.168.1.0/24', '192.168.0.255')).toBe(false)
    expect(matches('192.168.1.0/24', '192.168.2.0')).toBe(false)
  })

  it('masks host bits in the configured address', () => {
    expect(matches('192.168.1.77/24', '192.168.1.1')).toBe(true)
  })

  it('handles /0 (everything) and /32 (one address)', () => {
    expect(matches('0.0.0.0/0', '203.0.113.9')).toBe(true)
    expect(matches('0.0.0.0/0', '::1')).toBe(false)
    expect(matches('10.0.0.5/32', '10.0.0.5')).toBe(true)
    expect(matches('10.0.0.5/32', '10.0.0.4')).toBe(false)
  })

  it('handles non-octet-aligned prefixes', () => {
    expect(matches('172.16.0.0/12', '172.31.255.255')).toBe(true)
    expect(matches('172.16.0.0/12', '172.32.0.0')).toBe(false)
  })

  it('matches any entry of a list', () => {
    const list = '192.168.1.0/24, 10.0.0.5, fd00::/8'
    expect(matches(list, '10.0.0.5')).toBe(true)
    expect(matches(list, '192.168.1.9')).toBe(true)
    expect(matches(list, '8.8.8.8')).toBe(false)
  })
})

describe('IPv6', () => {
  it('matches a single address in any notation', () => {
    expect(matches('2001:db8::1', '2001:db8::1')).toBe(true)
    expect(matches('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true)
    expect(matches('2001:DB8::1', '2001:db8::1')).toBe(true)
    expect(matches('2001:db8::1', '2001:db8::2')).toBe(false)
  })

  it('matches a CIDR range', () => {
    expect(matches('fd00::/8', 'fd12:3456::1')).toBe(true)
    expect(matches('fd00::/8', 'fe80::1')).toBe(false)
    expect(matches('2001:db8::/32', '2001:db8:ffff::1')).toBe(true)
    expect(matches('2001:db8::/32', '2001:db9::1')).toBe(false)
  })

  it('handles /0 and /128', () => {
    expect(matches('::/0', 'fe80::1')).toBe(true)
    expect(matches('::/0', '10.0.0.1')).toBe(false)
    expect(matches('::1/128', '::1')).toBe(true)
    expect(matches('::1/128', '::2')).toBe(false)
  })

  it('ignores a zone id', () => {
    expect(matches('fe80::/10', 'fe80::1%eth0')).toBe(true)
  })

  it('never matches across families', () => {
    expect(matches('10.0.0.0/8', 'fd00::1')).toBe(false)
  })
})

describe('IPv4-mapped IPv6', () => {
  it('treats a mapped client address as its IPv4 address', () => {
    expect(matches('192.168.1.0/24', '::ffff:192.168.1.5')).toBe(true)
    expect(matches('192.168.1.0/24', '::ffff:c0a8:0105')).toBe(true)
    expect(matches('192.168.1.0/24', '::ffff:192.168.2.5')).toBe(false)
  })

  it('treats a mapped network entry as its IPv4 network', () => {
    expect(matches('::ffff:10.0.0.5', '10.0.0.5')).toBe(true)
    expect(matches('::ffff:10.0.0.0/104', '10.200.0.1')).toBe(true)
    expect(matches('::ffff:10.0.0.0/104', '11.0.0.1')).toBe(false)
  })

  it('lets a mapped client match an IPv6 network that covers it', () => {
    expect(matches('::/0', '::ffff:192.168.1.5')).toBe(true)
    expect(matches('::ffff:0:0/80', '::ffff:192.168.1.5')).toBe(true)
    expect(matches('::ffff:0:0/96', '::ffff:192.168.1.5')).toBe(true)
    expect(matches('::ffff:0:0/96', '192.168.1.5')).toBe(true)
  })

  it('does not let a plain IPv4 client match a catch-all IPv6 network', () => {
    expect(matches('::/0', '192.168.1.5')).toBe(false)
    expect(matches('::ffff:0:0/80', '192.168.1.5')).toBe(false)
  })

  it('does not let a mapped address match an unrelated IPv6 network', () => {
    expect(matches('fd00::/8', '::ffff:192.168.1.5')).toBe(false)
  })
})

describe('isTrustedIp', () => {
  it('reads TRUSTED_NETWORKS from the environment', () => {
    trustNetworks('10.0.0.0/8, fd00::/8')
    expect(isTrustedIp('10.1.2.3')).toBe(true)
    expect(isTrustedIp('fd00::5')).toBe(true)
    expect(isTrustedIp('11.1.2.3')).toBe(false)
  })

  it('picks up a changed value', () => {
    trustNetworks('10.0.0.0/8')
    expect(isTrustedIp('10.1.2.3')).toBe(true)
    trustNetworks('192.168.0.0/16')
    expect(isTrustedIp('10.1.2.3')).toBe(false)
    expect(isTrustedIp('192.168.0.1')).toBe(true)
  })

  it('trusts nobody when unset or empty', () => {
    expect(isTrustedIp('10.1.2.3')).toBe(false)
    vi.stubEnv('TRUSTED_NETWORKS', '')
    expect(isTrustedIp('10.1.2.3')).toBe(false)
  })

  it('never trusts "unknown" or garbage, even with a catch-all network', () => {
    trustNetworks('0.0.0.0/0, ::/0')
    expect(isTrustedIp('unknown')).toBe(false)
    expect(isTrustedIp('')).toBe(false)
    expect(isTrustedIp('not-an-ip')).toBe(false)
    expect(isTrustedIp('10.0.0.1')).toBe(true)
  })

  it('logs an invalid entry once per distinct value, not per call', () => {
    trustNetworks('oops,10.0.0.1')
    isTrustedIp('10.0.0.1')
    isTrustedIp('10.0.0.2')
    expect(errors).toHaveBeenCalledTimes(1)
  })
})

describe('CLIENT_IP_HEADER guard', () => {
  // The "logged once" flag is module state, so each test gets a fresh module.
  async function load() {
    vi.resetModules()
    return (await import('@/lib/trustedNetworks')).isTrustedIp
  }

  it('trusts nobody without an explicit CLIENT_IP_HEADER, and logs why once', async () => {
    const isTrusted = await load()
    vi.stubEnv('TRUSTED_NETWORKS', '10.0.0.0/8')
    vi.stubEnv('CLIENT_IP_HEADER', '')
    expect(isTrusted('10.1.2.3')).toBe(false)
    expect(isTrusted('10.1.2.4')).toBe(false)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('CLIENT_IP_HEADER'))
  })

  it('works once CLIENT_IP_HEADER is set, without logging', async () => {
    const isTrusted = await load()
    vi.stubEnv('TRUSTED_NETWORKS', '10.0.0.0/8')
    vi.stubEnv('CLIENT_IP_HEADER', 'cf-connecting-ip')
    expect(isTrusted('10.1.2.3')).toBe(true)
    expect(isTrusted('11.1.2.3')).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it('stays quiet when TRUSTED_NETWORKS is not configured at all', async () => {
    const isTrusted = await load()
    vi.stubEnv('TRUSTED_NETWORKS', '')
    vi.stubEnv('CLIENT_IP_HEADER', '')
    expect(isTrusted('10.1.2.3')).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })
})
