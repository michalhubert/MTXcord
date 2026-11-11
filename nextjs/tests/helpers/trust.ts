// Tests that need trusted IPs set TRUSTED_NETWORKS through this (the test config leaves it empty).
import { vi } from 'vitest'

export function trustNetworks(networks: string): void {
  vi.stubEnv('TRUSTED_NETWORKS', networks)
}
