// TRUSTED_NETWORKS only takes effect with an explicit CLIENT_IP_HEADER (lib/trustedNetworks.ts).
// The test config leaves it empty, so tests that need trusted IPs set both through this.
import { vi } from 'vitest'

export function trustNetworks(networks: string): void {
  vi.stubEnv('CLIENT_IP_HEADER', 'x-forwarded-for')
  vi.stubEnv('TRUSTED_NETWORKS', networks)
}
