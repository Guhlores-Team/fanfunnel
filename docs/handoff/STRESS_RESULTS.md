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
cluster sharing the CPUs with the harness (`DB_THRESHOLDS` in `db.mjs`,
`HTTP_THRESHOLDS` in `http.mjs`). Base ceilings: DB prepare 250, commit 400,
grant 400, `save_wheel_prizes` 600, 500-row import 4000, retention 3000, ledger
invariants 5000, account cascade 15000; HTTP spin 400 (1500 when every fan
contends on one prize or the creator edits), `/api/spin/status` 300, public GET
250, dashboard read 1500 (one user), fan page SSR 1500, 500-row import 3000,
abuse refusal 2000. Where a scenario deliberately makes every caller contend on
ONE row (one prize, one fan, one pass) or keeps the whole pool busy, commits
serialise on that lock by design and the tail is the queue depth times the
service time, so those ceilings add `perContender` = 10 ms per concurrent
caller (D1: 400 + 10 x 128 in flight; D2 same; D5/D8: 400 + 10 x 64; D7:
400 + 10 x 50); the 200-fan SSR page load adds 20 ms per concurrent fan. The
ceilings sit about 1.5-2x above the measured p95 so a regression of that size
fails the run, while a shared box that is merely busier does not. The 20-user
dashboard burst (H10) is recorded as throughput, not a ceiling: the demo's
in-memory reads are CPU-bound on one Node process and say nothing about
Supabase-backed reads.

## Scenario map (audit plan → harness)

