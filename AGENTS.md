# MTXcord agent instructions

## Every change comes with tests

Every change must include tests or test changes:

* New behaviour gets new tests, and changed behaviour gets its tests updated.
* A bug fix gets a regression test that fails without the fix.
* A change with no test changes needs a stated reason, e.g. docs-only or CI-only.

Never make a test pass by asserting buggy behaviour: fix the bug, or leave that case out and flag it.

The web app's tests live in `nextjs/tests/` (see [nextjs/README.md](nextjs/README.md#tests)):

* **Unit** (`tests/unit/`): `lib/` modules and pure client helpers.
* **Integration** (`tests/integration/`): the API route handlers, against an in-memory SQLite database, with MediaMTX, Discord and Derpibooru faked through MSW.
* **E2E** (`tests/e2e/`): Playwright on Chromium against a production build and a fake MediaMTX. Keep these to the critical user paths: logins, approving and denying viewers, kicks, password rotation, the stream going online and offline, and access guards.

Before finishing a change, run these in `nextjs/`: `npm test`, `npx tsc --noEmit` and `npm run lint`. Also run `npm run test:e2e` when the change touches a critical path. CI runs only the type check and the unit and integration tests, and the `mtxcord-web` image is built only when they pass. E2E is local-only.

Test conventions:

* Reuse the shared harness instead of hand-rolling mocks. `tests/helpers/` has sessions, requests, SSE, clock and MSW fakes for MediaMTX, Discord and Derpibooru. The stateful MediaMTX fake is `tests/fakes/mediamtx.ts`.
* Tests never reach the real network (MSW errors on unhandled requests) and never write outside temp directories. The database is `:memory:` via `MTXCORD_DB_PATH`.
* For fake time use `useFakeClock()`. It never fakes `setImmediate`, which the change hub (`lib/events.ts`) relies on.
* Close or abort every SSE stream a test opens.
