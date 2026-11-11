import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DB_PATH } from './env'
import { startFakeServer } from './fake-server'

// The server still holds its DB open at teardown (and on Windows can't be
// deleted then), so the files of earlier runs are cleaned up at the next start.
function removeOldDatabases() {
  const current = basename(DB_PATH)
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('mtxcord-e2e-') || name.startsWith(current)) continue
    try {
      rmSync(join(tmpdir(), name), { force: true })
    } catch {
      // Still in use by something; the next run tries again.
    }
  }
}

// Starts the fake MediaMTX before any test runs; the returned function is
// Playwright's global teardown.
export default async function globalSetup() {
  removeOldDatabases()
  const { stop } = await startFakeServer()
  return async () => {
    await stop()
  }
}
