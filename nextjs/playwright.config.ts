import { defineConfig, devices } from '@playwright/test'
import { APP_PORT, APP_URL, serverEnv } from './tests/e2e/env'

// E2E runs locally only (not in CI): a production build of the app, a fake
// MediaMTX (tests/e2e/fake-server.ts) and Chromium.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `next start` only warns about output: 'standalone' and works.
    // E2E_SKIP_BUILD=1 reuses the existing .next build when iterating on specs.
    command: `${process.env.E2E_SKIP_BUILD ? '' : 'npm run build && '}npx next start -H 127.0.0.1 -p ${APP_PORT}`,
    url: `${APP_URL}/login`,
    reuseExistingServer: false,
    timeout: 5 * 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    env: serverEnv(),
  },
})
