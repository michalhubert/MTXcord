import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Constants shared by playwright.config.ts, the fake server and the specs.

export const APP_PORT = 3100
export const FAKE_PORT = 18889

// 127.0.0.1 rather than localhost: no IPv4/IPv6 ambiguity on Node 26.
export const APP_URL = `http://127.0.0.1:${APP_PORT}`
export const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`

export const STREAMER_PASSWORD = 'e2e-streamer-password'
export const HOOK_SECRET = 'e2e-hook-secret'
export const NEXTAUTH_SECRET =
  'e2e-nextauth-secret-0123456789abcdef0123456789abcdef0123456789abcdef'

/** Clients in this range join without the viewer password (see trustedIp() in fixtures.ts). */
export const TRUSTED_NETWORK = '10.250.0.0/16'

/** Header the app reads the client IP from (CLIENT_IP_HEADER on the server). */
export const CLIENT_IP_HEADER = 'x-test-client-ip'

/**
 * One DB file per run. Computed once in the main process and exported through
 * the environment, so Playwright workers re-evaluating the config get the same
 * value.
 */
process.env.MTXCORD_E2E_DB ??= join(
  tmpdir(),
  `mtxcord-e2e-${Date.now()}-${process.pid}.db`,
)
export const DB_PATH = process.env.MTXCORD_E2E_DB

/** Environment for the Next.js server under test. */
export function serverEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    MEDIAMTX_HOST: '127.0.0.1',
    MEDIAMTX_PORT: String(FAKE_PORT),
    MEDIAMTX_API_PORT: String(FAKE_PORT),
    STREAMER_PASSWORD,
    NEXTAUTH_SECRET,
    HOOK_SECRET,
    NEXTAUTH_URL: APP_URL,
    AUTH_TRUST_HOST: 'true',
    MTXCORD_DB_PATH: DB_PATH,
    GUEST_AVATAR_BOORU_URL: `${FAKE_URL}/booru`,
    CLIENT_IP_HEADER,
    TRUSTED_NETWORKS: TRUSTED_NETWORK,
    DENIAL_TIMEOUTS: '1',
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    DISCORD_WEBHOOK_URL: '',
    DISCORD_WEBHOOK_URLS: '',
    NEXT_PUBLIC_DISCORD_ENABLED: '',
    PLAYER_DOMAIN: '',
    DISABLE_DOCK_AUTH: 'false',
    GUEST_PONY_NAMES_FILE: '',
    GUEST_AVATAR_TAGS: '',
    GUEST_AVATAR_FILTER_ID: '',
    PORT: String(APP_PORT),
    HOSTNAME: '127.0.0.1',
  }
}
