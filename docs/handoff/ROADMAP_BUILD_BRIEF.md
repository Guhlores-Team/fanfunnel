# Roadmap build brief (shared by every roadmap agent)

The owner chose to build ALL 11 roadmap items before alpha. Specs are in
`docs/handoff/PROPOSALS.md`.
Read your item's section, plus the cross-cutting / shared-foundations sections it depends on.

## Owner decisions
The owner is away and has not answered the decision list yet. **Use the proposal's recommended option for every
decision in your item.** Build it so the choice is cheap to flip later: put it behind a named constant, a setting or a
config value, not logic scattered through the code. In your report, list each decision you implemented, its default,
and exactly where to flip it (file:line).

## Rules (binding)
- Also read `PHASE2_BRIEF.md` and `AGENT_BRIEF.md` in the same scratchpad.
- Base your branch on the current `origin/dashboard-redesign`: `git fetch origin dashboard-redesign && git checkout -B <your-branch> origin/dashboard-redesign`.
- Commit locally only: push nothing, open no PR, merge nothing. The orchestrator merges and pushes.
- Use only your assigned port, and stop only your own server.
- `AGENTS.md` is binding:
  - auth contract;
  - RLS on every new table, with a policy;
  - privileged operations through server routes;
  - new RPCs revoked from anon/public (see 0044);
  - a negative test for every new authz surface.
- Fairness: never change odds outside the committed seed derivation. Keep the `fans == SUM(passes)` invariant.
- Migrations: use only the number(s) you are assigned. Mirror each into `supabase/schema.sql` and
  `supabase/migrations_combined.sql` (append at the end), and update `src/lib/data/db.types.ts` by hand to exactly what
  `supabase gen types` would emit (CI fails on any difference).
  `PG_BIN=/usr/lib/postgresql/16/bin node scripts/db/schema-drift-check.mjs` must be ALL PASS.
- Keep the mock (demo) path and the Supabase path in parity.
- No new dependencies unless your proposal names one. Never weaken, skip or delete tests.
- Read `node_modules/next/dist/docs/` for any Next.js API you use.
- Respect `prefers-reduced-motion`, keyboard use and AA contrast, at 360, 390 and 1440 with no horizontal overflow.
  The DESIGN.md motion rules apply: transform/opacity only, no opacity-from-0 entrances for content.
- e2e: CI runs `npm run e2e`, then `npm run e2e:a11y`, on the SAME server, and e2e's last journey (`firstRunJourney`)
  wipes the demo account. New e2e steps go before it. New a11y states must not depend on demo data surviving.
- No model names anywhere. Commit trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01CsnrjqW2CQm5um63ixPS33`

## Verify before reporting (real output)
- `npm run lint`, `npm run typecheck`, `npm test`
- `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build`
- fresh `npx next start -p <port>`, then `E2E_BASE_URL=http://localhost:<port> npm run e2e` (run it twice; 0 browser signals)
- `npm run e2e:a11y` on the same server after e2e (0 blocking)
- the drift check, if you added a migration
- screenshots at 1440, 390 and 360 into `scratchpad/roadmap/<item>/`

## Report
- branch and sha;
- what was built (file:line);
- decisions implemented, with their defaults and where to flip them;
- tests added;
- exact verify output;
- anything left undone, and the owner calls still open.
