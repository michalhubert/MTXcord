// Networks (TRUSTED_NETWORKS) whose clients may join without the viewer password.
// Uses node:net, so it must stay out of the Edge runtime (proxy.ts, lib/auth.config.ts).
import { BlockList, isIP } from 'node:net'
import { clientIpHeaderConfigured } from './net'

export type TrustedNetworks = {
  v4: BlockList
  v6: BlockList
  // The IPv4-mapped entries (inside ::ffff:0:0/96), so that a plain IPv4 client matches
  // them. They are in v6 too. BlockList would otherwise match a plain IPv4 client against
  // every IPv6 entry (::/0), which is not what "::/0" should mean.
  mapped: BlockList
  count: number
}

const MAPPED_RANGE = new BlockList()
MAPPED_RANGE.addSubnet('::ffff:0:0', 96, 'ipv6')

// An IPv6 zone id (fe80::1%eth0) is not part of the address.
function stripZone(text: string): string {
  const zone = text.indexOf('%')
  return zone === -1 ? text : text.slice(0, zone)
}

// net.isIP rejects IPv4 octets with leading zeros (010.0.0.1), which some parsers read as octal.
function familyOf(text: string): 'ipv4' | 'ipv6' | null {
  const family = isIP(text)
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null
}

function addEntry(networks: TrustedNetworks, entry: string): boolean {
  const slash = entry.indexOf('/')
  const address = stripZone(slash === -1 ? entry : entry.slice(0, slash))
  const prefixText = slash === -1 ? null : entry.slice(slash + 1)
  const family = familyOf(address)
  if (!family) return false
  const list = family === 'ipv4' ? networks.v4 : networks.v6
  const inMappedRange = family === 'ipv6' && MAPPED_RANGE.check(address, 'ipv6')

  if (prefixText === null) {
    list.addAddress(address, family)
    if (inMappedRange) networks.mapped.addAddress(address, 'ipv6')
    return true
  }
  if (!/^\d{1,3}$/.test(prefixText)) return false
  const prefix = Number(prefixText)
  try {
    list.addSubnet(address, prefix, family)
  } catch {
    return false // prefix out of range for the family
  }
  // From /96 up an entry inside ::ffff:0:0/96 is an IPv4 network in disguise.
  if (inMappedRange && prefix >= 96) networks.mapped.addSubnet(address, prefix, 'ipv6')
  return true
}

/** Parses a comma-separated list of IPs and CIDRs, logging and skipping invalid entries. */
export function parseTrustedNetworks(value: string | undefined): TrustedNetworks {
  const networks: TrustedNetworks = {
    v4: new BlockList(),
    v6: new BlockList(),
    mapped: new BlockList(),
    count: 0,
  }
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    if (addEntry(networks, entry)) networks.count++
    else console.error(`TRUSTED_NETWORKS: ignoring invalid entry "${entry}"`)
  }
  return networks
}

export function matchesNetworks(ip: string, networks: TrustedNetworks): boolean {
  const text = stripZone(ip.trim())
  const family = familyOf(text)
  if (family === 'ipv4') {
    // A plain IPv4 client: IPv4 rules, plus mapped rules written as ::ffff:a.b.c.d/n.
    return networks.v4.check(text, 'ipv4') || networks.mapped.check(`::ffff:${text}`, 'ipv6')
  }
  if (family === 'ipv6') {
    // BlockList also matches a mapped client (::ffff:a.b.c.d) against the IPv4 rules.
    return networks.v6.check(text, 'ipv6') || networks.v4.check(text, 'ipv6')
  }
  return false
}

// Keyed by the raw env string, so a changed value is re-parsed (and tests can stub it).
let cache: { raw: string; networks: TrustedNetworks } | null = null

function configuredNetworks(): TrustedNetworks {
  const raw = process.env.TRUSTED_NETWORKS ?? ''
  if (cache?.raw !== raw) cache = { raw, networks: parseTrustedNetworks(raw) }
  return cache.networks
}

let warnedNoHeader = false

// TRUSTED_NETWORKS only means something when the IP comes from a header the reverse proxy
// controls. Without an explicit CLIENT_IP_HEADER the app falls back to x-forwarded-for,
// which a client can fake when no proxy is in front, so nobody is trusted then.
function clientIpHeaderIsConfigured(): boolean {
  if (clientIpHeaderConfigured()) return true
  if (!warnedNoHeader) {
    warnedNoHeader = true
    console.error(
      'TRUSTED_NETWORKS is ignored until CLIENT_IP_HEADER is set explicitly: ' +
        'x-forwarded-for behind a single trusted proxy, or the header your proxy overwrites ' +
        '(e.g. cf-connecting-ip). Otherwise clients could fake a trusted IP.',
    )
  }
  return false
}

export function isTrustedIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return false
  const networks = configuredNetworks()
  if (networks.count === 0 || !clientIpHeaderIsConfigured()) return false
  return matchesNetworks(ip, networks)
}
