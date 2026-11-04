# Load / abuse stress results (A26)

The harness in `scripts/stress/` runs the ten scenarios of the completeness
audit's stress-test plan (`COMPLETENESS_AUDIT_2.md` §Stress-test plan) fully
locally, never against a hosted project:

- **DB half** (`scripts/stress/db.mjs`): the real SQL gateways on a disposable
  PostgreSQL 16 built like `scripts/db/interplay-check.mjs` (stub +
  `supabase/schema.sql`), on its own socket directory and port 54226. A
  dependency-free wire client (`pgwire.mjs`) keeps a pool of 32 persistent
  sessions, so hundreds of concurrent callers contend on real row locks the way
  they do behind Supabase's pooler.
- **HTTP half** (`scripts/stress/http.mjs`): the built app under `next start`
  in demo/debug mode (in-memory store, the production route handlers,
  limiter, validation and SSR) on `STRESS_PORT` (3274). Every Supabase, Upstash
  and Vercel variable is stripped from the child environment, and the harness
  refuses a server that does not report the demo backend. `STRESS_BASE_URL`
  must be a loopback origin.

## Run

```
npm run stress                                   # both halves (needs PG_BIN and a prior `npm run build`)
PG_BIN=/usr/lib/postgresql/16/bin node scripts/stress/run.mjs --db [--quick] [--only D1,D4]
node scripts/stress/run.mjs --http [--quick] [--only H1]   # STRESS_PORT=3274 by default
node scripts/stress/run.mjs --out stress.json              # full JSON report
STRESS_STRICT=1 ...                              # documented known bugs fail the run
STRESS_SOFT_LATENCY=1 ...                        # a p95 breach warns instead of failing
STRESS_PG_LOG=<file> / STRESS_SERVER_LOG=<file>  # keep the Postgres / next logs
node --test scripts/stress/harness.test.mjs      # plumbing tests (CI "Script and workflow-guard tests")
```

Exit code 1 on any invariant violation, any 5xx, a latency ceiling breach
(unless soft), or, in strict mode, a known bug that still reproduces. The
machine is shared, so run it under the heavy lock like the e2e rounds.

## Pass criteria

After every scenario the DB half asserts the audit's invariants for the
creator exercised: `fans.spins_remaining == SUM(fan_passes.spins_remaining)`
(and granted totals); no negative stock or balance; redemptions == committed
spins; unique nonces; every prize belongs to the wheel played; assigned codes
unique and a code prize's stock == its unused codes; every debited credit is
one committed spin; no `spin_attempts` row pending for more than 60 s; and
`run_reward_ledger_invariants()` healthy. Scenario-specific exact counts
(units awarded, replays, batches) are hard checks.

Latency ceilings are p95 in milliseconds on this 4-CPU box with the server or
cluster sharing the CPUs (`DB_THRESHOLDS` in `db.mjs`, `HTTP_THRESHOLDS` in
`http.mjs`): DB prepare 250, commit 400 (2x where a scenario deliberately
serialises on one row or runs maintenance), grant 400, `save_wheel_prizes`
600, 500-row import 4000, retention 3000, ledger invariants 5000, account
cascade 15000; HTTP spin 400 (1500 when every fan contends on one prize or the
creator edits), `/api/spin/status` 300, public GET 150, dashboard read 1500,
fan page SSR 2500, 500-row import 3000, abuse refusal 2000. The ceilings are
about 1.5-2x the measured p95 so a regression of that size fails the run.

## Scenario map (audit plan → harness)

