// Loaded by every Vitest project. See tests/helpers/ for what tests can use.
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { server, takeUnhandledRequests } from '../helpers/msw'
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
  // Forget requests that slipped in between tests, so they can't be blamed on
  // this one.
  takeUnhandledRequests()
})
// A request with no handler fails the test (declare the fake from
// tests/helpers/msw.ts, or call allowUnhandledRequests() if it is on purpose).
// Runs before the handlers are reset and after a flush, so work the test left
// running is still attributed to it.
afterEach(async () => {
  await flushNotifications()
  const seen = takeUnhandledRequests()
  if (seen.length > 0) {
    throw new Error(
      [
        `${seen.length} request(s) hit no MSW handler:`,
        ...seen.map((r) => `  ${r}`),
        'Install the matching fake from tests/helpers/msw.ts',
        '(useFakeMediamtx / useFakeDerpibooru / useFakeDiscordWebhook),',
        'or call allowUnhandledRequests() if this is intended.',
      ].join('\n'),
    )
  }
})
afterEach(() => {
  vi.useRealTimers()
})
