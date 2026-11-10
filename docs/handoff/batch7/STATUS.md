# Batch 7 status (stopped 2026-11-10 ~18:35 UTC when the usage budget ran out)

Nothing from batch 7 is on `main`, on `dashboard-redesign`, on the Preview, or in any hosted database.
The Preview and PR #78 still show batch 6 (`dashboard-redesign` = 64000ec, migration 0072).

## Branches (all pushed to GitHub)
| Branch | Head | State |
|---|---|---|
| `orch/fixes` | this commit | Integration branch. Holds ci, db (rounds 1-4), trust, auth (round 1), dash (round 1), server, fan. Lint clean, typecheck clean, `npm test` 397/397 on a28f128 (before the fan merge). |
| `gaps/b7-dash` | aed610e | NOT merged. Suspended-account fixes S1/S3-S6, agency banner, 0073 review mappings. Its last gate (unit.sh 11) was interrupted: re-run the gate. |
| `gaps/b7-db` | 8303493 | NOT merged. 0073 rounds 5+6 (suspended setters, reserved words loosened, fan mute, review H1/M1-M4/L2-L9, `scripts/golive/live-precheck.sql`). Its last gate FAILED the drift check: `creator_request_journal_creator_id_fkey` violation while building (see PROGRESS_db.md). Must be fixed before merge. |
| `gaps/b7-auth` | fff4c85 | NOT merged. Fixes for REVIEW_AUTH.md A1-A9 (A1 is the important one: password reset and invitations dead-end without it). `npm test` 402/402 on 5744dea; final gate on fff4c85 was interrupted: re-run it. |

## Finish order (for whoever continues)
1. db: fix the drift failure, re-run its gate (lint, typecheck, npm test, build, drift x2, interplay, conc T8, e2e). Merge into `orch/fixes`.
2. dash: merge `orch/fixes`, re-run its gate, merge.
3. auth: merge `orch/fixes`, re-run its gate, merge.
4. Open follow-ups the builders did not reach: fan side of the mute (TS-17: Safety menu item, `/api/fan/mute`, `sendCreatorMessage` refuses `muted`), TS-07 "Team" label in chat, TS-13 export fields (trust report in TRIAGE.md), GO_LIVE text pointing at `scripts/golive/live-precheck.sql`, MASTER_TRACKER section 4 statuses.
5. Two full verification rounds on the final `orch/fixes` (lint, typecheck, npm test, build, drift x2, interplay, stress-db, e2e, a11y, stress-http).
6. Push `orch/fixes` to `dashboard-redesign` (never `main`). CI applies 0073 to TEST. Check `schema_version()` = 73 and `legal_terms_version()` = '2026-11-11' on TEST.
7. Exact-commit Vercel Preview, stable alias, smoke test; update the PR #78 body (keep the do-not-merge banner).
8. Owner tests the Preview with `docs/handoff/OWNER_STEPS.md` stage 7, then decides on go-live.

## Files here
TRIAGE.md (every audit finding, who built it, merge log, owner and lawyer questions), REVIEW_AUTH.md, REVIEW_0073.md,
BUILDER_BRIEF.md (rules every builder followed), PROGRESS_dash.md / PROGRESS_db.md / PROGRESS_auth2.md (exact state of the unmerged work).
