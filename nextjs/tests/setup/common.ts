// Loaded by every Vitest project. See tests/helpers/ for what tests can use.
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { server } from '../helpers/msw'
import { resetServerState } from '../helpers/state'
import { flushNotifications } from '../helpers/clock'

// MSW intercepts every fetch; anything a test didn't declare is an error, so
// nothing can reach the real network.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(async () => {
  // Let the previous test's deferred notifyChanged() flush (setImmediate) run
  // first, so it can't fire into this test's listeners after the reset.
  await flushNotifications()
  resetServerState()
})
afterEach(() => {
  vi.useRealTimers()
})
