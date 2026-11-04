# Checkpoint — 2026-11-05 (batch 4 integrated on `orch/fixes`, migration 0069)

Everything below is committed and pushed to `origin/orch/fixes`. `main`,
`dashboard-redesign`, Production and both Supabase projects are untouched.
The TEST database is still at migration **0061**. Nothing has been pushed to
`dashboard-redesign`; that step still waits for the owner's explicit "go".

## What is where

| Branch | Base | State | Verified |
|---|---|---|---|
| `dashboard-redesign` (PR #78) | — | unchanged since 2026-10-31 (8bf5c4c): 0060 scratch, 0061 bingo, game-switching UX | Yes (CI, Preview) |
| `orch/fixes` | 8bf5c4c | 0062–0066 + final hardening + batch 3 (`CHECKPOINT_2026-11-04.md`), **and now batch 4**: 0067 cancelled-prize stock + runtime schema version (`gaps/b4-db`), 0068 tenant boundaries / fan consent / deletion traces (`gaps/b4-dbsec`), A28 seats on campaigns + agency restyle (`gaps/b4-seats`), sharp 0.35.5 + enforced CSP (`gaps/b4-hard`), the 2026-11-04 QA pass (`gaps/b4-qa`), and **0069** integration hardening on `orch/fixes` itself | **Yes**: two full consecutive local rounds at **e3786d4** (numbers below); this checkpoint commit is docs-only on top of it |
| `gaps/b4-stress` | 7bea8ac | A26 load/abuse harness (`scripts/stress/`, `STRESS_RESULTS.md`); its full run finished and its own verification rounds were still running at this checkpoint | **Not merged yet** — merges last, after its agent reports |

Merge order and commits on `orch/fixes` (all `--no-ff`, after 27d70fe):

1. 36ee950 merge `gaps/b4-db` (768e137, 0067) — clean.
2. 44f4e83 merge `gaps/b4-dbsec` (6becd93, 0068) — conflicts in the drift-check
   probe wiring (both probes kept), the anon-setters allowlist (union) and both
   SQL snapshots (rebuilt as the 0067 snapshot plus the 0068 segment; tails
   byte-equal to the migration file). Reconciliation inside 0068: it redefines
   `schema_version()` to 68 (`EXPECTED_SCHEMA_VERSION` follows; the runtime,
   startup-isolation and interplay checks derive the level instead of a literal
   67) and revokes `set_redemption_state` from `service_role` (Supabase's
   default grants, now emulated by the stub, had given it EXECUTE; the server
   calls it on the caller's session only). The tenant probe accepts the 0067
   stock-unit guard's refusal of a forged redemption (it fires first, by
   trigger name) and disables both guards when planting its pre-guard row.
   **0067/0068 overlap**: no table, trigger, policy or index is touched by
   both; the only shared function is `schema_version()` (by design) and the
   only shared grant is the `set_redemption_state` revoke above. Both add a
   redemptions trigger (`redemptions_stock_unit_guard` / `trg_redemption_tenant`)
   that refuse the same forged spin reference; `set_redemption_state` never
   writes `spin_id`/`creator_id`, so 0068's guard does not fire on its path,
   and 0068's `creator_redemption_queue` carries nothing from 0067 (0067
   redefined no function).
3. 337a304 merge `gaps/b4-seats` (45eda01) — conflicts in `AgencyClient.tsx`
   (0068's creator/seat invitation split with b4-seats' restyle and copy), the
   drift-check header comment and `vercel.json` (unions). `InvitesBanner`
   merged on its own: 0068's role-aware copy plus the "you joined" banner.
4. a911239 merge `gaps/b4-hard` (d07f7ee) — conflicts in SECURITY.md (both
   rows), MANUAL-CHECKLIST (§19 before §20) and `vercel.json`. `npm ci` on the
   merged lockfile; `npm audit --omit=dev` = 0 vulnerabilities; sharp 0.35.5.
   The CSP strict-page list still equals the proxied pages (its test).
5. 665ec2f merge `gaps/b4-qa` (7ae374c) — conflict in CampaignsPanel's game
   help text (seat-aware wording plus the per-fan-link note). The 38 re-export
   removals in `src/lib/data/index.ts` (shared with b4-hard) break nothing in
   the other branches (typecheck, lint, 284 test files).
