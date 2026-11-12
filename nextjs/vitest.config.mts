import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

// Shared test environment. Every variable the app reads is pinned here (empty
// = unset), so a developer's shell can't leak into the tests.
const env = {
  MTXCORD_DB_PATH: ':memory:',
  NEXTAUTH_SECRET: 'test-nextauth-secret-0123456789abcdef0123456789abcdef',
  HOOK_SECRET: 'test-hook-secret',
  STREAMER_PASSWORD: 'test-streamer-password',
  MEDIAMTX_HOST: 'mediamtx.test',
  MEDIAMTX_PORT: '8889',
  MEDIAMTX_API_PORT: '9997',
  DISCORD_WEBHOOK_URL: '',
  DISCORD_WEBHOOK_URLS: '',
  PLAYER_DOMAIN: '',
  DISABLE_DOCK_AUTH: '',
  DISCORD_CLIENT_ID: '',
  DISCORD_CLIENT_SECRET: '',
  GUEST_PONY_NAMES_FILE: '',
  GUEST_AVATAR_TAGS: '',
  GUEST_AVATAR_FILTER_ID: '',
  GUEST_AVATAR_BOORU_URL: '',
  CLIENT_IP_HEADER: '',
  TRUSTED_NETWORKS: '',
}

export default defineConfig({
  resolve: {
    alias: { '@': root.replace(/[\/]$/, '') },
  },
  test: {
    env,
    unstubEnvs: true,
    unstubGlobals: true,
    restoreMocks: true,
    // next-auth imports extensionless 'next/server', which Node's ESM loader
    // rejects; inlining makes Vite resolve it.
    server: { deps: { inline: ['next-auth', '@auth/core'] } },
    // The default pool (forks) is right for the better-sqlite3 native addon.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/common.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/common.ts', 'tests/setup/integration.ts'],
        },
      },
    ],
  },
})
