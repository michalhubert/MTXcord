# MTXcord review checklist

Paths are relative to the repo root. The web app is `nextjs/` and the media server config is `mediamtx/`. Each item says why it matters, so you can judge cases the list doesn't spell out.

## Contents
1. Tests
2. Security and access control
3. State, data and I/O
4. Conventions and docs

---

## 1. Tests

The rule (AGENTS.md): every change includes tests or test changes, and a bug fix includes a regression test that fails without the fix. A change with no test changes needs a stated reason (docs-only, CI-only, a pure rename). Without one, missing tests for a behaviour change are **Blocking**.

- **The right layer:**
  - `nextjs/tests/unit/` covers `lib/` modules and pure client helpers.
  - `nextjs/tests/integration/` covers API route handlers, called directly with a `NextRequest`.
  - `nextjs/tests/e2e/` (Playwright) covers only critical user paths: logins, approve/deny, kicks, password rotation, the stream going online/offline, and access guards.

  A new route needs integration tests. A new critical flow also needs an e2e test. UI polish doesn't.
- **Changed behaviour means changed tests.** If code changed but its tests still pass untouched, either the tests don't cover the change or they assert the old behaviour loosely. Check which.
- **Never assert buggy behaviour to make a test pass.** A test that encodes a known bug locks it in.
- **Use the shared harness, not hand-rolled mocks:**
  - `tests/helpers/session.ts`: `asStreamer`, `asGuest`, `asDiscord`, `signedOut`.
  - `tests/helpers/request.ts`: `nextRequest`, `routeParams`.
  - `tests/helpers/sse.ts`: `openSse`, `readSseEvents`.
  - `tests/helpers/clock.ts`: `useFakeClock`, `flushNotifications`.
  - `tests/helpers/msw.ts`: `useFakeMediamtx`, `useFakeDiscordWebhook`, `useFakeDerpibooru`.
  - `tests/fakes/mediamtx.ts`: the stateful MediaMTX fake.
- **No real network.** MSW runs with `onUnhandledFrame: 'error'`. A new outbound host needs a fake handler. Never weaken that setting.
- **No writes outside temp dirs.** The DB is `:memory:` through `MTXCORD_DB_PATH`. File-based tests use `os.tmpdir()` and clean up afterwards.
- **Fake time only via `useFakeClock()`.** Plain `vi.useFakeTimers()` also fakes `setImmediate`, which wedges the change hub in `lib/events.ts`.
- **SSE streams a test opens must be closed or aborted.** Otherwise the route's intervals keep running into later tests.
- **New `globalThis` registry:** it must be reset in `tests/helpers/state.ts` `resetServerState()`. Otherwise state leaks between tests.
- **Import-time env vars:** `CLIENT_IP_HEADER`, `DENIAL_TIMEOUTS`, `GUEST_*` and the Discord provider vars are read when their module loads. Tests of a different value need `vi.stubEnv` + `vi.resetModules()` + dynamic `import()`.
- **E2E isolation:** use a unique path and unique client IPs per test, sent through the `x-test-client-ip` header. Reset the fake first. The server's DB and in-memory state persist for the whole run, and the login throttle is per IP.
- **`next build` type-checks `tests/`**, so a type error in a test breaks local builds and the CI type check.

## 2. Security and access control

The app gates everything in front of MediaMTX, so these invariants are what keep viewers out of the dock and away from streams they aren't allowed to watch. A violation is **Blocking**.

- **Streamer-only routes and pages:**
  - Must be covered by `DOCK_PREFIXES` in `nextjs/proxy.ts`, which redirects anonymous users and non-streamers to the streamer login.
  - Must also call `isStreamerAuthorized()` from `lib/authz.ts` in the handler, as defence in depth. It honours `DISABLE_DOCK_AUTH` only when the value is exactly `"true"`.
  - Remember that `/api/stream` is a dock prefix but `/api/streams` isn't, which is why `/api/streams/visibility` and `/api/streams/pending` are listed separately. A new `/api/streams/*` streamer route must be added to the list explicitly.
- **Viewer routes** (watch, WHEP, reactions, guest actions):
  - Must go through `authorizeWatch` or `authorizeGuest` from `lib/watchAccess.ts`, or call `viewerAccess`/`watchAccessDenied` directly.
  - Never re-implement the decision. Its order matters: a stale viewer password gives `unauthorized`; a streamer is always `ok`; an active block gives `blocked`; a private path without approval gives `pending`; otherwise `ok`.
  - Discord viewers are keyed `discord:<id>` (`approvalKey` in `lib/accessRequests.ts`); guests are keyed by IP.
- **Path parameters:** must be validated with `PATH_NAME_RE` from `lib/streamSettings.ts` before use. Paths go into MediaMTX URLs and SQL keys.
- **Client IP:** must come from `getClientIp()` in `lib/net.ts`, which honours `CLIENT_IP_HEADER` and takes the last `x-forwarded-for` entry. Reading `x-forwarded-for` directly lets clients spoof their IP and dodge kicks.
- **Secrets and passwords:**
  - Compare them with `safeEqual()` from `lib/credentials.ts`, never `===` (timing).
  - Login checks go through `throttledLogin()`.
  - The hook route (`app/api/streams/hook/route.ts`) must keep rejecting a missing or wrong `X-Hook-Secret` with 401. It is exempt from the proxy because MediaMTX has no session.
- **Cross-site guard:** `proxy.ts` blocks non-GET requests whose `sec-fetch-site` isn't same-origin or none. New state-changing endpoints must not use GET. They also must not be added to the exemptions before the guard runs.
- **Auth callbacks** (`lib/auth.ts`, `lib/auth.config.ts`):
  - A placeholder or missing `NEXTAUTH_SECRET` must keep producing no session.
  - The roles are `streamer`, `viewer` and `discord`, and the JWT/session shapes are relied on everywhere.