| Plan | Harness | What is driven |
|---|---|---|
| 1 double-spend / idempotency | D2, H4 | 100 distinct attempts on a balance of 5 (exactly 5 commit), 50 concurrent commits of one attempt (one spin, identical replays), same id + other binding (conflict), status recovery |
| 2 limited stock + editor race (A2) | D1, D3, H3, H5 | 200 fans on stock 25 (exactly 25 units, stock 0); 60 fans x2 while 10 stale `save_wheel_prizes`, a game switch, archive/unarchive; over HTTP 60 fans on stock 10 and `PUT /api/wheel` + wheel/campaign edits mid-play |
| 3 code prizes (#26) | D7 | 50 fans on a 5-code prize (5 distinct codes, 45 redraw; `changed` retry and `sold_out` redraw rates recorded) with 1000 codes pasted mid-race |
| 4 focus/chase | D9, H11 | 60 fans play up to 16 rounds on a 5-prize game (finite Focus target, finite and code Chase targets, an unlimited rare) while the creator grants Focus/Chase packs through `grant_focus_pack` (every fifth one double-submitted 3x), cancels through `cancel_fan_focus`, re-saves the Focus prize's stock with `save_wheel_prizes` (fresh and stale editors) and archives the game with `archive_wheel` mid-play; draws come from the service's own wheel proof path through a bridge (`wheelProofFixture.ts`), so pity and Chase forcing are the engine's, and every second due guarantee is first probed with a forged outcome. Over HTTP the same flow through `/api/campaign-packs`, `/api/fans/[fanId]/focus` (POST/DELETE), `PUT /api/wheel` and `PATCH /api/wheels/[id]` |
| 5 grants, edits, imports | D5, H6 | 500-row import replayed 5x in parallel (one batch), 20 grants with one requestId (one apply) and 20 distinct, `edit_pass_grant` replays and conflict, all while 40 fans play; over HTTP the 5/min cap and a 409 on a reused batchId |
| 6 rate-limit behaviour | H1, H2 | 100-request spin flood from one IP+token (≤10 pass, integer Retry-After, a legitimate fan unaffected, the same token from another address allowed), fan-message cap; 11 000 distinct addresses against the 10 000-window limiter (fails open, a blocked address stays blocked) |
| 7 abuse | H9 | 6 MB bodies, malformed JSON, HTML/RTL/NUL injection in names, notes and tags (verbatim JSON, escaped SSR), path traversal and bad percent-encoding, 300 guessed tokens, mass `/api/report` and `/api/errors` from rotating addresses |
| 8 read paths at scale | D8, H10 | 400 fans x 5 spins seeded through the real gateways, then `run_reward_ledger_invariants` and the account-deletion cascade timed; over HTTP 5 000 imported fans, then 8 dashboard reads by 20 users x 5 |
| 9 fan-page load | H10 | 200 fans load `/spin/[token]`, poll recent wins 3x and the leaderboard 2x (a minute on the page) and check in, behind two shared addresses: zero 429s required; then floods from one address + token, from an address rotating forged tokens and from an address with no token must stay capped |
| 10 cron and maintenance | D8, H8 | two concurrent `run_retention_cleanup`, a creator deletion cascade and a fan deletion while 40 fans play; over HTTP two concurrent cron runs, a fan deleted mid-play, an account reset mid-play |
| scratch / bingo | D6 | 40 fans on a 5-unit scratch prize (exact accounting, redraws), 12 fans playing a Bingo game concurrently, twice (one card each, versions advance) |
| campaign / per-link pins mid-play | D4 | continuous campaign-pin flips plus `set_fan_pass_game` while 40 fans play 3 rounds |
| push fan-out | H7 | 10 devices subscribed (11th refused), 20 winning spins, outbox growth and spin latency |

## Findings

### FIXED A22 shared-address false positive (`gaps/b5-stress2`, no migration)

**Repro** `node scripts/stress/run.mjs --http --only H10` on `ba756cb` (before
the fix, with the H10 below): 200 fans behind two addresses, each spending a
minute on the page (the load, three recent-wins polls at 20 s, the
leaderboard on load and after a spin), all at the origin. The per-address
windows (`board:<ip>` 60/min, `wins:<ip>` 120/min) refused **144 of 200
fans**: 280 of 400 leaderboard reads and 360 of 600 recent-wins reads were
429 (the older H10, one read each, counted 80). Check-in was never refused:
it is keyed per address + token (`checkin:<ip>:<token>`, 20/min).

**Fix** `limitSharedRead` (`src/lib/api/limit.ts`), used by
`GET /api/leaderboard/[creatorId]` and `GET /api/recent-wins/[creatorId]`:
the old limit now applies per address + fan link token (the widgets send the
token in `x-fan-token`; callers without one, or with one that is not a link
token's shape, share one window per address, exactly as before), under a
per-address ceiling 5x the old limit (leaderboard 60 -> 300/min, recent wins
120 -> 600/min). The caller's own window is checked first, so a refused
request does not spend its neighbours' share of the ceiling. The header only
keys the limiter: it is not a credential, and the responses (and the
recent-wins CDN caching) do not depend on it.

**After** (same H10): 0 of 200 fans refused; one address + token is still
capped at 60 (leaderboard) / 120 (recent wins), an address rotating forged
tokens stops at 300 / 600, an address with no token at 60 / 120, and another
fan's token on a flooded address is still served. Unit tests:
`src/lib/api/sharedReadLimit.test.ts`, the two route tests, and
`EngagementWidgets.test.ts` (both widgets send the token). The trade-off is
deliberate: a scraper that forges tokens gets 5x the old per-address budget
on these two cheap public reads, and nothing more.

### FIXED `COMMIT_RESOLVES_WHEEL_PER_STATEMENT` (DB, migration 0070 on `gaps/b5-spinlock`)

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

**Root cause** `commit_spin_attempt` (the 0065 definition, in force until
0070) evaluated `public._resolved_spin_wheel(p.id)` in four separate
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

**Fix (0070, `supabase/migrations/0070_resolve_spin_game_once.sql`)** resolve
once, lock everything on that one game:

```sql
v_wheel:=public._resolved_spin_wheel(p.id);                          -- right after the fan and pass locks
select * into card from public.bingo_cards where fan_id=f.id and wheel_id=v_wheel ... for update;
perform 1 from public.wheels where id=v_wheel for update;
perform 1 from public.prizes where wheel_id=v_wheel or id=r.prize_id order by id for update;
current_context:=public._spin_attempt_context(p.id,v_wheel);         -- the context of that game; a changed ranking still fails the hash check -> retry_context
```

`_spin_attempt_context(pass, wheel)` is a new two-argument form (0061's body
with the caller's game instead of its own resolution); the one-argument form
delegates to it for `get_fan_focus_state`. `prepare_spin_attempt` resolves
once the same way (its `no_wheel` check and its context). There is no second
resolution after the wheel lock: the context hash already answers
`retry_context` when the ranking changed, and the service re-prepares
(`src/lib/data/spinAttempts.ts`). The only resolution left after the locks is
the receipt's lock-free card read (`_spin_attempt_receipt` ->
`get_bingo_card_state`, the card of the game the link plays next). Lock
order (fan -> pass -> wheel -> prize), SECURITY DEFINER, the fixed
`search_path`, every grant and the response contract are unchanged;
`cancel_spin_attempt` never resolved a game.

**Regression coverage** `scripts/db/spinResolutionProbe.mjs` (drift check,
every build path): static exactly-once checks on both function sources; a
counting shim around the resolver proves one resolution per prepare and one
per commit before the spin is written; the shim flips the campaign pin in the
instant after the commit's resolution and the play still commits on the
resolved game (against the 0065 definitions the same probe reports 7
resolutions per commit and `retry_context`). D4's known-bug lines are hard
checks now: `deadlocks_retried <= 0` (`D4_DEADLOCK_BOUND` in `db.mjs`), every
play commits, and the commit ceiling always applies.

**Before / after (D4, full size, 40 fans x 3 rounds under continuous pin flips)**

| | deadlocks retried | outcomes | commit p50 / p95 / max ms |
|---|---|---|---|
| before 0070 (run on `2d0ba4f`) | 257 | 110 committed, 10 exhausted after 12 deadlocks each | 4054 / 10205 / 20373 (including deadlock waits) |
| after 0070 (five runs on `a59120f`) | 0 | 120 committed | 85-108 / 282-332 / 353-423 |

The D4 wall time dropped from tens of seconds to about 1 s, so fewer pin
flips land during a run (8-16 campaign flips, 2-4 link pins); the probe's
shim covers the exact instant the harness can no longer hit by timing.

### Observations (no defect)

- **Contention tail is queueing, by design.** With every fan on one finite
  prize (D1, H3) or one fan row (D2), commits serialise on that row; D1's
  commit p50 is about 590 ms with 128 attempts in flight on this box (about
  5 ms of service time each), and the pool itself (32 sessions, 64 in flight)
  gives D8 a 460 ms p50 over 400 fans. Spread across prizes and creators the
  per-commit cost stays a few milliseconds (D3: p50 138 ms with the editor
  saving, D6 Bingo: 94 ms).
- **Carrier-NAT false positives (A22).** Fixed on `gaps/b5-stress2` (above).
  The spin page (SSR, no limiter), `/api/spin` and `/api/fan/checkin` (per
  address + token) were never affected. Not changed: the token-keyed fan
  routes (`withFanToken`, check-in) have no per-address ceiling, so an
  address rotating forged tokens is limited only by the token lookup failing
  (404), as before.
- **Focus/Chase under contention (D9, H11).** No defect. Round 1: 60 fans,
  780 plays, 144 grants (32 triple-submits each applied once), 19 cancels,
  14 stock saves (3 stale) and an `archive_wheel` mid-play: 0 deadlocks,
  every Focus spin and Chase step is one committed play, every consumed
  Chase unit is one win of its own prize by its own fan, Chase stock and
  codes conserved exactly, the Focus prize's stock is its start plus the
  creator's deltas minus wins (stale re-saves never restock), pity forced 17
  times and the Chase guarantee 17 times, only when the counters entitled
  them, and all 50 forged outcomes (a common prize while pity or Chase was
  due, an early Chase completion) refused with 22023 (2 met a changed context
  or a decline first). Over HTTP (H11) the same flow answers no 5xx,
  double-submitted purchases apply once and each fan's balance equals its
  grants minus its plays.
- **KNOWN-BUG `DEMO_SAVE_IGNORES_EXPECTED_STOCK` (demo store only).** The
  in-memory `mockSaveWheel` ignores `expectedStock`, so a `PUT /api/wheel`
  that races a win (or a stale editor) writes back the stock it loaded and
  restocks units already won; H11 sees the Chase prize end above its start
  (round 1: 8 left + 15 won of 12). The Supabase path applies the editor's delta
  (`save_wheel_prizes`, D3/D9), so production is not affected; the demo
  diverges. Not fixed here (H11 prints it as KNOWN-BUG; `STRESS_STRICT=1`
  fails on it).
- **`PATCH /api/wheels/[id]` ignores `archived: true`.** It validates the
  field, answers 200 and archives nothing (archive is `DELETE` without
  `?hard=1`; PATCH only handles `archived: false`). H5 relied on it, so its
  "archive B" step never archived; H5 and H11 now use `DELETE`. Not changed
  in the route (the dashboard uses `DELETE`).
- **Dashboard reads at 5 000 fans in the demo store.** One user: `/api/fans`
  223 ms and `/api/crm` 197 ms p50, every other route under 15 ms. Twenty
  users polling all eight routes at once: 18 requests/s, p50 1.9 s, p95 42 s
  (on a busier box a batch can exceed the two-minute request timeout; the
  harness counts it as `batches_timed_out`), because the mock store is
  CPU-bound on one Node process; the number is a
  property of the demo, not of the Supabase-backed routes (the audit's
  scenario 8 against TEST remains the real read-path test).
- **Oversized bodies.** A 6 MB JSON body is parsed and then refused by
  validation (400) or, when it parses to a valid request, served (200 on
  `/api/passes` with the name truncated, 404 on `/api/spin` for the unknown
  token); only `/api/errors` refused on `Content-Length` (413). Vercel's 4.5 MB
  request cap bounds this in production, and the local server answers a
  legitimate spin at normal latency immediately afterwards. Since
  `gaps/b5-spinlock`, `parseJsonBody` refuses a body over 1 MiB
  (`JSON_BODY_MAX_BYTES`, declared Content-Length first, then while reading)
  with the routes' usual 400 before anything is parsed; `/api/errors` keeps
  its own 16 KB cap and 413.
- **Actor-context cap (0062).** 32 live actor contexts per actor. A 40-way
  burst of distinct `grant_pass_spins` calls through the pool of 32 sessions
  reached the cap once in two runs (39 granted, one `54000 actor context
  limit`), never a half-applied grant. Through the API this surfaces as a
  retryable 503 (`edit_pending` / `import_pending`) for a dashboard that
  fires more than 32 privileged requests at once.
- **Demo any-id routes.** In demo mode `/c/<anything>` and
  `/api/public/wheel/<anything>` serve the one demo creator (the mock ignores
  the id); with Supabase they are keyed lookups. Every other traversal or
  bad-encoding probe is a 400/404 and nothing ever serves a file.
  Verified on the `gaps/b5-spinlock` rounds by fetching both bodies:
  `/api/public/wheel/..%2f..%2fadmin` is byte-identical to
  `/api/public/wheel/admin` (the demo creator's public wheel JSON) and
  `/c/..%2f..%2f.env` is the demo creator's public page HTML (21 KB, same as
  any unknown slug), with no environment or secret strings; benign.
- **One unexplained deadlock (D8).** In one quick run two
  `commit_spin_attempt` calls of the live creator deadlocked (a two-process
  cycle on row locks) while the other creator's account cascade, two
  retention runs and a fan deletion were in flight; five later quick and full
  runs did not reproduce it. The verification rounds keep the Postgres log
  (`STRESS_PG_LOG`), which names the statements if it recurs; it was most
  likely the same per-statement resolution hazard as D4 (a game-ranking input
  changing between the wheel and prize locks), which 0070 removes.
- **`/api/fans/import` accepts 500 rows x 5 replays in parallel** in both
  halves with exactly one batch; the demo mock and `import_fans_durable`
  agree. The 11 000-address flood (H2) is served at about 720 requests/s with
  a p95 of 143 ms, every first request answered, and an address blocked
  before the flood is still blocked after the limiter's eviction sweep.

## Results

Full-size runs under the heavy lock on the shared 4-CPU box, from
verification round 1 on `gaps/b5-stress2` (`83e34a1`: D9, H11, the A22
shared-read limiter and the H10 rewrite on top of `orch/fixes` 829a288).
`--out` JSON reports and the Postgres/server logs are in the session log
directory and are regenerated by every verification round (`stress-db` and
`stress-http` steps of the round script). DB half: 9 scenarios, 19 s, 0
failures, 0 known bugs (D9: 0 deadlocks retried). HTTP half: 12 scenarios,
58 s, 16 933 requests, 0 failures, no 5xx, 1 known bug
(`DEMO_SAVE_IGNORES_EXPECTED_STOCK`, demo store only). Latency columns are
p50 / p95 / max ms (n); the ceilings are in `DB_THRESHOLDS` /
`HTTP_THRESHOLDS`.

### DB half (`--db`, pool 32, local PostgreSQL 16)

| Scenario | Checks | Latency (p50 / p95 / max ms, n) | Result |
|---|---|---|---|
| D1 200 fans spin one finite-stock prize (stock 25) concurrently | 12/12 | prepare: 118.5 / 359 / 403.5 (200)<br>commit (all on one prize row): 364.3 / 489.5 / 533.1 (303) | pass |
| D2 idempotency: 100 distinct attempts on a balance of 5, 50 replays of one attempt, binding conflict, status recovery | 15/15 | commit (100 attempts on one fan row): 112.4 / 151.4 / 158.1 (296) | pass |
| D3 60 fans play 2 rounds while the creator saves odds/stock, switches games and archives | 11/11 | commit: 53.5 / 106.2 / 160.7 (589)<br>save_wheel_prizes: 36.5 / 106.6 / 106.6 (10) | pass |
| D4 campaign pin and per-link pin flip between two games while 40 fans play | 11/11 | commit: 44.1 / 109.8 / 203.6 (315) | pass |
| D5 a 500-row import replayed 5x in parallel plus concurrent grants/edits while 40 fans play | 20/20 | commit (during the import, 64 in flight): 96.2 / 485.5 / 528.8 (120)<br>import 500 rows: 537.2 / 568.4 / 568.4 (5)<br>grant_pass_spins (all on one pass row, beside the plays): 66.6 / 522.7 / 527.4 (60) | pass |
| D6 scratch: 40 fans on a 5-unit prize; bingo: 12 fans play concurrently | 24/24 | scratch commit: 74.1 / 135.6 / 140.9 (75)<br>bingo commit: 42.6 / 74.7 / 77.6 (24) | pass |
| D7 50 fans on a 5-code prize while 1000 codes are pasted on another prize | 14/14 | commit (50 fans on one code prize): 52.8 / 89.2 / 100.4 (174)<br>add_reward_codes x1000: 85.8 / 85.8 / 85.8 (1) | pass |
| D8 seed 400 fans x 5 spins, then retention cleanup, a creator deletion cascade and a fan deletion while 40 fans keep playing | 16/16 | commit at scale (64 in flight over 400 fans): 51.1 / 94.7 / 140.5 (5556)<br>run_reward_ledger_invariants: 5 / 5 / 5 (1)<br>commit during maintenance: 42.7 / 95.6 / 111.6 (179)<br>run_retention_cleanup: 7.8 / 8.7 / 8.7 (2)<br>creator deletion cascade (400 fans, 2000 spins): 559.5 / 559.5 / 559.5 (1) | pass |
| D9 60 fans play up to 16 rounds while Focus/Chase packs are granted, replayed and cancelled, the creator edits the Focus prize's stock and archives its game | 27/27 | commit (every fan on one game's prize rows): 111.4 / 155.7 / 193.4 (943)<br>prepare: 36.3 / 64.1 / 170.6 (885)<br>grant_focus_pack (beside the plays): 8.3 / 255.8 / 341.7 (221)<br>cancel_fan_focus: 4.2 / 13.7 / 13.7 (19)<br>save_wheel_prizes (Focus prize stock): 3.8 / 160.1 / 160.1 (14)<br>archive_wheel: 289.9 / 289.9 / 289.9 (1) | pass |

Key numbers: D9 plays {"committed":780,"declined":45}, rate_limit_pauses 60, grants {"granted":144,"sold_out":11,"focus_exists":40,"rejected":22,"invalid_target":4}, cancels {"released":19}, forged {"pity":8,"chase":10,"early":32}, forged_outcomes {"early:22023:refused":31,"chase:22023:refused":10,"pity:retry_context":1,"pity:22023:refused":7,"early:declined":1}, deadlocks_retried 0; ledger {"pityAwarded":17,"chaseAwarded":17,"focusConsumed":154,"chaseCompleted":20,"focusPaused":11,"spinsOnF":461,"spinsOnG":319,"focusStatuses":{"chase:done":20,"focus:done":29,"chase:active":14,"focus:active":14,"chase:released":12,"focus:released":13}}; every mismatch counter (Focus/Chase consumption, double consumption, grant and balance ledger, unentitled or missed guarantees, promises or held units left on the archived game) 0.

### HTTP half (`--http`, demo `next start` on the round's port)

| Scenario | Checks | Latency (p50 / p95 / max ms, n) | Result |
|---|---|---|---|
| H1 100-request spin flood from one IP+token (limit 10/10s) while a legitimate fan keeps playing | 7/7 | legit spin during flood: 4.4 / 346.9 / 346.9 (10)<br>flood request (mostly 429): 50.1 / 351.4 / 361.6 (100) | pass |
| H2 11000 distinct IPs on a public route (limiter capacity 10k windows): fails open, a blocked caller stays blocked | 5/5 | public GET under address flood: 70.9 / 122.8 / 1228.9 (11000) | pass |
| H3 60 fans spin a finite-stock prize (stock 10) concurrently through /api/spin | 6/6 | spin (concurrent, one prize): 114.9 / 129.2 / 130.9 (60) | pass |
| H4 30 concurrent /api/spin with one requestId, a seed mismatch, and /api/spin/status recovery | 6/6 | spin replay: 31.5 / 37.6 / 37.9 (30)<br>spin/status: 4.4 / 4.4 / 4.4 (1) | pass |
| H5 40 fans play 2 rounds while the creator saves odds/stock, creates/switches/archives games and pins a campaign | 5/5 | spin during edits: 72.7 / 165.7 / 168.4 (80) | pass |
| H6 a 500-row import replayed 5x in parallel while 30 fans play, the per-IP cap, then 9 more batches to grow the store | 6/6 | spin during import: 80.7 / 147.8 / 153.7 (60)<br>import 500 rows: 73.8 / 84.2 / 84.2 (5) | pass |
| H7 10 push devices subscribed, then 20 winning spins: fan-out happens after the response and never slows the spin | 4/4 | spin with push fan-out: 67.4 / 84.1 / 86.1 (20) | pass |
| H9 abuse inputs: oversized bodies, malformed JSON, unicode/HTML injection, path traversal, bad encoding, token guessing | 12/12 | oversized body refusal: 58.9 / 86.4 / 86.4 (5)<br>token guess (SSR 404): 254.5 / 321.6 / 351.7 (300) | pass |
| H10 dashboard reads by 20 users x 5, then 200 fans load /spin, recent wins and the leaderboard behind two shared addresses | 14/14 | GET /api/overview (one user): 2.9 / 8.7 / 8.7 (5)<br>GET /api/fans (one user): 182.4 / 296.2 / 296.2 (5)<br>GET /api/messages/inbox (one user): 7.5 / 12 / 12 (5)<br>GET /api/notifications (one user): 3.6 / 7.6 / 7.6 (5)<br>GET /api/redemptions (one user): 2.4 / 4 / 4 (5)<br>GET /api/crm (one user): 155.4 / 185.2 / 185.2 (5)<br>GET /api/campaigns/stats (one user): 3.7 / 9.2 / 9.2 (5)<br>GET /api/metrics?days=30 (one user): 6.5 / 11.1 / 11.1 (5)<br>GET /spin/[token] (SSR, 200 concurrent): 1426.3 / 1678 / 1759.9 (200)<br>GET /api/recent-wins (during the page load): 641.3 / 1649.7 / 1735.6 (200)<br>GET /api/leaderboard (during the page load): 642.2 / 1651.5 / 1737.6 (200)<br>POST /api/fan/checkin (during the page load): 1912.1 / 2020.6 / 2037.9 (200) | pass |
| H11 40 fans spin 8 rounds while the creator grants (some double-submitted), cancels Focus/Chase packs, edits the Focus prize's stock and archives its game | 13/13 | spin during focus/chase grants: 269.6 / 502.4 / 915.9 (284) | pass (1 known bug) |
| H8 retention cron twice in parallel, a fan deleted mid-play, then an account reset while 20 fans play | 10/10 | spin during cron/deletion: 96.3 / 157.1 / 161.9 (60)<br>cron retention: 1.8 / 3.1 / 3.1 (2) | pass |
| H0 server totals | 1/1 | - | pass |

Key numbers: H10 recent_wins_statuses {"200":600}, leaderboard_statuses {"200":400}, checkin_statuses {"200":200}, nat_429_fans {"any":0,"leaderboard":0,"recent_wins":0,"checkin":0}, abuse_caps {"leaderboard":{"one_token":{"from":"10.0.1.154","ok":60,"limited":40,"other":0},"neighbour":200,"rotating_tokens":{"from":"10.0.1.155","ok":300,"limited":100,"other":0},"no_token":{"from":"10.0.1.156","ok":60,"limited":40,"other":0}},"recent_wins":{"one_token":{"from":"10.0.1.157","ok":120,"limited":40,"other":0},"neighbour":200,"rotating_tokens":{"from":"10.0.1.158","ok":600,"limited":100,"other":0},"no_token":{"from":"10.0.1.159","ok":120,"limited":40,"other":0}}}; H11 spin_statuses {"200":272,"409":12}, grants {"granted":61,"409:focus_exists":17,"409:rejected":10}, cancels {"released:true":21,"released:false":1}, editor ["save:200","save:200","stale:200","save:200","save:200","stale:200","archive:200","activate previous:200"], modifiers {"focusConsumed":46,"chaseConsumed":35,"chaseCompleted":4,"chaseAwarded":3,"pityAwarded":0}, chase_stock {"left":8,"won":15,"read":200}; H0 requests 16933, by status {"200":4902,"201":10,"204":40,"400":11,"401":1,"404":11443,"409":51,"413":1,"429":474}. H10 before the A22 fix (same H10 on `ba756cb`): recent wins {"200":240,"429":360}, leaderboard {"200":120,"429":280}, nat_429_fans {"any":144,"leaderboard":144,"recent_wins":123,"checkin":0}.
