# Takeover checkpoint — 2026-10-29

Read this, `AGENTS.md`, `HANDOFF.md`, then the artifact index before making changes.
The owner requested a committed, portable stopping point before the usage
allowance runs out. Usage percentage is not exposed to the agent; no reset time
or automatic continuation is promised. Resume the existing objective: finish
all roadmap items safely on `dashboard-redesign`, draft PR #78, never `main`.

## Current hosted state: TEST is under repair

- Remote integration head at preparation: `6e830472b213874aeac1a40cd0bb3e1116de3c5e`.
  Use `git rev-parse HEAD`, `git status --short` and `git ls-remote origin
  refs/heads/dashboard-redesign` to distinguish the local checkpoint from remote.
- TEST project: `snmcrmhgevfqggxdiomu`, migrations 0001–0059 applied.
- **Forbidden production project:** `ttlogfmogcccwiraaoae`. Never write to it,
  deploy Production, push/merge `main`, or change a Production alias.
- Last fully released Preview code: `540f018215fd8b12574ef815ebb975110b5e5361`
  (0058). Stable URL:
  https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
- **No 0059 Preview has been deployed.** Old 0058 code is not certified compatible
  with today's 0059 TEST schema. The owner must not be told TEST is ready for
  acceptance until the repair, hosted tests and matching Preview release pass.
- Exact `6e83047` CI: [CI passed](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40782622342),
  [migration/history/generated types passed](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40782622894),
  [real login passed](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40782622404),
  [real runtime failed](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40782622348).
  Runtime result: **19/20**, durable fixture grant fails with
  `function digest(text, unknown) does not exist`.

## Repair in this checkpoint

The hosted pgcrypto extension is in `extensions`; the old local fixture put it
in `public`, hiding the failure. Fifteen direct-crypto 0059 SECURITY DEFINER
functions now use `search_path=public,extensions,pg_temp`, with their bodies,
authorization, random derivation, grants and owners unchanged. All three SQL
source/mirror files agree. Local drift verification now defaults to the hosted
layout and also supports `--crypto-schema public` for legacy coverage.

Editing an already-applied migration does **not** replay it on TEST. The TEST
PR workflow invokes `scripts/db/repair-test-crypto-0059.mjs` after `db push`.
This is a one-time, fixed-TEST, configuration-only correction with exact source,
history, namespace, body, owner, signature, ACL and current-config guards. It
checks all 15 functions before alteration, applies one transaction, then performs
an independent readback. It cannot target Production and does not modify table
data or migration history. The Production workflow job is unchanged.

**The hosted correction has not run at this checkpoint.** Its HTTP protocol is
deliberately strict: Management API HTTP 201 and an empty JSON array acknowledge
the transaction; a separate 201 readback must verify every invariant. A timeout
or unexpected acknowledgement is an **unknown outcome**, not proof of rollback.
Do not automatically retry a mutation. Use the helper's guarded `--read-only`
mode through an authorized TEST workflow to establish the actual state first.
Never print credentials or bypass the helper's guards.

**Retire only the workflow invocation and its two comments when integrating
0060, before that feature's first verification.** Keep the helper, manifest and
regressions. Later migrations replace function bodies, so its exact 0059 guards
must refuse them. The portable inputs include the precise retirement patch.

UI repair scope includes explicit-only instant reward history loading, the
shared F6 engagement gate on leaderboard/ticker rendering, withdrawal-only
leaderboard privacy controls even when engagement is suppressed or the public
board is unavailable, and a transform-only entrance for the controls whose
opacity animation temporarily failed contrast. Remaining-game controller changes
must be mapped to `FanGameController`; 0060 intentionally replaces `SpinClient`
with a thin wrapper. Never copy an entire newer game's controller into 0060.

An additional actual data-layer reproduction found that archiving every wheel
left fans publicly listed but prevented withdrawal. Pausing a link also made
the old active-pass resolver refuse withdrawal. This checkpoint corrects both:
`privacy.ts` now provides a false-only withdrawal using its existing known-token
download/delete contract, including inactive links. `boosts.ts` delegates only
literal `optIn === false` to it. The write changes only `leaderboard_opt_in:false`
and filters by **both** the token-derived fan ID and creator ID. It never changes
a handle, balance, wheel, link state or joining permission. Unknown/deleted tokens
and database errors fail closed. The mock also refuses joining after self-exclusion.