- **Redirect targets:** must go through `sameSitePath()` in `lib/loginUrl.ts`, which blocks open redirects such as `//evil.com`, `/\evil.com` and `javascript:` URLs.
- **Never log secrets or passwords.** No `NEXTAUTH_SECRET`, `STREAMER_PASSWORD`, viewer passwords or hook secrets in logs or responses.

## 3. State, data and I/O

- **Live updates:**
  - Any mutation that changes what the dock or viewers see must call `notifyChanged(path)` from `lib/events.ts`, or `notifyChanged(ALL_PATHS)`. Otherwise open pages don't update until the next poll. This covers access, approvals, blocks, visibility, passwords, stream state and viewers.
  - Listeners re-read state themselves, so pass only the path.
- **Effects on connected clients:**
  - Changing access state (approvals, blocks, visibility, passwords) affects people who are already connected. Viewers on the waiting screen keep a gate SSE connection open (`app/api/watch/[path]/route.ts`), and `keepAccessRequest` doesn't re-create a request that's been deleted. Viewers already watching keep their WebRTC session until it's kicked (`kickWebrtcSession`); see how `app/api/streams/visibility/route.ts` cuts them off when a stream goes private.
  - Check that the change handles both groups deliberately.
- **In-memory registries:**
  - Must live on `globalThis` with the `??=` pattern, so every route bundle and dev HMR share one instance (see `lib/events.ts`, `lib/watchRoom.ts`).
  - Note that `lib/viewerIdentities.ts` is a known exception: a module-level Map.
  - The app assumes a single `mtxcord-web` container, so don't add anything that needs a second instance to see this state.
- **SQLite** (`lib/db.ts`):
  - Schema changes must be additive and idempotent inside `getDb()`: `CREATE TABLE IF NOT EXISTS`, and `ALTER TABLE` guarded by a `pragma('table_info(...)')` column check. Existing user databases are migrated in place on every start.
  - A schema change needs a migration test, against an old-schema temp-file DB, in `tests/unit/lib/db.test.ts`.
  - Error convention: reads log the error and return a safe default, and writes throw. Approval checks must fail closed.
- **Outbound HTTP** (MediaMTX, Discord, Derpibooru):
  - Every `fetch` needs a timeout (`AbortSignal.timeout(...)`, as in `lib/mediamtx.ts` and `lib/guestIdentity.ts`), and its failure must be handled.
  - An unhandled throw turns into a 500. That was a real bug in the WHEP/WHIP proxy, which now answers 502 "Media server unreachable".
  - Known existing gap: the Discord webhook fetches in `lib/discordWebhook.ts` have no timeout. Flag new code that copies that pattern.
- **MediaMTX:**
  - Build URLs with `mediamtxApiBase()`/`mediamtxWebrtcBase()` and authenticate with `mediamtxAuthHeader()`.
  - A new MediaMTX endpoint the app calls must also be implemented in `nextjs/tests/fakes/mediamtx.ts`, which the integration tests and e2e share.
  - Order side effects so that a failed MediaMTX call leaves no partial state. That was a real bug too: a kick used to block the viewer even when the MediaMTX kick failed.
- **Hook contract:**
  - `mediamtx/hooks/*.sh` POST `{path, action}` with the `X-Hook-Secret` header. The actions are `ready`/`notReady` (also accepted: `online`/`offline`) and `read`/`unread`.
  - A change on either side must keep the two consistent. That covers `mediamtx/entrypoint.sh` too: it maps `paths.yml` entries to `MTX_PATHS_<NAME>_*` env vars and grants publish rights per path.

## 4. Conventions and docs

- **Next.js 16:**
  - The project rule in `nextjs/AGENTS.md`: read the relevant guide in `nextjs/node_modules/next/dist/docs/` before relying on Next APIs.
  - Request gating lives in `proxy.ts`; this project doesn't use `middleware.ts`.
  - Dynamic route params are a Promise: `{ params }: { params: Promise<{ path: string }> }`.
  - Routes that read query strings use `req.nextUrl` (`NextRequest`).
- **Env vars:**
  - A new or changed one must be documented in the config table of `nextjs/README.md` (or `mediamtx/README.md`), and in the root README's shared variables if both services read it.
  - If users are expected to set it, add it to both `docker-compose.yaml` and `dev/compose.yaml`.
  - Test-only seams (`MTXCORD_DB_PATH`, `GUEST_AVATAR_BOORU_URL`) must keep the production default when unset.
- **Docs:** a user-visible behaviour change should update the README section that describes it. These READMEs are detailed and kept accurate.
- **Docker and CI:**
  - Node 26 is used everywhere (Dockerfile stages, `.github/workflows/test.yml`).
  - New test or dev-only files must be excluded from the image in `nextjs/.dockerignore`.
  - `build-web` in `.github/workflows/docker-build.yml` must keep depending on `test-web`.
  - CI runs the type check plus unit and integration tests, never e2e.
  - On pull requests CI runs `next build` (in `.github/workflows/test.yml`) instead of building the Docker image. A change that only breaks the image, e.g. to the Dockerfile, `.dockerignore` or a native dependency, therefore shows up only on master. For such changes, run `docker build ./nextjs` locally before merging.
- **Dependencies:**
  - Keep `react` and `react-dom` exact-pinned to the same version.
  - `eslint` stays on 9 and `typescript` on 6 until `eslint-config-next` supports newer majors.
  - A `package.json` dependency change needs a matching `package-lock.json` change.
- **Style:** match the surrounding file. Some files use semicolons and double quotes, others neither. Comments explain why, not what.
