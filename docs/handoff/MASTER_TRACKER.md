# Master tracker — everything left before go-live

Single source of truth for "is it done". A row is closed only when its fix is
merged to `dashboard-redesign`, CI is green on that exact commit, it is checked
on TEST/Preview where applicable, and its test exists. Audit IDs (A#) refer to
`COMPLETENESS_AUDIT_2.md` (2026-10-29, at fd71482).

Owner confirmations: Look & feel card seen on Preview (2026-10-29). Admin 2FA enrolled.

## 1. Roadmap stages (prepared source → integrate)
State as of 2026-11-05. `orch/fixes` contains migrations 0001–0069 + final hardening + audit batches 3 and 4 (batch 3: merges 4a49139 b3-db, 43e4840 b3-app, 2a0f979 b3-ui, c73dd44 b3-ops; batch 4: 36ee950 b4-db 0067, 44f4e83 b4-dbsec 0068, 337a304 b4-seats, a911239 b4-hard, 665ec2f b4-qa, then 0069; see `CHECKPOINT_2026-11-05.md`). `gaps/b4-stress` (A26 harness) is still being finished and merges last. The TEST database is still at 0061.
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
| Tenant boundaries, fan consent, deletion traces (privacy/DB-authorization audit at 7bea8ac + outside-attacker pass) | 0068 | integrated on `orch/fixes` (merged 44f4e83, after 0067; `schema_version()` → 68 and `set_redemption_state` revoked from `service_role` added in the merge): the drift stub now emulates Supabase's default grants; paused links stay paused and tokens are immutable; forged cross-tenant references refused; consent columns fan-only; self-close refused while suspended / reports open and reports outlive the account; `fan_passes.token` revoked from sessions (`creator_link_tokens` / `creator_link_pass`); message guard; invitations answer uniformly, seat by consent, throttled; `profiles.email` synced; deletion scrubs link traces; URL checks in SQL; `org_scope_creator` org check; stats mask e-mail/revenue; no TRUNCATE, nothing for anon; reward keyring; fan thread read moved to POST. Owner decisions: reports kept when the law requires; creator notes/tags stay out of the fan export (`LEGAL_NOTES.md`) |
| Agency seat scopes, approval notice, alert release | 0066 | integrated on `orch/fixes` (merged 43e4840): A19 `my_seat_creators` + scoped queue/inbox, A30 approval notice, A27 alert-slot release, `rollback_claimed_spin` revoked from the service role (A20); not yet on `dashboard-redesign` |
| Cancelled-prize stock + runtime schema version | 0067 | integrated on `orch/fixes` (merged 36ee950): A42 `redemptions.stock_unit` + `set_redemption_state` (a cancel returns a won limited unit once, a reopen takes it again or is `sold_out`), A39 residual `schema_version()` flagged by Admin › System health, the operational checks and startup |
| Batch-4 integration hardening | 0069 | on `orch/fixes` (after the batch-4 merges): a game with fewer than 2 prizes cannot be chosen for a link (`set_fan_pass_game`), a campaign (`aa_campaign_game`, which also refuses another creator's or an unplayable game) or a schedule (`ac_game_schedule_prizes`), for every role, mirrored in the demo store and the route error mapping (the QA pass had guarded only the pickers); `INSERT` on `redemptions` revoked from `authenticated` (awards are written by the award only); `schema_version()` → 69. Probe `scripts/db/integrationProbe.mjs` |
| One game resolution per play (A26 stress D4 deadlock) | 0070 | on `gaps/b5-spinlock` (off `orch/fixes` 8d1e8c3): `commit_spin_attempt` and `prepare_spin_attempt` resolve the game once into `v_wheel` under the fan/pass locks and lock the wheel and prizes of that one game (`_spin_attempt_context(pass, wheel)`), so a campaign pin, flag, schedule or archive change mid-call can no longer hold game A's wheel and game B's prizes (40P01); `schema_version()` → 70; `parseJsonBody` caps bodies at 1 MiB. Probe `scripts/db/spinResolutionProbe.mjs`; D4 hard checks (0 deadlocks; before: 257). See `STRESS_RESULTS.md` |
| Advisor hardening (Supabase advisors on TEST 2026-11-09) + trust & safety T1/T10 | 0072 | on `gaps/b6-db` (off `orch/fixes` 987125e): browser-role function privileges (table in §1a), `search_path` on `schema_version`/`_org_invite_email`, 31 foreign-key indexes, 32 policies with per-statement `auth.uid()`/`auth.role()`, `legal_terms_version()` read by both spin functions (T1), fan deletion clears redemption notes/due date (T10); probe `scripts/db/advisorHardeningProbe.mjs`, unit `src/lib/legalTermsVersion.test.ts`, rls-runtime 0072 block; not yet on `dashboard-redesign` |
| Final hardening (36 paths) | — | integrated on `orch/fixes` (ea36ac5, merged 301ec76): encoding guard, private rate-limit keys, Preview tooling, TEST maintenance |
| Flake fixes | — | done: bonus read fixture in today's UTC day (8bf5c4c), game_ready in test wheel rows (283356d), bingo archive assertion (13af234), wait for game list (a385f45), bingo lock race off the pity sequence (e22117c); the four final-hardening intermittents (e4c8309: streamed fan-page `<title>` gap, scratch withdraw/reopen lock, chase action under the Preview badge at 360px, 0058 storage security race probe) and the 0063 probe report (65232cc) are on `orch/fixes` only |

### 1a. 0072 function-privilege decisions (Supabase advisor, TEST at 0071)
Who calls each SECURITY DEFINER function a browser role could execute (src/ call sites; no `"use client"` module calls `.rpc`):

| Function | Caller | anon | authenticated |
|---|---|---|---|
| `is_admin()`, `can_act_for(uuid,text)`, `current_user_active()` | RLS policies (93 / 47 / 35) and the session client (`createClient`) | revoked | kept |
| `_owns_org(uuid)`, `_owns_org_seat(uuid)`, `_is_org_member(uuid)`, `_my_confirmed_email()` | RLS policies only | revoked | kept |
| `admin_account_stats`, `archive_wheel`, `creator_link_pass`, `creator_link_tokens`, `creator_redemption_queue`, `delete_campaign`, `delete_wheel`, `issue_creator_actor_context`, `my_seat_creators`, `org_account_stats`, `org_add_member`, `org_create`, `org_invite_creator`, `org_invite_respond`, `org_invite_revoke`, `org_leave`, `org_remove_creator`, `org_remove_member`, `org_scope_creator`, the 10 `set_*` setters, `set_redemption_state`, `wipe_my_spin_attempts` | the signed-in creator's own session client; each checks `auth.uid()` itself or through the helpers | already revoked | kept |
| `admin_reserve_account_deletion(uuid)` | none (the admin delete runs on the service gateway) | revoked | revoked (service_role kept) |
| `org_add_creator(uuid,text)` | none (consent bypass, server-only since 0030; TEST still granted it: drift) | revoked | revoked (service_role kept) |
| trigger functions `attach_spin_reward`, `erase_fan_reward_values`, `guard_delivered_redemption`, `handle_new_user`, `sync_code_prize_stock`, `sync_fan_spin_aggregate`, `guard_fan_break`, `admin_audit_log_immutable` | triggers only (no EXECUTE check at fire time) | revoked | revoked |

Why the helpers can leave anon: since 0068 anon holds no privilege on any public table, view or sequence, so it never evaluates a policy (its read stops at "permission denied for table"). Policies run as the querying role, so authenticated keeps every helper a policy calls. Proven on every build path by `advisorHardeningProbe.mjs` (a creator reads its own rows and never another tenant's through the wrapped helper policies; revoked trigger functions still fire) and on TEST by the rls-runtime 0072 block. 0072 ends with a check that refuses to apply if a browser role can still execute a SECURITY DEFINER function outside this table.

Left as they are (advisor WARN/INFO): the 51 multiple-permissive-policy pairs (`<table>_select` + `<table>_write` on campaigns, fan_passes, fans, grants, messages, org_members, orgs, prizes, redemptions, wheels; `org_invites_invitee_read` + `org_invites_owner`): merging them is not provably the same semantics, so not done. The 16 "unused" indexes stay (TEST traffic is no evidence). Leaked-password protection is an Auth dashboard setting for the owner (TEST and LIVE).

## 2. Audit gaps
| Batch | IDs | State |
|---|---|---|
| 1 | A1 (blocker: fan-report review), A3, A4, A5, A6, A7, A8, A13, A16, A23, A24 | integrated on `orch/fixes` as 0064 (see §1); closes when on `dashboard-redesign` with green CI and Preview checks |
| 2 (after 0061, same code) | A42 cancelled-prize stock | built in 0067 on `gaps/b4-db` (not yet merged; see §1): the award records the unit it took, `set_redemption_state` returns it on cancel and takes it again on reopen, exactly once, in the wheel → prize → redemption lock order; reproduced first (interplay §7: cancel left stock 2 of 3), then proven by interplay §7 (idempotency, 12 racing cancels, cancel/reopen flip-flops, cancels racing plays and compare-and-set wheel saves, cross-tenant and forgery negatives), the focus-ledger probe (Chase-held unit, instant reward refused), the Bingo probe (active-card cell, finite line prize), the seat-scope probe and `redemptionRestock.test.ts` (demo parity). Legacy awards are backfilled only when the play's recorded context proves the unit; already-cancelled legacy awards are left untracked (never returned twice). A2 wheel-save stock overwrite **closed** inside 0061 (`expected_stock` compare-and-set in `save_wheel_prizes`, `stock_changed` 409 surfaced by WheelEditor; interplay concurrency 3c proves it) |
| 3 | A9, A10, A11, A12, A14, A15, A17, A18, A19, A20, A21, A22, A25, A27, A28, A29, A30, A31, A32, A33, A34, A35, A36, A37, A40, A41, A43, A44 | integrated on `orch/fixes` (2026-11-04) from the four branches off 301ec76 (`gaps/b3-db` 0065, `gaps/b3-app` 0066, `gaps/b3-ui`, `gaps/b3-ops`); closes when on `dashboard-redesign` with green CI and Preview checks. Open residual: A28 seat scope (below) |
| Go-live tooling | A38 TEST→LIVE carry-over script (dry-run first), A39 enforce DB-before-code ordering | integrated on `orch/fixes` with `gaps/b3-ops` (below) |
| Stress | A26 load/abuse harness + the 10 scenarios in the audit's stress-test plan | interplay suite landed with 0061 (`scripts/db/interplay-check.mjs`, `INTERPLAY_STRICT=1` clean; see `INTERPLAY_STRESS.md`); load/abuse harness on `gaps/b4-stress` (`npm run stress`, `scripts/stress/`, results and the open `COMMIT_RESOLVES_WHEEL_PER_STATEMENT` deadlock write-up in `STRESS_RESULTS.md`; the fix needs a migration on the DB branch); merged into `orch/fixes` 2026-11-05, both rounds green on `1ade483`; the deadlock fix is 0070 on `gaps/b5-spinlock`) |
| 4 | A39 residual, A42, A45, A46, A47, A49–A53, A28 residual (seats), privacy/DB-authorization audit (0068), CSP, sharp audit fix, QA pass 2026-11-04 | integrated on `orch/fixes` (2026-11-05) from `gaps/b4-db` (0067), `gaps/b4-dbsec` (0068), `gaps/b4-seats`, `gaps/b4-hard`, `gaps/b4-qa`, plus 0069 on `orch/fixes`; closes when on `dashboard-redesign` with green CI and Preview checks |

Batch 3 branches (all merged into `orch/fixes` on 2026-11-04, in this order):
- `gaps/b3-db` (0065): per-fan link-game route and drawer control, lifecycle locks, A11/A12/A17/A35/A44, the 0063 initializer race, observed-wait probes.
- `gaps/b3-app` (0066): A19 seat scopes, A30, A27, A18, A22 per-route limits with capacity eviction and the shared-store flag, A20/A43/A21 dead spin path removed, A29. Integration fixes on `orch/fixes`: the 0065 link-game route throttled (A22), the A36 demo-parity test passes a Request.
- `gaps/b3-ui`: A14, A15, A28, A31, A32, A33, A34, A36, A37, A41, A7/A9/A10 policy text, reveal-timing flake.
- `gaps/b3-ops` (CI, scripts, docs only; no migration):
  - **A25** done-pending-CI: missing TEST secrets fail the `supabase` and `login-ui` jobs; only fork PRs skip, with a warning and a NOT RUN summary (`scripts/ci/supabase-secrets-gate.mjs`, guard `scripts/test/ci-secrets-gate.test.mjs`). Owner: add the TEST trio as Dependabot secrets (OWNER_STEPS 14a).
  - **A39** done-pending-owner-setting: `db-migrations-production` runs on every `main` push and verifies the remote history; Vercel Deployment Checks hold Production until it passes (`docs/GO_LIVE.md` §5, guard `scripts/test/db-before-code.test.mjs`). Not enforced until the owner adds the check in Vercel (OWNER_STEPS 14b). Runtime residual built in 0067 on `gaps/b4-db`: `schema_version()` (service role only, every migration redefines it; guard `src/lib/operations/schemaVersion.test.ts`), flagged as behind/ahead in Admin › System health, failing the manual checks and the maintenance cron, alerted at startup (`docs/GO_LIVE.md` §5).
  - **A38** done (never run against a hosted DB): `scripts/golive/carry-over.mjs`, dry run by default, tested on disposable Postgres (`carry-over.test.mjs`, `carry-over.db.test.mjs`); `docs/GO_LIVE.md` §6.
  - **A40** done: stale references fixed in OWNER_DECISIONS, AGENT_BRIEF, SEC_AUDIT_BRIEF, HANDOFF (§3d closed items, pending audit file), COMPLETENESS_AUDIT (superseded), the `README.md` roadmap and this tracker.
  - Review fixes (2026-11-04): `scripts/ci/verify-migrations-applied.mjs` now parses what CLI 2.122.0 really prints (cells in backticks, "` `" for an absent side, box-drawing variants); the first version rejected every real listing, which would have failed `db-migrations-production` on every push and blocked all promotions. The pure TEST-maintenance guard runs in CI `verify` on every push/PR (it was dispatch-only). Carry-over: a bad percent-escape in a DB URL is a `DB_URL_MALFORMED` refusal, not a crash.

New batch-3 items (2026-10-29):
- A43: remove the dead legacy spin path in `src/lib/data/spins.ts` (below the `commitSpinAttempt` return, ~L270) plus `finalizeInstantSpin` / `reserveRewardCode` / `releaseRewardCode`, which call 0057 RPCs revoked from every role in 0059.
- A44 (lock order): archiving a wheel locks wheel then fans (0059 lifecycle trigger) while play locks fan then wheel, so the two can deadlock. Add a lockRace probe, then fix the order.
- ~~A7 follow-up (batch 3, owner text): Terms and Privacy must mention scratch tickets and personal bingo~~ — **closed** (A49, 2026-11-04): `src/app/terms/page.tsx` (metadata, intro, §1, the "Scratch tickets and bingo are other ways to use a spin" rule) and `src/app/privacy/page.tsx` (intro, "Game cards and tickets") cover both, landed in 8903f22 with `gaps/b3-ui`.
- Flake watch (batch 3): e2e `reveal.mjs` "the reveal is up within 6400ms" missed by 29ms once under load (gaps-1-final round). The budget is `SPIN_MS` 4400 + `MAX_THEATER_EXTRA_MS` 1500 + 500; investigate the budget against the reveal animation timing before widening anything.

Closed early inside 0061: A2 (`expected_stock` compare-and-set), CROSS_TENANT_HAPPY_HOUR, ISSUANCE_IGNORES_SCHEDULE, ACTIVE_ORDER_MISMATCH and the bingo review fixes; the focus-pack grant lock order was fixed in 79239e7.

Done in 0065: per-fan game assignment (a link chooses its own game, not only via its campaign). Runtime schema-version check (A39 residual): built in 0067 on `gaps/b4-db`.

Open items after integrating batch 4 (2026-11-05):
- **Owner decision — a "Start an agency" entry in Settings.** The Agency link shows only for creators who already own an org, hold a seat or belong to one (`showAgencyLink()`); a creator with none of those reaches `/agency` only by URL. Whether Settings should offer "Start an agency" is the owner's call (`OWNER_DECISIONS.md`).
- **Other creator-scoped write routes are not seat-aware** (the list in the "Seat reach" item below): grant edit, pass top-up and fan-link game, fan import, wheel/game saves and the remaining `user.id`-scoped routes. Each needs the A19/A28 pattern (route `creatorId`, seat picker, negative test).
- **`gaps/b4-stress`** merged (8d1e8c3). Its D4 finding (`COMMIT_RESOLVES_WHEEL_PER_STATEMENT`) is fixed by 0070 on `gaps/b5-spinlock`, which also gives the D4/D5/D8 games two prizes under 0069 and turns D4's known-bug lines into hard checks.

Open items found while integrating batch 3 (2026-11-04):
- **A28 residual (agency seats) — integrated from `gaps/b4-seats` (337a304), no migration.** `GET /api/campaigns?creatorId=` (campaigns + that creator's games for the picker), `POST /api/campaigns` and `PATCH`/`DELETE /api/campaigns/[id]` take a `creatorId` resolved by `campaignActingSession()` → `resolveActingCreator(..., 'manage')` (new `SeatJob` `manage`) before any read or write; `campaigns_write` RLS checks `manage` again. The Campaigns tab gets a "Working for" picker fed by `/api/agency/seats?job=manage` (`canManage`). Seat mode hides stats (spins RLS is creator-only), spin packs (`campaign_packs` RLS is creator-only) and the game editor. Negative tests: `src/lib/data/campaignSeats.test.ts`; DB half in `scripts/db/seatScopeProbe.mjs` (manager/owner write, chatter/fulfiller/outsider/suspended/removed refused).
- **Seat reach across other creator-scoped writes (tracker items, not built).** Already seat-aware: inbox (`chat`), fulfilment + queue (`fulfil`), campaigns (`manage`, above); row-derived checks that a `grant`/`edit_wheel` seat passes at the API but has no seat UI: grant edit, pass top-up and fan-link game (`src/lib/data/fans.ts`, `can_act_for(row creator,'grant')` + actor context), fan import (`/api/fans/import` `creatorId`), prize instant delivery (`/api/prizes/[id]/reward`, `edit_wheel`). **Not seat-aware** (caller-only `user.id` scope): games/wheels/prizes editor (`/api/wheels*`, `/api/wheel`, `/api/prizes`; `edit_wheel`), new fan links (`/api/passes`; `grant`), fans list/CRM (`/api/fans`, `/api/crm`; `manage`), boosts (`/api/happy-hours`, `/api/referrals`, `/api/webhooks`, leaderboard settings; `manage`), DM templates, chat settings, autopilot, wishlists, campaign stats (`/api/campaigns/stats`; reads spins, whose RLS is creator-only), campaign packs (`campaign_packs` RLS is creator-only: needs a migration). Each needs the same A19 pattern (acting creator via `resolveActingCreator`, UI picker, negative test).
- **`my_seat_creators()` should return `can_manage`** (next DB migration). Until then `listMySeatCreators({ manage: true })` asks `can_act_for(...,'manage')` per row that holds both chat and fulfil (owners/managers), in batches of 8.
- **A45/A46/A53 (built on `gaps/b4-seats`)**: Agency link in the Account group (sidebar + More sheet), shown only when `showAgencyLink()` (server: owns an org, holds a seat, or `profiles.org_id` set) or in the demo; the invite banner links to /agency after Accept; a managed creator's /agency explains the agency instead of offering "Start your agency"; seat-form and /pending copy explain the approved-account requirement (OWNER_STEPS note, MANUAL-CHECKLIST §20); /agency and the seat workspace restyled with the redesign tokens. **Open:** a creator with no agency tie has no link to `/agency` to *start* one (by the A45 rule); decide whether Settings should offer "Start an agency".

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

## 4. Batch 7 (sixteen audits of 2026-11-10 at `orch/fixes` 64000ec)
Every finding ID from the batch-7 audit summaries (`scratchpad/b7audit/*/SUMMARY.md`). The
status column was filled at the final merge (2026-11-10; builder reports and docs/handoff/batch7/TRIAGE.md); `(builder)` = assigned to a batch-7 builder branch, `(owner)` = a
dashboard setting or decision only the owner can make, `(lawyer)` = a legal question. Severity is
the auditor's. CI / config / docs items (SC, OPS3-12, WU-11, TS-12, the owner checklist and test
script) were built on `gaps/b7-ci`.

| Audit | ID | Finding (one line) | Status |
|---|---|---|---|
| attacker3 | ATK-01 | token-only consent/pause/reveal routes; fan delete has no owed-prize guard (= b6 C1, widened) | built |
| attacker3 | ATK-02 | 30-bit claim code (rate-limited) | built |
| attacker3 | ATK-03 | `'unsafe-inline'` CSP on fan pages | built |
| attacker3 | ATK-04 | fan-miss cap pre-blocks a whole address: one hostile fan on carrier NAT locks real fans out | built |
| attacker3 | ATK-05 | messages/redemptions/grants SELECT policies gate on `view`, not `chat`/`fulfil`/`grant` | built |
| attacker3 | ATK-06 | `org_invite_creator` answers `no_such_user` verbatim with no throttle (account enumeration) | built |
| attacker3 | ATK-nits | uncapped chat_intro/creator_note, no reserved slugs, unlimited creator_applications rows, photo-report budget, IP-keyed account tier | built |
| conc2 | CC-01 | "Reset all my data" multi-row fan delete deadlocks against a Chase commit | built |
| conc2 | CC-02 | commit `unavailable` leaves a pending attempt and `spin_pending` copy forever | built |
| conc2 | CC-03 | `set_redemption_state` / `archive_wheel` / `delete_wheel` / `delete_campaign` check `can_act_for` before the locks only | built |
| conc2 | CC-04 | nothing orders `org_remove_member` against an in-flight grant | built |
| conc2 | CC-05 | `save_wheel_prizes` / `set_prize_delivery` / `add_reward_codes` have no privilege check of their own | built |
| conc2 | CC-06 | `setActiveWheel` is two autocommit statements (transient no-live / two-live games) | built |
| conc2 | CC-07 | `_lock_wheel_lifecycle` pre-locks fans but not passes | built |
| conc2 | CC-08 | pending `spin_attempts` never aged out | built |
| dbaudit | DB-01 | a manager seat can move fans/campaigns between creators of one agency | built |
| dbaudit | DB-02 | applicant writes any e-mail/status/date/200 kB note into `creator_applications` | built |
| dbaudit | DB-03 | no DB length caps on creator free text | built |
| dbaudit | DB-04 | declined access requests never auto-deleted (= OPS-06 / T7) | built |
| dbaudit | DB-05 | direct prize UPDATE via API deadlocks a play | built |
| dbaudit | DB-06 | creator-side fan delete writes no link tombstone (bare 404 for the fan) | built |
| dbaudit | DB-07 | 0052 non-negative CHECKs are dropped-on-warning and may be missing on LIVE | built |
| dbaudit | DB-08 | retention/prune not serialised | built |
| dbaudit | DB-09 | admin can raw-DELETE safety reports | built |
| dbaudit | DB-10 | 0073 candidate C18 confirmed | built |
| dbaudit | DB-11 | 0073 candidate C16 confirmed | built |
| dbaudit | DB-12 | 0073 candidate C15 confirmed | built |
| dbaudit | DB-13 | 0073 candidate C4 confirmed | built |
| dbaudit | DB-14 | drop 19 revoked legacy function shells | built |
| dbaudit | DB-15 | `pg_temp` on ~160 search_paths | built |
| dbaudit | DB-16 | revoke unused I/U/D grants on profiles/spins | built |
| dbaudit | DB-17 | `my_seat_creators.can_manage` | built |
| dbaudit | DB-18 | `prize_reward_codes.spin_id` has no FK | built |
| dbaudit | DB-19 | `legal_terms_upcoming` | built |
| dbaudit | DB-20 | 0072 lock shape at scale | built |
| ops3 | OPS-01 | support@ has no MX record (carried) | (owner) |
| ops3 | OPS3-01 | new code can go live before its 34 migrations; a mistyped Production key passes the build | built |
| ops3 | OPS3-02 | fan reads have no timeouts during a database slowdown | built |
| ops3 | OPS3-03 | merge-day mistake map (docs: GO_LIVE §5 merge-day checklist, one story, required checks) | built |
| ops3 | OPS-06 | declined-request 90-day deletion not automated (carried) | built |
| ops3 | OPS-07 | single admin (carried) | (owner) |
| ops3 | OPS3-04 | maintenance mode pauses set-up pages and the nightly cron (docs: RUNBOOK full list) | built |
| ops3 | OPS3-05 | a transient canary blip silences the nightly heartbeat until a manual run | built |
| ops3 | OPS3-06 | `/verify` and `/leaderboard` answer 404 while the database is down | built |
| ops3 | OPS3-07 | restore recipe not owner-executable, silent about re-issued codes (docs: RUNBOOK restore) | built |
| ops3 | OPS3-08 | failing heartbeat ping / wrong Resend key invisible | built, unit-tested only (lines do not render in the demo) |
| ops3 | OPS3-09 | push devices paused after 5 failures do not resume by themselves (docs: RUNBOOK) | built |
| ops3 | OPS3-10 | nightly job: no maxDuration, no advisory lock, no per-step timeouts | built |
| ops3 | OPS3-11 | startup self-check may freeze mid-flight on serverless | built |
| ops3 | OPS3-12 | 15 doc/code mismatches D1–D15 (DEPLOY, README, ENVIRONMENTS, OWNER_STEPS, RUNBOOK, .env.example, workflow note) | built |
| ops3 | R1–R6 | roadmap: one-click pause, morning summary, health scope, last alert accepted, cron exempt, post-restore SQL (R6 in RUNBOOK) | built |
| perf-a11y | PA-01 | no non-text contrast guard on the creator brand colour (invisible focus rings) | built |
| perf-a11y | PA-02 | wheel spin ~20 fps at 4x CPU (canvas redraw with shadowBlur) | built |
| perf-a11y | PA-03 | `/api/fans` reads every row; 503 at 50 000 rows | partly: profit/ROI/cohorts stay table rows |
| perf-a11y | PA-04 | no announcement during the spin; focus drops to body | built |
| perf-a11y | PA-05 | WCAG 2.2 target size in the game editor (20x13 px buttons) | built |
| perf-a11y | PA-06 | common-rarity grey and brand-on-tint chips below 4.5:1 | built |
| perf-a11y | PA-07 | Games list cuts off "Set active" at 320 px | built |
| perf-a11y | PA-08 | no font preload on `/spin`; unused Geist Mono on the fan page | not built: Next preloads fonts only on prerendered pages |
| perf-a11y | PA-09 | 6 API calls after hydration; inbox fetched twice | built |
| perf-a11y | PA-10 | rarity by colour only | built |
| perf-a11y | PA-11 | 144 uses of 9–11 px text | built |
| perf-a11y | PA-12 | heading order, duplicate Legal landmark, no skip link, `td aria-label` | built |
| perf-a11y | PA-16 | Preview auth buttons white on pink-600 = 3.58:1 | built |
| product | PR-01 | fans have no working contact (= OPS-01) | (owner) |
| product | PR-02 | no front door on the landing page (Apply / FAQ) | partly: home page Request access button; no FAQ |
| product | PR-03 | fans may see "Creator" (C9 still open) | partly: name optional at sign-up, copied at approval |
| product | PR-04 | scratch/bingo admin-gated with no ask path | built |
| product | PR-05 | agency seats cannot run games/fans/boosts | roadmap |
| product | PR-06 | "Start an agency" entry (decision 4) | (owner) |
| product | PR-07 | no CSV export anywhere | built |
| product | PR-08 | no proof / claim code on past wins | built |
| product | PR-09 | fans have no notifications | roadmap |
| product | PR-10 | no delivery promise or overdue nudge | built |
| product | PR-11 | fans list has no sort | built |
| product | PR-12 | no bulk actions; import cannot top up | roadmap |
| product | PR-13 | no per-link off switch or expiry | built |
| product | PR-14 | one-off schedules | roadmap |
| product | PR-15 | webhooks win-only (no test fire) | built |
| product | PR-16 | no analytics range / export | roadmap |
| product | PR-17 | bingo draft save (0073) | built |
| product | PR-18 | no fan offline page | not built: fan pages deliberately have no service worker (RM-4); in-page offline handling instead |
| product | PR-19 | demo `https://#` CTA on `/c` | built |
| product | PR-20 | English only | roadmap |
| review-dash | RD-01 | failed GET of Public page / auto-messages shows an empty form with Save enabled | built |
| review-dash | RD-02 | `/agency` shows "Start your agency" to an existing owner on a failed read | built |
| review-dash | RD-03 | Admin shows "No creator accounts yet." on a failed read | built |
| review-dash | RD-04 | seat workspace vanishes silently on a failed seat read | built |
| review-dash | RD-05 | a plain 400 on New fan link locks the form until "Cancel uncompleted request" | built |
| review-dash | RD-06 | due date PATCHes on every keystroke; year 0002 accepted | built |
| review-dash | RD-07 | campaign "Pending" never drops after a cancelled win | built |
| review-dash | RD-08 | Today header shows the server's UTC date | built |
| review-dash | RD-09 | failed `/api/account` read shown as loaded defaults | built |
| review-dash | RD-10 | "couldn't confirm" wording for definitive refusals | built |
| review-dash | RD-11 | thread poll refreshes the overview every 6 s | built |
| review-dash | RD-12 | Enter mid-IME | built |
| review-dash | RD-13 | campaign filter by name | built |
| review-dash | RD-14 | autopilot dismiss unhandled | built |
| review-dash | RD-15 | webhook copy has no fallback | built |
| review-dash | RD-16 | template refetch race | built |
| review-dash | RD-17 | label/name limit mismatch | built |
| review-dash | RD-18 | happy-hour multiplier pills | built |
| review-dash | RD-19 | 500-message thread cap | built |
| review-dash | RD-20 | "last 200 wins" unlabelled | built |
| review-dash | RD-21 | nested button in toasts | built |
| review-fan | RF-01 | wheel lands by stale index after the creator edits prizes | built |
| review-fan | RF-02 | game-kind switch mid-session dead-ends in "cannot check" | built |
| review-fan | RF-03 | top-up never shows on an open page (state not re-synced) | built |
| review-fan | RF-04 | `crypto.randomUUID` / `Object.hasOwn` / `.at()` without fallbacks | built |
| review-fan | RF-05 | report form network error is an unhandled rejection | built |
| review-fan | RF-06 | every refused spin = 3 taps; needs_ack gate reopens | built |
| review-fan | RF-07 | offline copy says "still being checked" | built |
| review-fan | RF-08 | `text-base` compiles to a colour | built |
| review-fan | RF-09 | Prize book "0% chance" for rare odds | built |
| review-fan | RF-10 | UTC delivery date | built |
| review-fan | RF-11 | 340 px SSR wheel on 320 px phones | built |
| review-fan | RF-12 | mute mid-spin stale closure | built |
| review-fan | RF-13 | device-clock countdowns | built |
| review-fan | RF-14 | backdrop tap closes the win card | built |
| review-fan | RF-15 | wishlist by label, not prize id | built |
| review-fan | RF-16 | "Checking…" pill during a decline | built |
| review-server | RS-01 | `/api/spin/status` answers 503, never 404, for an unknown token | built |
| review-server | RS-02 | `/api/spin` maps `db_error`/`unavailable`/`spin_pending`/`unauthorized` to 409 | built |
| review-server | RS-03 | server-error alert e-mails never sent (`after()` outside a request) | built; Vercel keep-alive for the inline capture unproven locally |
| review-server | RS-04 | route JSON without explicit Cache-Control | built |
| review-server | RS-05 | no `maxDuration` on the maintenance cron | built |
| review-server | RS-06 | Upstash outage: no circuit breaker | built |
| review-server | RS-07 | `.env.example` / DEPLOY.md miss four variables | built |
| review-server | RS-08 | Upstash URL with a trailing slash falls back forever | built |
| review-server | RS-09 | `Secure`-flag derivation on multi-hop proxies | built |
| review-server | RS-10 | `/auth/signout` has no origin check | built |
| review-server | RS-11 | admin routes unthrottled | built |
| review-server | RS-12 | startup checks per cold start | built |
| review-server | RS-13 | dead-link recovery copy | built |
| review-server | RS-14 | deeper health probe | built |
| supply2 | SC-01 | DB-before-code unenforced until the Deployment Check; no backup before `db push` | built |
| supply2 | SC-02 | account token and VERCEL_TOKEN reachable from any branch via the `test` environment; PR #42 stale | built |
| supply2 | SC-03 | Dependabot alerts / PVR off; no cooldown; no security contact | built |
| supply2 | SC-04 | Vercel Preview builds were a hand-maintained deny-list | built |
| supply2 | SC-05 | one abandoned migration PR blocks every other PR's required checks on TEST | built |
| supply2 | SC-06 | no `timeout-minutes` on lock-holding jobs | built |
| supply2 | SC-07 | Dependabot and fork PRs always show a red migration check | built |
| supply2 | SC-08 | Supabase CLI pin one patch behind | built |
| supply2 | SC-09 | env-var inventory and go-live docs disagree with the code | built |
| supply2 | SC-10 | hygiene: tracked `reviews/`, tarballs, stale archive doc, no LICENSE | built |
| supply2 | SC-11 | dependency currency | built |
| supply2 | SC-12 | `ci.yml` has no concurrency group | built |
| supply2 | SC-13 | login-UI failure screenshot uploaded as an artifact on a public repository | not built (roadmap) |
| supply2 | SC-14 | stable Preview deploy from an agent's machine, not a reviewed workflow | not built (roadmap) |
| supply2 | SC-15 | RUNBOOK notes on concurrency/timeouts and a dirty TEST history | built |
| trust2 | TS-01 | Terms/Privacy text edited after version 2026-10-27; re-consent never fires | built |
| trust2 | TS-02 | fan-facing pay-for-chance copy survives | built |
| trust2 | TS-03 | "FanFunnel Support" / "admin" accepted as names (no reserved words) | built |
| trust2 | TS-04 | no URL/phone/slur screening on public text; label cap mismatch | partly: public-text rule on every public field; chat flags not stored |
| trust2 | TS-05 | consent stampable by whoever holds the token (C1) | built |
| trust2 | TS-06 | 30-day change-notice promise has no mechanism | built |
| trust2 | TS-07 | team replies shown as the creator, no disclosure | built, label switched off until the owner decides |
| trust2 | TS-08 | report reason free text, not restricted to `REPORT_REASONS` | built |
| trust2 | TS-09 | Privacy page omits `ff-auth-redirect-at` and push processors | built |
| trust2 | TS-10 | wheel-only wording for scratch/bingo fans | built |
| trust2 | TS-11 | raw provider error text on the sign-in form | built |
| trust2 | TS-12 | child-safety / law-enforcement procedure (docs: RUNBOOK) | built |
| trust2 | TS-13 | fan export omits tip amounts and blocked state | built |
| trust2 | TS-14 | gated content rendered under the age overlay | built |
| trust2 | TS-15 | "free for now" | built |
| trust2 | TS-16 | creator-side "Revenue" / "Spins bought" vocabulary | built |
| trust2 | TS-17 | no reversible fan mute | built (fan mute) |
| trust2 | TS-18 | prize-label cap disagreement | built |
| trust2 | TS-19 | message retention undefined | built |
| trust2 | TS-20 | detailed push titles include the fan's name | not built |
| trust2 | TS-21 | board handle similarity to a creator's name | partly: look-alikes refused; similarity to other names needs a lookup |
| trust2 | TS-22 | plain-language summary on the verify page | not built |
| trust2 | TS-23 | admin cannot see report detail without the full chat | not built |
| trust2 | TS-24 | accessibility statement page | not built (accessibility statement page) |
| trust2 | C1–C18 | copy table rows | built |
| trust2 | Q17–Q26 | lawyer questions | (lawyer) |
| walk-agency-admin | WG-01 | suspended creator loops on a blank sign-in form (= WU-01) | built |
| walk-agency-admin | WG-02 | agency owner gets no seat row from `org_create` | built |
| walk-agency-admin | WG-03 | staff seated by two agencies see "Start your agency"; cannot leave | built |
| walk-agency-admin | WG-04 | owner close / admin delete dissolves the agency silently | built |
| walk-agency-admin | WG-05 | invite consent: one tap, no owner identity | built |
| walk-agency-admin | WG-06 | "they'll get an e-mail" shown when none is sent; expired invites vanish | built |
| walk-agency-admin | WG-07 | seat replies/fulfilments unattributed, no agency audit | built |
| walk-agency-admin | WG-08 | seat "Mark fulfilled" one tap, no undo | built |
| walk-agency-admin | WG-09 | admin has no view of agencies | built |
| walk-agency-admin | WG-10 | admins can read all fan chats via RLS, unaudited (T14) | built |
| walk-agency-admin | WG-11 | rejected applicant cannot edit / re-apply | built |
| walk-agency-admin | WG-12 | approve / reactivate / demote one tap | built |
| walk-agency-admin | WG-13 | owner suspension freezes the agency mutely | built |
| walk-agency-admin | WG-14 | stale seat scopes re-apply on re-invite | built |
| walk-agency-admin | WG-15 | New-account name error generic | built |
| walk-agency-admin | WG-16 | no sign-out of other devices | built |
| walk-agency-admin | WG-17 | UTC "today" / unlabelled zones | built |
| walk-agency-admin | WG-18 | admin list search / paging gaps | built |
| walk-agency-admin | WG-19 | "Revenue $0.00" for scoped seats | built |
| walk-anon | WA-01 | support@ has no MX (= OPS-01) | (owner) |
| walk-anon | WA-02 | dead/paused/mistyped `/spin`, `/share`, `/verify`, `/c` links are blank until JavaScript runs | built |
| walk-anon | WA-03 | every anonymous Preview view POSTs a "CSP blocked vercel.live" error | built |
| walk-anon | WA-04 | share OG image answers 200 for any id, no rate limit | built |
| walk-anon | WA-05 | auth e-mail links consumed by a plain GET (= WU-02) | built |
| walk-anon | WA-06 | public pages link the dashboard manifest | partly: 404, Terms and Privacy still link the manifest |
| walk-anon | WA-07 | root marketing title on auth/fan pages | built |
| walk-anon | WA-08 | backslash paths 500 on Vercel | partly: guard targets Vercel's router; `next start` redirects first |
| walk-anon | WA-09 | `/api/cron/retention` reveals `not_configured` to anyone | built |
| walk-anon | WA-10 | `/api/me` Cache-Control public | built |
| walk-anon | WA-11 | share/verify/leaderboard have no `noindex` meta | built |
| walk-anon | WA-12 | 20 px mode-toggle tap targets on sign-in | built |
| walk-anon | WA-13 | no OG/Twitter card on `/`, no image on `/c` | built: home link-preview metadata |
| walk-anon | WA-14 | home page says nothing to fans; "Request access" hard to find | partly: home copy unchanged |
| walk-anon | WA-15 | dark-only | roadmap (light theme) |
| walk-anon | WA-16 | `/maintenance` always reachable | built |
| walk-anon | WA-17 | `security.txt` Canonical / Policy | built |
| walk-anon | WA-18 | no sitemap / canonical | built: /sitemap.xml on Production |
| walk-auth | WU-01 | suspended creator: blank sign-in form, loop | built |
| walk-auth | WU-02 | e-mail links consumed by link scanners (verify on GET) | built |
| walk-auth | WU-03 | failed-link page and templates give "same browser" advice; expired invites dead-end | built |
| walk-auth | WU-04 | secure e-mail change first link treated as done | built |
| walk-auth | WU-05 | forgot/resend show "check your inbox" on 429 | built |
| walk-auth | WU-06 | `/reset-password` lets any signed-in session change the password | built |
| walk-auth | WU-07 | two-factor creator's reset may fail with raw `insufficient_aal` | built |
| walk-auth | WU-08 | Settings password error says "8 characters" when the rule is letter+digit | built |
| walk-auth | WU-09 | no show-password / confirm field | built |
| walk-auth | WU-10 | "confirm your email first" has no resend action | built |
| walk-auth | WU-11 | OWNER_STEPS lacked the Supabase e-mail settings (docs: Stage 2) | built |
| walk-auth | WU-12–WU-20 | admin-claim card for creators, page titles, `/mfa` "Not now", raw provider messages, field names, focus, dead `/signup` matcher, old look, no "sign out everywhere" | built except WU-19 (restyle, not built) |
| walk-creator | WC-01 | empty handle mints a fan "Fan" with a live link | built |
| walk-creator | WC-02 | minted-link card scrolls off-screen on phones | built |
| walk-creator | WC-03 | "Set active" goes live instantly, no confirm/undo | built |
| walk-creator | WC-04 | raw Supabase "Error sending confirmation email" on sign-up | built |
| walk-creator | WC-05 | fan sheet from the queue closes into Fans | built |
| walk-creator | WC-06 | Start / Mark fulfilled give no toast or undo | built |
| walk-creator | WC-07 | "Request access" only creates a login; the request is a second form | partly: three honest steps, not one screen |
| walk-creator | WC-08 | `/signup` is a fan-worded 404; `?mode=signup` ignored | built |
| walk-creator | WC-09 | "Create game" persists empty games | partly: notice + Remove, not create-on-save |
| walk-creator | WC-10 | default names "New wheel" / "New prize" reach fans | built |
| walk-creator | WC-11 | bingo draft unsaveable until complete | built |
| walk-creator | WC-12 | agency invite banner omits who / what they see | built |
| walk-creator | WC-13 | suspended creator's fan page still live | built |
| walk-creator | WC-14 | dashboard dark-only | roadmap (light theme) |
| walk-creator | WC-15–WC-30 | polish: reorder buttons, toasts over the Save bar, focus on invalid save, field errors, discard dialog, jargon, term drift, first-steps order, Share, time-zone hint, "a Uncommon", busy states, headings, small targets, push copy, handle rename | built except WC-20 (Mint→Create: owner decision) and WC-21 glossary (not built) |
| walk-fan | WF-01 | the claim code lives only on the win card | built |
| walk-fan | WF-02 | page jumps mid-page after the age gate on short phones | built |
| walk-fan | WF-03 | 120 bad links from one IP lock every fan on that IP out (= ATK-04) | built |
| walk-fan | WF-04 | sold-out prizes read "Claimed ✨" | built |
| walk-fan | WF-05 | leaderboard 429 is raw JSON | built |
| walk-fan | WF-06 | an open page never learns of a top-up (= RF-03) | built |
| walk-fan | WF-07 | no in-app browser hint | built |
| walk-fan | WF-08 | tap targets < 44 px | built |
| walk-fan | WF-09 | second tab re-pops the same win card | built |
| walk-fan | WF-10 | "send it to your creator" with the Message FAB hidden | built |
| walk-fan | WF-11 | Terms from the gate opens a new tab with no way back (FD-19) | built |
| walk-fan | WF-12 | "a Uncommon prize" | built |
| walk-fan | WF-13 | "40.404% chance" | built |
| walk-fan | WF-14 | "Add Spins to your home screen" | built |
| walk-fan | WF-15 | "Visit glow … 1 of the last 7 days" on first visit | built |
| walk-fan | WF-16 | no H2s, silent wheel live region | built |
| walk-fan | WF-17 | claim code in the verify URL | built |

Owner questions collected from the sixteen reports are items 39–48 of `OWNER_STEPS.md` Stage 9;
lawyer questions Q17–Q26 belong in `docs/LAWYER_QUESTIONS.md` (trust builder).