The existing 404 `LinkDataRescue` panel offers the same explicit withdrawal
control beside download/delete. Opening it performs no public leaderboard read
or automatic POST; its generic responses do not expose a fan's identity or consent.
The existing page status and discovery button label stay unchanged. Malformed
pathname decoding is guarded. No table, route, RPC or dependency was added.
Focused verification passed **63 actual real/mock data cases and 19 rescue UI
cases**, including cross-creator refusal, false-only writes, errors/retry and
preserving paid balances/history. The original 72/35/38/28 UI cases are byte-exact.

Authorization evidence: `src/lib/data/privacy.ts` (`resolveAnyToken` and
`withdrawFanLeaderboardConsent`), `src/lib/data/boosts.ts` (`optIn === false`),
`src/lib/supabase/server.ts` (server-only `createServiceClient`), and
`src/lib/data/leaderboardWithdrawal.test.ts` (actual negative authorization cases).
No role is read from user-editable metadata; no service key enters a client module.

## Verification boundaries

At `9642dfd4d24518c201f736f93387443e43d80a8f`, two complete local rounds genuinely
passed: 200 unit files, 163 browser steps, 103 axe states, 40 recursive MJS syntax
checks and 1376 catalog objects in the then-public-layout drift fixture. The
follow-up `6e83047` only changed declaration layout to match the hosted type
generator; a complete TypeScript AST equality proof, lint and typecheck passed.

**Those passes do not certify the changed repair source in this checkpoint.**
Before pushing it, repeat the complete verification twice from a clean commit.
The earlier repair diagnostics separately passed 46 transport/guard cases,
76 native config-only repair cases under a non-superuser owner, both complete
drift/RLS matrices, 28 actual-component history cases, 35 engagement admission
cases, 72 withdrawal lifecycle cases and 38 existing recovery cases. Preserve those tests and all original
assertions; run the current complete tree, not just these focused checks.

The superseded `15a1e305a359d858a16205d6ba87773629eb8c4f` repair subsequently
passed installation, lint, types, both complete drift layouts, 43 MJS syntax
checks, all 204 unit files, the debug build and all 163 browser steps with zero
signals. Its axe run was intentionally interrupted when the backend privacy gap
above was confirmed. **It is not a completed full round.** Preserve that history;
restart both full rounds on the final source that includes the six-path repair.

One isolated Bingo diagnostic passed all 174 functional steps with zero browser
signals after history/F6 fixes and corrected fixture admission pacing, but its
same-server axe run found a real transient contrast failure. That is a preserved
failure, not a full release pass. The seeded Bingo helper's separately approved
2500 ms spacing produces at most 48 board reads/minute under the unchanged
60/minute/IP limit. It must not change quotas, fixtures, RNG, assertions or
error handling. The isolated transform-only repair subsequently passed a fresh
install/build, all eight Scratch axe states and immediate/settled desktop and
phone checks; all 319 sampled animation frames retained full opacity. That is
focused repair evidence, not an integrated release pass.

For each of two rounds, run and save actual exit codes/output:

```sh
npm ci
npm run lint
npm run typecheck
npm test
NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build
PG_BIN=/path/to/postgresql-16/bin node scripts/db/schema-drift-check.mjs
PG_BIN=/path/to/postgresql-16/bin node scripts/db/schema-drift-check.mjs --crypto-schema public
```

Recursively run `node --check` on **every** `.mjs` under `e2e/` and `scripts/`.
Start a fresh debug-build demo server with real Supabase variables unset and a
fresh disposable VAPID keypair (positive push coverage); never use deployed
private keys. Run `npm run e2e`, then `npm run e2e:a11y` against that **same**
server. Require no journey crash, no ignored browser signals and no blocking
axe violations. Stop that server and repeat from installation on another fresh
server. Require unchanged HEAD and clean worktree at both ends of each round.
Interrupted runs do not count; preserve failed/interrupted logs separately.

Only after both rounds pass:

1. Push exclusively `HEAD:dashboard-redesign`. Confirm all required CI jobs for
   that exact SHA, actual TEST 0059 history/types, full real runtime negatives
   and real login. A skipped job is not a pass. Inspect the one-time repair's
   readback rather than assuming edited SQL changed the hosted database.
2. Follow `docs/PREVIEW_DEPLOY.md`. Deploy a tracked archive of the checked SHA,
   explicitly targeting Preview, after TEST and CI pass. Never deploy a dirty
   checkout or use `--prod`. Confirm project, owner, source SHA and Preview
   target; exercise actual public/mobile pages and relevant authenticated flows.
