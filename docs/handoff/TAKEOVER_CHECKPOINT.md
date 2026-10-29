# Takeover checkpoint — 2026-10-29

Read this, `AGENTS.md`, `HANDOFF.md`, then the artifact index before making changes.
The owner requested a committed, portable stopping point before the usage
allowance runs out. Usage percentage is not exposed to the agent; no reset time
or automatic continuation is promised. Resume the existing objective: finish
all roadmap items safely on `dashboard-redesign`, draft PR #78, never `main`.

## Verified TEST release and resume point

- **Application release:** `5f72680e4bf621cf205867b94975eb2c2f3fc428`.
  The following handoff-only commit changes documentation/artifacts. Application
  blobs and modes must remain identical to this checked release. Use Git to
  distinguish current documentation HEAD from the deployed application SHA.
- **Stable TEST Preview:**
  https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
- **Immutable checked deployment:**
  https://fanfunnel-nn6d8msjd-easy-simple-sites.vercel.app
  (`dpl_H7vbgELEePxdAg9spTfK8RLkxK9e`, explicitly Preview).
- TEST `snmcrmhgevfqggxdiomu`: migrations 0001–0059 applied. The actual correction
  independently verified all 15 crypto functions on trusted paths, preserving
  bodies, ACLs and owners.
- **All exact-application-SHA CI passed:** [main CI](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40797440851),
  [migrations/history/exact types](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40797440837),
  [real runtime](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40797440838),
  [real login](https://github.com/Guhlores-Team/fanfunnel/actions/runs/40797440864).
  Actual results: integration **20/20**, spin integrity **8/8**, RLS runtime
  negatives passed, real login **6/6**. No required-secret skip was accepted.
- **Two full local rounds passed** on that unchanged clean application commit:
  each 206 unit files, 163 browser steps/zero signals, 103 axe states/zero blocking
  violations, 43 MJS syntax checks and both complete PostgreSQL 16 layouts
  (1340 extension-layout / 1376 public-layout catalog entries).
- Seven hosted HTTP checks and four public mobile-layout interactions passed.
  Twelve public landing/login chunks contained the TEST URL and no Production
  URL or server-credential pattern. This was Chromium at 390×844; authenticated
  feature acceptance, installed-phone push and the comprehensive final security
  audit remain outstanding. Browser functional checks used the managed proxy
  with certificate errors ignored; curl retained normal TLS verification. This
  is not a TLS audit.
- Stable alias and public script identity were rechecked after promotion; the
  remote branch still matched the application release at promotion.
- **Production is untouched:** forbidden database `ttlogfmogcccwiraaoae`;
  Production alias remained `dpl_D5nQpT4e5qVXhTqHWEae2gCyzR1W`. Never push/merge
  `main`, write Production Supabase or deploy Production.
- **Next work is 0060 scratch**, using the repaired-common portable candidate.
  No 0060+ migration or feature has been released. Retire the one-time 0059 TEST
  workflow invocation with 0060 before verification; keep helper and tests.

The sanitized [release receipt](./RELEASE_CHECKPOINT.json) records actual source,
CI, database and deployment evidence. Earlier `6e83047` really failed runtime
19/20 (`digest(text, unknown)` missing); this release corrects that failure.
The old 0058 deployment is not a certified rollback against today's 0059 schema.
The owner requested a pause at a working committed checkpoint; the next agent
can continue with 0060. Usage percentage/reset timing is not exposed to this agent.

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

**The hosted correction completed and read back successfully on TEST.** Its HTTP protocol is
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
An isolated fresh demo install/build also passed 24 actual browser checks and
three phone axe states with zero blocking violations: a paused link remains an
HTTP 404, opening its rescue panel performs no automatic I/O, explicit withdrawal
removes the public entry, rejoining stays refused, and unknown credentials produce
a generic retryable error. No competitive browser reads or page errors occurred.
This is local browser evidence; archived-wheel behavior was exercised through
actual data functions with a replaced Supabase transport, not a hosted browser.

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

**Those historical passes did not certify the changed repair.** The final source
was subsequently verified twice at `5f72680`, as recorded above and in the receipt.
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
both fresh rounds were then completed on `5f72680`, including that six-path repair.

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

For each subsequent feature, run two complete rounds and save actual exit codes/output:

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

For each subsequent feature, only after both rounds pass:

1. Push exclusively `HEAD:dashboard-redesign`. Confirm all required CI jobs for
   that exact SHA, the expected numeric TEST history/types, full real runtime negatives
   and real login. A skipped job is not a pass. Inspect the one-time repair's
   readback rather than assuming edited SQL changed the hosted database. The 0059
   repair is complete: do not retain its workflow invocation into 0060.
2. Follow `docs/PREVIEW_DEPLOY.md`. Deploy a tracked archive of the checked SHA,
   explicitly targeting Preview, after TEST and CI pass. Never deploy a dirty
   checkout or use `--prod`. Confirm project, owner, source SHA and Preview
   target; exercise actual public/mobile pages and relevant authenticated flows.
3. Only then update the stable Preview alias, verify it again and update this
   handoff with exact source/deployment IDs and results. Keep Production intact.

## Recoverable remaining work

Start with the [repaired-common candidate index](./artifacts/REPAIRED_COMMON_INDEX.md).
It preserves all prepared future features with the latest common repairs through
`5877d94` already carried. The [original source capsule](./artifacts/INDEX.md)
remains immutable provenance. Both preserve unfinished work independently of
`/workspace/.tools`. Hash-check and reconstruct outside
the checkout before applying anything. The frozen originals are **inputs**, not
new release approvals. Review their deltas against the current common source,
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

The repaired-common successor includes a finished portable restore and
recomposition entrypoint, normalized derived descriptors and the exact six-path
privacy authority. Prefer it over the old unfinished builder. Root independently
verified its 352 checksummed members, applied all six sequential patches and
matched complete trees (95/82/67/34/7/36 changed paths). Archive SHA-256:
`403b25e768ac478c4ab8ec3fb946e601b4540c458acd11b228250666d8d42f17`.
Its recorded source counts are 1590/1613/1634/1653/1656/1675 and native syntax
counts 47/50/56/59/60/70. **No full future unit/build/browser/drift or hosted pass
is claimed.** Current committed handoff facts take precedence over preserved notes.

The optional recomposer accepts `5877d94` or a documentation/artifact-only
descendant, rejects any changed application blob or file mode, preserves current
committed documentation and generates new source identities for each new root.
It reads a Git archive, excludes dirty working documents and writes only outside
the checkout. Actual release verification still requires a clean, unchanged HEAD.
Use the final checked branch commit as the new root when deliberately integrating
0060, then release only the next numeric phase after its own complete gates.
If a shallow clone lacks either recorded base, fetch the integration branch's
history; do not recreate, rewrite or force-push the historical authorities.

0059 is released. Continue strictly with **0060 scratch → 0061 bingo → 0062
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