| Plan | Harness | What is driven |
|---|---|---|
| 1 double-spend / idempotency | D2, H4 | 100 distinct attempts on a balance of 5 (exactly 5 commit), 50 concurrent commits of one attempt (one spin, identical replays), same id + other binding (conflict), status recovery |
| 2 limited stock + editor race (A2) | D1, D3, H3, H5 | 200 fans on stock 25 (exactly 25 units, stock 0); 60 fans x2 while 10 stale `save_wheel_prizes`, a game switch, archive/unarchive; over HTTP 60 fans on stock 10 and `PUT /api/wheel` + wheel/campaign edits mid-play |
| 3 code prizes (#26) | D7 | 50 fans on a 5-code prize (5 distinct codes, 45 redraw; `changed` retry and `sold_out` redraw rates recorded) with 1000 codes pasted mid-race |
| 4 focus/chase | deferred | the focus ledger is covered by `scripts/db/focusLedgerProbe.mjs` (sequential); a concurrent focus/chase load scenario is not in this harness yet |
| 5 grants, edits, imports | D5, H6 | 500-row import replayed 5x in parallel (one batch), 20 grants with one requestId (one apply) and 20 distinct, `edit_pass_grant` replays and conflict, all while 40 fans play; over HTTP the 5/min cap and a 409 on a reused batchId |
| 6 rate-limit behaviour | H1, H2 | 100-request spin flood from one IP+token (≤10 pass, integer Retry-After, a legitimate fan unaffected, the same token from another address allowed), fan-message cap; 11 000 distinct addresses against the 10 000-window limiter (fails open, a blocked address stays blocked) |
| 7 abuse | H9 | 6 MB bodies, malformed JSON, HTML/RTL/NUL injection in names, notes and tags (verbatim JSON, escaped SSR), path traversal and bad percent-encoding, 300 guessed tokens, mass `/api/report` and `/api/errors` from rotating addresses |
| 8 read paths at scale | D8, H10 | 400 fans x 5 spins seeded through the real gateways, then `run_reward_ledger_invariants` and the account-deletion cascade timed; over HTTP 5 000 imported fans, then 8 dashboard reads by 20 users x 5 |
| 9 fan-page load | H10 | 200 fans load `/spin/[token]`, recent wins, leaderboard and check-in behind two shared addresses (NAT false positives counted) |
| 10 cron and maintenance | D8, H8 | two concurrent `run_retention_cleanup`, a creator deletion cascade and a fan deletion while 40 fans play; over HTTP two concurrent cron runs, a fan deleted mid-play, an account reset mid-play |
| scratch / bingo | D6 | 40 fans on a 5-unit scratch prize (exact accounting, redraws), 12 fans playing a Bingo game concurrently, twice (one card each, versions advance) |
| campaign / per-link pins mid-play | D4 | continuous campaign-pin flips plus `set_fan_pass_game` while 40 fans play 3 rounds |
| push fan-out | H7 | 10 devices subscribed (11th refused), 20 winning spins, outbox growth and spin latency |

## Findings

### KNOWN-BUG `COMMIT_RESOLVES_WHEEL_PER_STATEMENT` (DB, needs a migration; not fixed on this branch)

**Repro** `PG_BIN=/usr/lib/postgresql/16/bin node scripts/stress/run.mjs --db --only D4`:
while 40 fans play, a loop updates `campaigns.pinned_wheel_id` between two
games (exactly what `PATCH /api/campaigns/[id]` does: a plain UPDATE under
RLS, no fan or pass lock). Dozens of `40P01 deadlock detected` per run, every
one with `commit_spin_attempt` on both sides; `STRESS_PG_LOG` shows the cycle:

```
Process A waits for AccessExclusiveLock on tuple of wheels        (perform 1 from public.wheels where id=public._resolved_spin_wheel(p.id) for update)
Process B waits for ShareLock on transaction of C                  (while locking tuple in relation "prizes")
Process C waits for AccessShareLock on tuple of wheels             (SELECT 1 FROM ONLY "public"."wheels" x WHERE "id" = $1 FOR KEY SHARE OF x  -- the FK check of the spins insert)
```

**Root cause** `commit_spin_attempt` (`supabase/schema.sql`, the 0066
definition) evaluates `public._resolved_spin_wheel(p.id)` in four separate
statements: the Bingo card lookup, the wheel lock
(`perform 1 from public.wheels where id=_resolved_spin_wheel(p.id) for update`),
the prize lock (`perform 1 from public.prizes where wheel_id=_resolved_spin_wheel(p.id) ... for update`)
and `_spin_attempt_context(p.id)`. Under READ COMMITTED each statement takes
a new snapshot, so when the campaign pin (or any input of the shared ranking:
`is_active`, a schedule window opening with the clock, an archive) changes
between the wheel lock and the prize lock, the commit locks game B's prizes
while holding game A's wheel. The context check then still matches the
prepared game (the pin flipped back, or the ranking returned to A), the spin
is inserted for A, and its FK check wants a share lock on wheel A, which
another commit holds in the correct fan → pass → wheel → prize order while it
waits for the prize row the first commit holds. The per-link pin never
triggers it because `set_fan_pass_game` locks fan → pass first and so
serialises behind the commit; the campaign pin and the schedule clock do not.

**Effect** The deadlocked commit's transaction rolls back (no ledger damage:
the invariants hold, and the harness retries the attempt like the fan page's
durable recovery would), but under a pin flip a share of commits fail with a
raw SQL error that the service surfaces as a retryable `spin_pending`/503, and
the spin can resolve on the game the pin pointed at a statement earlier.

