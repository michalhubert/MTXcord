<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project rules

See the repository's [AGENTS.md](../AGENTS.md). In short: every change must include tests or test changes (unit, integration, or e2e for critical paths, all under `tests/`), and a bug fix needs a regression test. Run `npm test`, `npx tsc --noEmit` and `npm run lint` before finishing.
