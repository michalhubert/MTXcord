---
name: review-mtxcord
description: Reviews MTXcord changes against this repo's own rules. Checks that tests are included as AGENTS.md requires, the access-control invariants (proxy dock prefixes, streamer/viewer auth helpers, hook secret, path validation, client IPs), live-update and globalThis state, SQLite migrations, MediaMTX/Discord/Derpibooru I/O, Next 16 conventions, env var docs, and the Docker/CI setup. Use it whenever the user asks to review, check or look over changes in this repo (uncommitted work, the current branch, a PR number such as "review 23" or a PR URL, or specific files), when asked whether a change is ready to commit, push or merge, and as a self-check before finishing a change in this repo. It complements the built-in /code-review, which hunts for generic correctness bugs; prefer this skill when the question is whether a change follows MTXcord's conventions.
argument-hint: "[PR number | PR URL | paths...]  (empty = uncommitted changes + branch vs master)"
---

# Review an MTXcord change

The value of this review is knowing the project's invariants: where a new route must be registered, what every change has to come with, which helpers enforce access control, and the bugs this codebase has already had. A generic review misses these.

Go through the checklist first, because that's where this review adds what others don't. Then think through how the change behaves for the people actually using the app (step 4), and report real problems you find there too.

## 1. Work out what to review

Pick the scope from the arguments:

| Argument | Scope | How to get it |
|---|---|---|
| none | Uncommitted work **plus** the current branch's commits that aren't on `master` | `git diff $(git merge-base master HEAD)` (covers both, for tracked files), plus `git ls-files -o --exclude-standard` for new untracked files, which you read in full |
| a number, `#N` or a PR URL | That GitHub PR | `gh pr view N --json title,body,headRefName,baseRefName,files` and `gh pr diff N` |
| paths | Those files or folders as they are now | Read them; also `git diff $(git merge-base master HEAD) -- <paths>` to see what changed |

- With no arguments, on `master` with a clean tree, there is nothing to review: say so and stop.
- If `gh` isn't found, it may be installed but not on this shell's PATH (on Windows: `"/c/Program Files/GitHub CLI/gh.exe"`).
- For a PR whose branch isn't checked out, read the full files with `git fetch origin pull/N/head` and then `git show FETCH_HEAD:<path>`. This doesn't touch the working tree, so never check out the branch.

Skip generated or bulk files (`package-lock.json`, build output), apart from checking that a lockfile changes when `package.json` dependencies do.

## 2. Read beyond the diff

A finding has to rest on code you've actually read, not on a guess from a hunk. For each changed file, read the surrounding code it depends on. In particular:

- **A new or changed API route**: read `nextjs/proxy.ts`, plus the lib helpers the route calls.
- **A behaviour change**: search `nextjs/tests/` (grep for the module, route path or function name) to see whether tests cover it and whether they were updated.
- **A new env var**: check the config table in `nextjs/README.md` and both compose files.

## 3. Check it against the checklist (do this before step 4)

Read [references/checklist.md](references/checklist.md) and go through every section that applies to what changed:

1. Tests
2. Security and access control
3. State, data and I/O
4. Conventions and docs

A section that doesn't apply produces no findings, so don't pad the report.

Severity:

- **Blocking**: breaks a security or access invariant; is missing tests the rules require (a behaviour change or bug fix with no test); breaks the build, CI, or the Docker image; or loses or corrupts data.
- **Should fix**: a real problem that isn't urgent. Examples: a missing timeout or try/catch on an outbound call, a test in the wrong layer, an undocumented env var, a missing `notifyChanged`.
- **Nit**: style or clarity, or a small inconsistency with the surrounding code.

Before you report something, make sure it's real: point to the exact line, and confirm the rule actually applies there. For example, a route outside the dock area doesn't need `isStreamerAuthorized`. A short accurate list is worth more than a long speculative one. If you're unsure, say so in the finding instead of overstating it.

## 4. Think through runtime behaviour

The checklist catches broken conventions. It doesn't catch a change that follows every convention but does the wrong thing to someone mid-session. For each behaviour change, trace what actually happens:

- **Viewers waiting on the approval screen.** Their gate SSE connection (`app/api/watch/[path]/route.ts`) holds their pending request open. Does the change leave them stuck, approved without being told, or gone from the dock's list while still waiting?
- **Viewers already watching.** A WebRTC session outlives later access changes unless it's kicked through MediaMTX. Does the change need to cut existing sessions, the way going private does?
- **The streamer's dock.** Does it update right away (via `notifyChanged`), or only on the next 2 s snapshot? Does it still show the right counts?
- **Failure paths.** When an outbound call fails or times out, what state is left behind (a dropped id, a block, a half-applied change), and what happens on the next attempt?
- **Restarts and the next stream.** Persisted state, per-stream-session resets (approvals clear on go-live and go-offline), and import-time config.

Report what you find with the same evidence bar as the checklist findings. "Viewers on the waiting screen stay stuck, because X at file:line" is a finding; "might affect viewers" isn't.

## 5. Report

Findings only, most severe first, numbered. Give one line of scope first so the reader knows what was reviewed:

```
Reviewed: branch feat/x vs master + uncommitted changes (7 files)

1. [Blocking] nextjs/app/api/dock/foo/route.ts:12 - streamer-only route isn't in DOCK_PREFIXES (nextjs/proxy.ts:7). Anonymous requests reach the handler instead of being redirected to the streamer login. Fix: add '/api/dock/foo' (or put the route under an existing prefix).
2. [Should fix] nextjs/app/api/dock/foo/route.ts:30 - the new 409 branch has no test. Fix: add a case to tests/integration/dock-foo.test.ts.
3. [Nit] ...
```

Each finding gives the location, what's wrong, why it matters, and a concrete fix. If there are no findings, say so in one line after the scope line.

## 6. Offer follow-ups

After the report, ask, and do nothing until the user answers:

- **Fixes**: offer to fix the findings, or a subset. When fixing, follow AGENTS.md: a fix comes with a test that would have caught it. Then run `npm test`, `npx tsc --noEmit` and `npm run lint` in `nextjs/`.
- **PR comment** (PR scope only): offer to post the findings to the PR with `gh pr review N --comment --body-file <file>`. Show the exact text first, and post only after an explicit yes.