**Suggested fix (0067 on `gaps/b4-db`)** resolve once, lock in order, recheck:

```sql
v_wheel := public._resolved_spin_wheel(p.id);                       -- right after the fan and pass locks
select * into card from public.bingo_cards where fan_id=f.id and wheel_id=v_wheel ... for update;
perform 1 from public.wheels where id=v_wheel for update;
if public._resolved_spin_wheel(p.id) is distinct from v_wheel then return jsonb_build_object('status','retry_context'); end if;
perform 1 from public.prizes where wheel_id=v_wheel or id=r.prize_id order by id for update;
current_context := public._spin_attempt_context(p.id);              -- unchanged; its wheelId is v_wheel now, or the hash check returns retry_context
```

and the same single evaluation in `prepare_spin_attempt` / `cancel_spin_attempt`
where they take the wheel lock. A regression check: D4 with `STRESS_STRICT=1`
(0 deadlocks) plus an interplay case that flips the campaign pin between the
two lock statements (advisory-lock injection, as 0061 did for the Bingo
publish fault).

### Observations (no defect)

- **Contention tail is queueing, by design.** With every fan on one finite
  prize (D1, H3), commits serialise on that prize row; the tail latency is
  the queue depth times the service time (D1: p50 ≈ concurrency x 7 ms on
  this box), and the throughput is bounded by one commit at a time per prize.
  Spread across prizes/creators (D8 seed) commit p95 stays well under the
  ceiling.
- **Carrier-NAT false positives (A22).** 200 fans behind two addresses hit
  the 60/min/IP leaderboard and 120/min/IP recent-wins caps: H10 counts the
  fans that see a 429 on those polls (`nat_429_fans`). The spin page itself
  (SSR) and `/api/spin` (per IP+token) are unaffected.
- **Oversized bodies.** A 6 MB JSON body is parsed and refused by validation
  (400) rather than rejected on `Content-Length` (413) on routes other than
  `/api/errors`; Vercel's 4.5 MB request cap bounds this in production, and
  the local server keeps serving a legitimate spin at normal latency
  immediately afterwards. Not changed here: a shared `Content-Length` cap in
  `parseJsonBody` would be the app-level follow-up.
- **`/api/fans/import` accepts 500 rows x 5 replays in parallel** in both
  halves with exactly one batch; the demo mock and `import_fans_durable` agree.

## Results

Numbers below are from the verification rounds on the final HEAD (full size,
under the heavy lock; see `RESULTS_RAW` for the JSON reports in the session
log directory). The table is the harness's own markdown summary.

<!-- RESULTS -->
