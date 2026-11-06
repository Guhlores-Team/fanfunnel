# FanFunnel phase-2 brief (shared rules; overrides AGENT_BRIEF.md where they differ)

Context: all 35 PRs are now consolidated into `dashboard-redesign` (head `7266e8d`). The owner wants NO new remote
branches and NO new PRs. Everything lands on `dashboard-redesign`. Everything planned must be built before the owner tests.
The redesign must keep EXACTLY every feature/control the prior (main) dashboard had, plus every feature added since.

## How you work
- You run in your own git worktree. Do: `git fetch origin dashboard-redesign && git checkout -B <your-local-branch> origin/dashboard-redesign`.
- **Push NOTHING. Open no PR. Merge nothing.** Commit on your local branch only. The orchestrator merges your branch into
  `dashboard-redesign` and pushes. Report your local branch name and final commit sha.
- Other agents work in parallel on other areas. Stay inside your scope. Avoid editing `src/lib/data/index.ts` unless your
  item needs it (another agent is splitting that file by domain right now). If you need a new data function, put it in a NEW
  file under `src/lib/data/` and add a single export line in `index.ts`. Keep edits to `DashboardClient.tsx` /
  `DashboardShell.tsx` minimal and localized.
- Everything else in `docs/handoff/AGENT_BRIEF.md`
  still binds you (AGENTS.md auth contract, no new deps, never weaken/skip/delete tests, failing-test-first for bugs,
  mock + Supabase paths both, migrations numbering + schema.sql/migrations_combined.sql mirror, NUL byte in index.ts,
  planning docs on `origin/claude/eager-volta-l8juq7` never committed, Playwright setup, port discipline, commit trailers,
  no model names). Ignore its "PR" section and its CI-port step.
- Owner decisions: `docs/handoff/OWNER_DECISIONS.md`.
  Placement interview with file:line and options per P#: `.../scratchpad/placement-interview.md`. Parity map:
  `.../scratchpad/PARITY_MAP.md`. Design source: `docs/design/command-center/` on `origin/claude/eager-volta-l8juq7`
  (README.md has the behavior spec; screenshots/*.png; the .dc.html prototypes). Prior design = `origin/main`.
- Migrations: the highest number in the repo is 0041. If you need one, ask the orchestrator for a number in your report
  instead of guessing; use 0042+ only if told in your prompt.

## Verify before you report (all must pass, real output)
`npm run lint` · `npm run typecheck` · `npm test` (currently 52/52 files) · `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build` · fresh
`NEXT_PUBLIC_ENABLE_DEBUG=1 npx next start -p $PORT` · `E2E_BASE_URL=http://localhost:$PORT npm run e2e` (currently 25/25,
0 browser signals; add steps for new behavior) · `npm run e2e:a11y` (0 blocking). UI work: Playwright screenshots at 1440
and 390 + no horizontal overflow at 360; compare against the design screenshots AND the prior main dashboard. Stop only
your own server (see AGENT_BRIEF.md).

## Report (final message, concise)
local branch + sha · what changed (file:line) per item ID · tests added · exact verify output · anything blocked or needing
an owner call · new bugs noticed but not fixed (file:line).
