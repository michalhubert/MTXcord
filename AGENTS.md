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

## Run the test suite after every code change

Whenever you add or change code, including tests, config and dependencies, run these in `nextjs/` before you report the work as done or commit it:

```bash
npm test            # unit + integration
npx tsc --noEmit    # also type-checks tests/
npm run lint
```

* Also run `npm run test:e2e` when the change touches a critical path (listed under E2E above). It builds the app first and uses ports 3100 and 18889.
* If something fails, fix it and run the suite again. Don't hand over red tests, and don't skip or weaken a test to get green.
* Report what you ran and the result. If you couldn't run something (no `node_modules`, a port in use, no browser installed), say so plainly instead of implying it passed.
* Docs-only changes don't need the suite.

CI runs only the type check and the unit and integration tests, and the `mtxcord-web` image is built only when they pass. E2E is local-only, so running it is on you.

Test conventions:

* Reuse the shared harness instead of hand-rolling mocks. `tests/helpers/` has sessions, requests, SSE, clock and MSW fakes for MediaMTX, Discord and Derpibooru. The stateful MediaMTX fake is `tests/fakes/mediamtx.ts`.
* Tests never reach the real network and never write outside temp directories. A request no MSW handler matched fails the test (call `allowUnhandledRequests()` from `tests/helpers/msw.ts` if that is intended). Integration tests get a default Derpibooru fake, since guest avatar lookups are incidental; install your own `useFakeDerpibooru()` to assert on it. The database is `:memory:` via `MTXCORD_DB_PATH`.
* For fake time use `useFakeClock()`. It never fakes `setImmediate`, which the change hub (`lib/events.ts`) relies on.
* Close or abort every SSE stream a test opens.
