# Master tracker — everything left before go-live

Single source of truth for "is it done". A row is closed only when its fix is
merged to `dashboard-redesign`, CI is green on that exact commit, it is checked
on TEST/Preview where applicable, and its test exists. Audit IDs (A#) refer to
`COMPLETENESS_AUDIT_2.md` (2026-10-29, at fd71482).

Owner confirmations: Look & feel card seen on Preview (2026-10-29). Admin 2FA enrolled.

## 1. Roadmap stages (prepared source → integrate)
State as of 2026-11-04. `orch/fixes` contains migrations 0001–0066 + final hardening + audit batch 3 (merges 4a49139 b3-db, 43e4840 b3-app, 2a0f979 b3-ui, c73dd44 b3-ops; see `CHECKPOINT_2026-11-04.md`). The TEST database is still at 0061.
"On `dashboard-redesign`" means contained in the local `origin/dashboard-redesign` ref (head 8bf5c4c);
CI-green-on-that-SHA and Preview checks are not recorded here, so no row below is closed.

| Item | Migration | State |
|---|---|---|
| RM-7a scratch tickets | 0060 | integrated (7c0b39e on `dashboard-redesign`, 79c923d into the gap fixes) |
| RM-7b personal bingo | 0061 | integrated with its review fixes and the interplay suite (e2dd3e3, on `dashboard-redesign`): one shared game ranking (f76e6a5, TS mirror 3d6bc6b), stock compare-and-set sent with wheel saves (244a919), bingo archive with active cards (7603125), readiness messages (2258a3a), card copy gated on engagement (101b704), blocked fan's card readable (9c5201a), focus-pack lock order (79239e7); migration 0061 not yet verified on any hosted DB |
| Interplay stress suite | — | landed with 0061 (5b7992e, merged d835723): `scripts/db/interplay-check.mjs`, `INTERPLAY_STRICT=1` clean; see `INTERPLAY_STRESS.md` |
| Game/campaign switching UX (owner report 2026-10-29) | — | integrated (87d1899, on `dashboard-redesign`); done-pending-Preview. One TS ranking in `src/lib/games/liveGame.ts` mirrors `_creator_default_wheel`; e2e `game-switching*.mjs`; ignored campaign games explained on fan links (cd69dda) |
| Account-security follow-up | 0062 | integrated on `orch/fixes` (4c5d52b, merged baa19d0): enrolled creator MFA (aal2 in the DB), invite expiry, active-admin safety; not yet on `dashboard-redesign` |
| Ledger operations + 7-path safety overlay | 0063 | integrated on `orch/fixes` (c91fad1 + review bc520e9, merged 751852e); not yet on `dashboard-redesign` |
| Audit batch 1 | 0064 | integrated on `orch/fixes` (merged 53319d5, adapted to 0060–0063 in 3e978f6; 0062 MFA proven on the 0064 queue/inbox/webhooks in 00e9bdb); not yet on `dashboard-redesign` |
| Per-fan game pins + batch-3 DB hardening | 0065 | integrated on `orch/fixes` (merged 4a49139): a link can play its own game (`set_fan_pass_game`, `_creator_default_wheel(p_pinned)`), lifecycle locks in the play order (A44), A11 retention, A12 indexes, A17 atomic first-admin claim, A35 award cost snapshots; not yet on `dashboard-redesign` |
| Agency seat scopes, approval notice, alert release | 0066 | integrated on `orch/fixes` (merged 43e4840): A19 `my_seat_creators` + scoped queue/inbox, A30 approval notice, A27 alert-slot release, `rollback_claimed_spin` revoked from the service role (A20); not yet on `dashboard-redesign` |
| Final hardening (36 paths) | — | integrated on `orch/fixes` (ea36ac5, merged 301ec76): encoding guard, private rate-limit keys, Preview tooling, TEST maintenance |
| Flake fixes | — | done: bonus read fixture in today's UTC day (8bf5c4c), game_ready in test wheel rows (283356d), bingo archive assertion (13af234), wait for game list (a385f45), bingo lock race off the pity sequence (e22117c); the four final-hardening intermittents (e4c8309: streamed fan-page `<title>` gap, scratch withdraw/reopen lock, chase action under the Preview badge at 360px, 0058 storage security race probe) and the 0063 probe report (65232cc) are on `orch/fixes` only |

## 2. Audit gaps
| Batch | IDs | State |
|---|---|---|
| 1 | A1 (blocker: fan-report review), A3, A4, A5, A6, A7, A8, A13, A16, A23, A24 | integrated on `orch/fixes` as 0064 (see §1); closes when on `dashboard-redesign` with green CI and Preview checks |
| 2 (after 0061, same code) | A42 cancelled-prize stock | queued; A2 wheel-save stock overwrite **closed** inside 0061 (`expected_stock` compare-and-set in `save_wheel_prizes`, `stock_changed` 409 surfaced by WheelEditor; interplay concurrency 3c proves it) |
| 3 | A9, A10, A11, A12, A14, A15, A17, A18, A19, A20, A21, A22, A25, A27, A28, A29, A30, A31, A32, A33, A34, A35, A36, A37, A40, A41, A43, A44 | integrated on `orch/fixes` (2026-11-04) from the four branches off 301ec76 (`gaps/b3-db` 0065, `gaps/b3-app` 0066, `gaps/b3-ui`, `gaps/b3-ops`); closes when on `dashboard-redesign` with green CI and Preview checks. Open residual: A28 seat scope (below) |
| Go-live tooling | A38 TEST→LIVE carry-over script (dry-run first), A39 enforce DB-before-code ordering | integrated on `orch/fixes` with `gaps/b3-ops` (below) |
| Stress | A26 load/abuse harness + the 10 scenarios in the audit's stress-test plan | interplay suite landed with 0061 (`scripts/db/interplay-check.mjs`, `INTERPLAY_STRICT=1` clean; see `INTERPLAY_STRESS.md`); load/abuse harness on `gaps/b4-stress` (`npm run stress`, `scripts/stress/`, results and the open `COMMIT_RESOLVES_WHEEL_PER_STATEMENT` deadlock write-up in `STRESS_RESULTS.md`; the fix needs a migration on the DB branch) |

Batch 3 branches (all merged into `orch/fixes` on 2026-11-04, in this order):
- `gaps/b3-db` (0065): per-fan link-game route and drawer control, lifecycle locks, A11/A12/A17/A35/A44, the 0063 initializer race, observed-wait probes.
- `gaps/b3-app` (0066): A19 seat scopes, A30, A27, A18, A22 per-route limits with capacity eviction and the shared-store flag, A20/A43/A21 dead spin path removed, A29. Integration fixes on `orch/fixes`: the 0065 link-game route throttled (A22), the A36 demo-parity test passes a Request.
- `gaps/b3-ui`: A14, A15, A28, A31, A32, A33, A34, A36, A37, A41, A7/A9/A10 policy text, reveal-timing flake.
- `gaps/b3-ops` (CI, scripts, docs only; no migration):
  - **A25** done-pending-CI: missing TEST secrets fail the `supabase` and `login-ui` jobs; only fork PRs skip, with a warning and a NOT RUN summary (`scripts/ci/supabase-secrets-gate.mjs`, guard `scripts/test/ci-secrets-gate.test.mjs`). Owner: add the TEST trio as Dependabot secrets (OWNER_STEPS 14a).
  - **A39** done-pending-owner-setting: `db-migrations-production` runs on every `main` push and verifies the remote history; Vercel Deployment Checks hold Production until it passes (`docs/GO_LIVE.md` §5, guard `scripts/test/db-before-code.test.mjs`). Not enforced until the owner adds the check in Vercel (OWNER_STEPS 14b). Runtime `schema_version()` check deferred to 0067 (0066 shipped the seat scopes).
  - **A38** done (never run against a hosted DB): `scripts/golive/carry-over.mjs`, dry run by default, tested on disposable Postgres (`carry-over.test.mjs`, `carry-over.db.test.mjs`); `docs/GO_LIVE.md` §6.
  - **A40** done: stale references fixed in OWNER_DECISIONS, AGENT_BRIEF, SEC_AUDIT_BRIEF, HANDOFF (§3d closed items, pending audit file), COMPLETENESS_AUDIT (superseded), the `README.md` roadmap and this tracker.
  - Review fixes (2026-11-04): `scripts/ci/verify-migrations-applied.mjs` now parses what CLI 2.122.0 really prints (cells in backticks, "` `" for an absent side, box-drawing variants); the first version rejected every real listing, which would have failed `db-migrations-production` on every push and blocked all promotions. The pure TEST-maintenance guard runs in CI `verify` on every push/PR (it was dispatch-only). Carry-over: a bad percent-escape in a DB URL is a `DB_URL_MALFORMED` refusal, not a crash.

New batch-3 items (2026-10-29):
- A43: remove the dead legacy spin path in `src/lib/data/spins.ts` (below the `commitSpinAttempt` return, ~L270) plus `finalizeInstantSpin` / `reserveRewardCode` / `releaseRewardCode`, which call 0057 RPCs revoked from every role in 0059.
- A44 (lock order): archiving a wheel locks wheel then fans (0059 lifecycle trigger) while play locks fan then wheel, so the two can deadlock. Add a lockRace probe, then fix the order.
- A7 follow-up (batch 3, owner text): Terms and Privacy must mention scratch tickets and personal bingo now that 0060/0061 shipped; `src/app/terms/page.tsx` and `src/app/privacy/page.tsx` still describe only "prize wheels".
- Flake watch (batch 3): e2e `reveal.mjs` "the reveal is up within 6400ms" missed by 29ms once under load (gaps-1-final round). The budget is `SPIN_MS` 4400 + `MAX_THEATER_EXTRA_MS` 1500 + 500; investigate the budget against the reveal animation timing before widening anything.

Closed early inside 0061: A2 (`expected_stock` compare-and-set), CROSS_TENANT_HAPPY_HOUR, ISSUANCE_IGNORES_SCHEDULE, ACTIVE_ORDER_MISMATCH and the bingo review fixes; the focus-pack grant lock order was fixed in 79239e7.

Done in 0065: per-fan game assignment (a link chooses its own game, not only via its campaign). Runtime schema-version check (A39 residual) needs a later migration (0067).

Open items found while integrating batch 3 (2026-11-04):
- **A28 residual (agency seats)**: `PATCH /api/campaigns/[id]` (archive / rename / pin) and the `src/lib/data/campaigns.ts` writers filter `.eq("creator_id", user.id)`, so an agency seat with `can_act_for(creator, 'manage')` gets 404 even though `campaigns_write` RLS would allow the write. Not a security gap (the owner path is unchanged and RLS still gates every row), and not fixable as a small route change: `listCampaigns` is `user.id`-scoped too, so a seat never sees another creator's campaigns, and the route has no `creatorId` input. Needs the A19 pattern end to end: `?creatorId=` on the campaigns list and PATCH/DELETE via `resolveActingCreator(..., 'manage')` (new `SeatJob`), the Campaigns tab's seat picker, and a negative test (a seat without `manage` and an unrelated creator both refused).

## 3. Verification & acceptance (from TAKEOVER_CHECKPOINT open gaps)
- Two fresh independent security audits + privacy-promise check + outside-attacker pass; fix Critical/High.
- Feature/completeness re-audit after all of the above (expect zero open rows).
- Hosted authenticated feature checks on Preview; installed-phone push (iPhone Home Screen + Android).
- Reward-key backup + TEST restore drill; second-admin recovery drill.
- Email settings + authorized delivery tests; TEST cron scheduling and alert receipt.
- Old Preview retirement (owner approval).
- Owner acceptance on Preview via `e2e/MANUAL-CHECKLIST.md`, then go-live per `docs/GO_LIVE.md` only on the owner's explicit "go".
- `scripts/security/rls-runtime-test.mjs`: run the new happy-hour negative (cross-tenant happy hour refused, 0061) against TEST in CI after push.
- Go-live environment (seen 2026-10-31 in the Vercel env listing): **Production lacks `REWARD_ENCRYPTION_KEY` and `REWARD_CODE_FINGERPRINT_KEY`** (Preview has them), and `CRON_SECRET` is on neither scope. Without the reward keys the 0063 startup canary reports the crypto configuration as missing and system health stays unhealthy; without `CRON_SECRET` the retention cron and Admin › Errors alerts refuse to run. Owner adds them (OWNER_STEPS 19a; `docs/GO_LIVE.md` §4), generated fresh for LIVE and backed up.
