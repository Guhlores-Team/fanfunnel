# Batch 7 status: finished (2026-11-10)

All batch-7 work is built, merged and verified on `orch/fixes`, and pushed to `dashboard-redesign`
(draft PR #78, "do not merge"). Nothing is on `main`; nothing has touched the LIVE database.

## Where it is
| What | State |
|---|---|
| `orch/fixes` = `dashboard-redesign` | Final head (this commit): every batch-7 branch merged (ci, db rounds 1-6 + 8z, trust, auth incl. A1-A9, dash, server, fan, docs/launch basics, leftovers: fan chat mute, Team label switch (off), export fields). |
| Local verification | Two full clean rounds: round 5 on d56dc92 and round 6 on de0b515 (docs-only difference). Then three small CI/Preview fixes: db.types.ts regenerated from TEST, the hosted RLS test's 0073 expectations, and the Production-key check no longer treating a Preview as Production. Each: lint, typecheck, `npm test` 425/425 files, build, schema drift ALL PASS twice (plain and crypto-schema), interplay strict 1070 checks, ops/script/go-live/stress unit tests, stress-db (D1-D10 incl. lock-order races), e2e 329/329 steps with 0 genuine signals, a11y 0 blocking, stress-http (H0-H10) green. |
| TEST database | Migration 0073 applied by CI: `schema_version()` = 73, `legal_terms_version()` = 2026-11-11, anon can run no SECURITY DEFINER function; hosted RLS runtime test and link-session test pass. |
| Preview | https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app (badge shows the commit). |
| LIVE database | Untouched (0038 era). Gets 0039-0073 only on merge day, after `scripts/golive/live-precheck.sql` shows only `ok` and the owner approves the `production` environment. |

## What is left (owner)
`docs/handoff/OWNER_STEPS.md` "Order from here to the live site", with the domain switch in `docs/CUSTOM_DOMAIN.md`,
the keys in `docs/handoff/GO_LIVE_KEYS.md` and merge day in `docs/GO_LIVE.md`.

## Not built (tracked in `docs/handoff/MASTER_TRACKER.md` section 4)
SC-13/14, PA-08, PR-18, WC-21, WU-19, TS-20/22/23/24; roadmap items (new games, other languages, light theme,
bulk actions, fan notifications, offline fan page, stored chat flags, FAQ). Partly built: PA-03, PR-02/03, WA-06/08/14,
WC-07/09, TS-04/21. Owner decision: WC-20.

## Files here
TRIAGE.md (every audit finding, who built it, merge log, owner and lawyer questions), REVIEW_AUTH.md, REVIEW_0073.md,
BUILDER_BRIEF.md (rules every builder followed), PROGRESS_dash.md / PROGRESS_db.md / PROGRESS_auth2.md (builder notes).