3. Only then update the stable Preview alias, verify it again and update this
   handoff with exact source/deployment IDs and results. Keep Production intact.

## Recoverable remaining work

The [source-only capsule and index](./artifacts/INDEX.md) preserve unfinished
work independently of `/workspace/.tools`. Hash-check and reconstruct outside
the checkout before applying anything. The frozen originals are **inputs**, not
new release approvals. Rebase their deltas onto the repaired common source,
retain all tests and previous mirror prefixes, and establish new source hashes.

Root independently extracted the final archive, verified all 392 checksummed
members, applied all six historical patches and matched every complete tree
(94/81/67/34/7/36 changed paths). Archive SHA-256:
`3b5086bd9fc5fd2426ab4f7ddd830f52153649182020905a5719cba5c2c9b1b1`.
This proves recoverability of the original preparations, not their integration.
The portable `restore_historical.py` works without `.tools`. The preserved
unfinished composition builder still needs path adaptation and reviewed
descriptor normalization: its optional privacy parser expects snake_case hashes,
whereas the immutable privacy manifest has `beforeSha256` / `afterSha256` and a
separate mapped object. Normalize a derived descriptor; do not edit the original
hashed manifest or run that unfinished builder blindly.

Release order is strictly: repaired **0059 → 0060 scratch → 0061 bingo → 0062
account security → 0063 ledger operations → code-only small fixes → final audit**.
Each feature needs the same two full local rounds and exact hosted/Preview gates.
Do not push unfinished features to a different branch to preserve them: other
branches may automatically deploy against the shared TEST database.

Before 0063's first CI/Preview, include its explicit seven-path safety overlay:
CI secret scope, startup health isolation and actual legacy-secret byte counts.
It prevents CI-local missing keys from poisoning hosted health and establishes
the real post-cleanup TEST state before the first 0063 boot. Counts do not
validate encryption keys. Never initialize the crypto anchor from synthetic
evidence or data erased only to obtain a clean result.

Final hardening adds an exact development `tsx@4.23.15` dependency to make tests
reproducible; state this reason to the owner when integrating it. Update/test the
cloud installer to prefer and validate that declared local CLI; the old external
symlink fallback must not overwrite it. Do not publish cloud settings during
active work because environment restart interrupts verification.

Two **fresh independent** final security audits, the privacy-promise check and
outside-attacker pass per `SEC_AUDIT_BRIEF.md` remain outstanding. Old feature
reviews are not substitutes. Fix all Critical/High issues, then obtain owner
Preview acceptance. Never merge to `main` autonomously.

## Owner/provider work still pending

The existing GitHub Actions secrets already support TEST migration/runtime/login
checks; do not ask the owner to reconnect Supabase to repair 0059. Vercel CLI
authentication was verified. Credentials and local tooling may need secure
reconnection in a new environment; never copy private credential files into Git.

Repository Secrets API access returned 403 even though normal Git/Actions access
works. Later metadata/performance/scheduler checks need a short-lived, scoped
`VERCEL_TOKEN` and matching Sensitive Preview `CRON_SECRET` /
`FANFUNNEL_TEST_CRON_SECRET` through secure provider forms. Do not reuse or paste
the CLI's token, and never ask for keys in chat. Earlier owner questions about
these settings were unanswered; elapsed time is not approval or completion.

Other pending acceptance evidence: owner-controlled original reward-key backup
and TEST restore drill; second-admin recovery; TEST Site URL/redirect settings;
branded reset/email-change delivery and return flow; installed iPhone/Android
push; alert receipt; and manual business acceptance. Sending real emails needs
explicit authorization. TEST daily cleanup is **not yet active/proven**; proposed
04:17 UTC scheduling is not evidence of actual successful HTTP/app cleanup.

Old Preview URLs may still be reachable after an alias change. Refresh the
inventory and present a concrete retirement list for owner approval before
deleting anything; preserve current Preview, all Production deployments, Git
and database data. Account for in-flight function execution before reconciling
legacy-secret counts. Do not retire deployments merely because they are old.

The owner enabled admin 2FA before 0054. All admins need an enrolled factor and
an AAL2 session for admin access; do not re-run onboarding or request authenticator
codes in chat. Give any owner steps one at a time with full clickable links.
