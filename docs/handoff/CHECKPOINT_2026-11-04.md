# Checkpoint — 2026-11-04 (batch 3 integrated on `orch/fixes`)

Everything below is committed and pushed to `origin/orch/fixes`. `main`,
`dashboard-redesign`, Production and both Supabase projects are untouched.
The TEST database is still at migration **0061**. Nothing has been pushed to
`dashboard-redesign`; that step still waits for the owner's explicit "go".

## What is where

| Branch | Base | State | Verified |
|---|---|---|---|
| `dashboard-redesign` (PR #78) | — | unchanged since 2026-10-31 (8bf5c4c): 0060 scratch, 0061 bingo, game-switching UX | Yes (CI, Preview) |
| `orch/fixes` | 8bf5c4c | 0062 account security, 0063 operational integrity, 0064 gaps batch 1, final hardening, **and now batch 3**: 0065 per-fan game pins + DB hardening (`gaps/b3-db`), 0066 seat scopes / approval notice / alert release (`gaps/b3-app`), batch-3 UI (`gaps/b3-ui`), batch-3 ops (`gaps/b3-ops`) | **Yes**: two full consecutive local rounds at **7bea8ac** (numbers below); this checkpoint commit is docs-only on top of it |

Merge order and commits on `orch/fixes` (all `--no-ff`, after 2fff69c):

1. 4a49139 merge `gaps/b3-db` (f3fce0a) — clean.
2. 43e4840 merge `gaps/b3-app` (7836c4e) — conflicts in both SQL snapshots
   (0065 and 0066 each appended), the drift-check probe wiring and the
   anon-setters allowlist. Snapshots rebuilt as the 0065 snapshot plus
   b3-app's exact 0066 segment; both tails are byte-equal to the migration
   files. 0065 and 0066 define disjoint objects (no function, table, policy,
   trigger, index or grant is touched by both; 0066 redefines the 0064
   queue/inbox functions, which 0065 never changed, and reads no 0065 column).
   04ebf02 throttles the 0065 link-game route (A22 guard caught it).
3. 2a0f979 merge `gaps/b3-ui` (7b3c057) — conflicts in the game-switching
   journey (per-fan pin steps before the A28 archive step), the agency and
   autopilot routes (A22 limiter before the A36 demo short-circuit), the
   redemptions route (A19 seat scope with A14's `errorResponse`), `getFanPass`
   (A41 parallel reads on A21's no-fallback semantics) and the policy test.
   aa6f477 hands the A36 demo-parity test a Request.
4. c73dd44 merge `gaps/b3-ops` (7ba4f03) — clean. 7bea8ac reconciles
   GO_LIVE (migrations 0001–0066; shared rate-limit store and Production
   `CRON_SECRET` / `REWARD_ENCRYPTION_KEY` / `REWARD_CODE_FINGERPRINT_KEY`
   marked required; `schema_version()` moves to a 0067 follow-up) and the
   tracker.

The interplay fixture was **not** regenerated: strict interplay passes on the
combination as the branches left it (1010 checks), so combined behaviour did
not change.

## Verification (two consecutive clean rounds at 7bea8ac, fresh server each)

Script: scratchpad `orch-b3/verify.sh`, port 3271, logs under
`orch-b3/round1` and `orch-b3/round2`.

| Check | Round 1 | Round 2 |
|---|---|---|
| lint / typecheck | ok / ok | ok / ok |
| `npm test` | 282/282 files | 282/282 files |
| `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build` | ok | ok |
| schema drift (default + `--crypto-schema public`) | ALL PASS ×2 | ALL PASS ×2 |
| interplay `INTERPLAY_STRICT=1` | 1010 checks | 1010 checks |
| `node --check` (e2e + scripts `.mjs`) | 89 files | 89 files |
| ops tests (`scripts/ops/*.test.mjs`) | 54 DB + 49 pure | 54 DB + 49 pure |
| script tests (ci-secrets-gate, db-before-code, carry-over, carry-over.db) | 48 + 45 + 71 + 52 | 48 + 45 + 71 + 52 |
| e2e (`npm run e2e`) | 197/197 steps, 0 signals | 197/197 steps, 0 signals |
| a11y (`npm run e2e:a11y`) | 134 states, 0 blocking | 134 states, 0 blocking |

## Open from this integration

- **A28 residual (agency seats)** — recorded in `MASTER_TRACKER.md` §2:
  campaign archive/rename/pin and `listCampaigns` are `user.id`-scoped, so a
  seat with `can_act_for(creator, 'manage')` gets 404. Not a security gap; a
  proper fix needs the A19 pattern end to end (list + route `creatorId`, seat
  picker, negative test), so it was not done inside this integration.

## To resume

1. With the owner's explicit "go": push `orch/fixes` to `dashboard-redesign`.
   CI applies 0062–0066 to TEST (DB before code), then deploy that exact SHA
   to the stable Preview. After 0062 an admin with an enrolled authenticator
   must enter its code for dashboard access.
2. Then: stress round (A26 + load), two independent security audits, final
   re-audit, owner steps (push on installed phone, key backup + restore drill,
   second admin, email checks), owner acceptance, LIVE release per GO_LIVE.

## Waiting on the owner

- Results of the four Preview tests from the 2026-10-31 checkpoint.
- "Go" to push 0062–0066 + batch 3 to TEST and the Preview.
- Production env still lacks `REWARD_ENCRYPTION_KEY`,
  `REWARD_CODE_FINGERPRINT_KEY` and `CRON_SECRET` (GO_LIVE §4).