6. 86fe57f **migration 0069** (see `MASTER_TRACKER.md` §1): a game with fewer
   than 2 prizes cannot be chosen for a link (`set_fan_pass_game`), a campaign
   (`aa_campaign_game`, also refusing another creator's or an unplayable game)
   or a schedule (`ac_game_schedule_prizes`), for every role, mirrored in the
   demo store and the route error mapping; `INSERT` on `redemptions` revoked
   from `authenticated` (no session-client insert path exists; awards are
   written by `commit_spin_attempt`); `schema_version()` = 69. Negative probes
   in `scripts/db/integrationProbe.mjs` (drift check) and
   `src/lib/data/gamePrizeMinimum.test.ts`. The interplay fixture plants its
   archived / draft / cross-tenant campaign pins with the guard off (states a
   pin can reach later, or by forgery), the seat-scope and focus probes give
   their games two prizes, and the interplay check now has 1070 checks (one
   more refusal; no resolution case changed, the fixture was not regenerated).
7. d9975d4 the carry-over DB test's fixture pins its old game while it is
   playable (two prizes) and archives it afterwards (0069 refuses a pin to an
   archived game at write time; the carry-over still clears that pin).
8. 0958505 + e3786d4 `db.types.ts` back in the generator's order (the
   hand-merged 0068 entries had landed out of place; CI compares it with
   `supabase gen types` on TEST modulo whitespace) plus 0069's
   `_game_has_min_prizes`; trigger functions are not emitted.

## Verification (two consecutive clean rounds at e3786d4, fresh server each)

Script: scratchpad `orch-b4/verify.sh`, port 3271, logs under
`orch-b4/round3` and `orch-b4/round4`, both under the shared heavy lock. (An
earlier round at 86fe57f, `orch-b4/round1`, was clean except the carry-over
fixture fixed in d9975d4; its pair was withdrawn and the two rounds below ran
on the final code.)

| Check | Round 3 | Round 4 |
|---|---|---|
| lint / typecheck | ok / ok | ok / ok |
| `npm test` | 292/292 files | 292/292 files |
| `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build` | ok | ok |
| schema drift (default + `--crypto-schema public`) | ALL PASS ×2 | ALL PASS ×2 |
| interplay `INTERPLAY_STRICT=1` | 1070 checks | 1070 checks |
| `node --check` (e2e + scripts `.mjs`) | 92 files | 92 files |
| ops tests (`scripts/ops/*.test.mjs`) | 54 DB + 49 pure | 54 DB + 49 pure |
| script tests (ci-secrets-gate, db-before-code, carry-over, carry-over.db) | 48 + 45 + 71 + 52 | 48 + 45 + 71 + 52 |
| e2e (`npm run e2e`) | 204/204 steps, 0 signals, 0 CSP violations | 204/204 steps, 0 signals, 0 CSP violations |
| a11y (`npm run e2e:a11y`) | 136 states, 0 blocking | 136 states, 0 blocking |

`npm audit --omit=dev`: 0 vulnerabilities (after `npm ci` on the b4-hard lockfile).

## Open from this integration

- **`gaps/b4-stress` is not merged.** When it is, its D4 scenario must give
  its two games at least 2 prizes each (0069 refuses a one-prize campaign pin
  and `set_fan_pass_game` answers `game_not_playable`); the harness's own
  plumbing test (`scripts/stress/harness.test.mjs`) joins the script tests.
- **Owner decisions** are collected in `OWNER_DECISIONS.md` ("Open owner
  decisions, 2026-11-05"): reports kept on self-close, fan export without
  creator notes, seats by consent, a "Start an agency" Settings entry, the
  "To fulfil" count semantics, "spin" as the credit word on scratch/bingo, the
  Vercel Toolbar under the CSP.
- **Other creator-scoped write routes are not seat-aware** (tracker §2): grant
  edit, pass top-up, fan-link game, fan import, game saves. Each needs the
  A19/A28 pattern end to end.
- **Production env**: still missing `ADMIN_EMAILS`, `FF_REQUIRE_SUPABASE`,
  `CRON_SECRET`, both reward keys, the VAPID trio, `RESEND_API_KEY` and
  `ALERT_EMAIL_TO` (names checked 2026-11-04); the Upstash store is on both
  scopes. The owner's step-by-step: `docs/handoff/GO_LIVE_KEYS.md`
  (GO_LIVE §4, OWNER_STEPS 19a).

## To resume

1. Merge `gaps/b4-stress` into `orch/fixes` once its agent reports (fix D4's
   prize counts under 0069; validate; push).
2. With the owner's explicit "go": push `orch/fixes` to `dashboard-redesign`.
   CI applies 0062–0069 to TEST (DB before code), then deploy that exact SHA
   to the stable Preview. After 0062 an admin with an enrolled authenticator
   must enter its code for dashboard access; after 0068 agency seats and
   creators join by accepting an invitation; after 0069 a game needs 2 prizes
   before it can be chosen or scheduled.
3. Then: the stress round on the Preview, two independent security audits,
   final re-audit, owner steps (keys per `GO_LIVE_KEYS.md`, push on an
   installed phone, key backup + restore drill, second admin, email checks),
   owner acceptance, LIVE release per GO_LIVE.

## Waiting on the owner

- Results of the four Preview tests from the 2026-10-31 checkpoint.
- "Go" to push 0062–0069 + batches 3 and 4 to TEST and the Preview.
- The Production keys (`docs/handoff/GO_LIVE_KEYS.md`) and the open decisions
  above.
