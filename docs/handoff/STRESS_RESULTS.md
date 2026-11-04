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
- **Carrier-NAT false positives (A22).** 200 fans behind two addresses: the
  120/min/IP recent-wins cap holds, but the 60/min/IP leaderboard cap sends
  80 of them a 429 on the first poll (`nat_429_fans = 80` in H10). The spin
  page (SSR, no limiter) and `/api/spin` (per IP+token) are unaffected.
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

Full-size runs after 0070, under the heavy lock on the shared 4-CPU box: the
DB half from verification round 1 on `52a47d3` (0070 plus the two-prize
fixtures), the HTTP half on the same code plus the H5 fixture fix below.
`--out` JSON reports and the Postgres/server logs are in the session log
directory and are regenerated by every verification round (`stress-db` and
`stress-http` steps of the round script). DB half: 8 scenarios, 25 s, 0
failures, 0 known bugs (D4: 0 deadlocks retried, 120 of 120 plays committed;
before 0070 on `2d0ba4f`: 147 s, 257 deadlocks retried, 10 plays exhausted).
HTTP half: 11 scenarios, 64 s, 14 107 requests, 0 failures, no 5xx. The H5
editor now gives its new game two prizes before pinning a campaign to it
(0069 refuses fewer, so the first run on 0069+ answered `campaign:400`) and
exercises the campaign PATCH (pin, unpin) that the harness had skipped on a
response-shape mismatch.

### DB half (`--db`, pool 32, local PostgreSQL 16)

| Scenario | Checks | p50 / p95 / max ms (n) | Result |
|---|---|---|---|
| D1 200 fans spin one finite-stock prize (stock 25) concurrently | 12/12 | prepare: 184.2 / 423.2 / 486.9 (200), ceiling 1530<br>commit (all on one prize row): 445.7 / 577.5 / 617 (303), ceiling 1680 | pass |
| D2 idempotency: 100 distinct attempts on a balance of 5, 50 replays of one attempt, binding conflict, status recovery | 15/15 | commit (100 attempts on one fan row): 165.9 / 193.5 / 198.6 (296), ceiling 1400 | pass |
| D3 60 fans play 2 rounds while the creator saves odds/stock, switches games and archives | 11/11 | commit: 70.8 / 124.9 / 166.8 (495), ceiling 400<br>save_wheel_prizes: 42.5 / 100.7 / 100.7 (10), ceiling 600 | pass |
| D4 campaign pin and per-link pin flip between two games while 40 fans play | 11/11 | commit: 52.2 / 128.6 / 227.2 (285), ceiling 1040 | pass |
| D5 a 500-row import replayed 5x in parallel plus concurrent grants/edits while 40 fans play | 20/20 | commit (during the import, 64 in flight): 118.7 / 545.4 / 616.2 (120), ceiling 1040<br>import 500 rows: 677.9 / 680.1 / 680.1 (5), ceiling 4000<br>grant_pass_spins (all on one pass row, beside the plays): 84.1 / 681.7 / 685.7 (60), ceiling 1440 | pass |
| D6 scratch: 40 fans on a 5-unit prize; bingo: 12 fans play concurrently | 24/24 | scratch commit: 64.9 / 175.7 / 184.8 (75), ceiling 400<br>bingo commit: 53.7 / 92.1 / 97.4 (24), ceiling 800 | pass |
| D7 50 fans on a 5-code prize while 1000 codes are pasted on another prize | 14/14 | commit (50 fans on one code prize): 73.1 / 133.5 / 151.7 (167), ceiling 900<br>add_reward_codes x1000: 58.1 / 58.1 / 58.1 (1), ceiling 1800 | pass |
| D8 seed 400 fans x 5 spins, then retention cleanup, a creator deletion cascade and a fan deletion while 40 fans keep playing | 16/16 | commit at scale (64 in flight over 400 fans): 90 / 171 / 305.2 (5553), ceiling 1040<br>run_reward_ledger_invariants: 12.2 / 12.2 / 12.2 (1), ceiling 5000<br>commit during maintenance: 79.5 / 160.3 / 222.7 (190), ceiling 800<br>run_retention_cleanup: 16.6 / 20.2 / 20.2 (2), ceiling 3000<br>creator deletion cascade (400 fans, 2000 spins): 1101.7 / 1101.7 / 1101.7 (1), ceiling 15000 | pass |

Key numbers: D1 {"wall_ms":1619,"outcomes":{"committed":200},"pool":{"inflight":0,"queued":0,"peakQueue":96},"redraws":103,"n":200}; D2 {"outcomes":{"committed":5,"declined":95}}; D3 {"outcomes":{"committed":120},"editor":["saved","saved","saved","saved","switch->B","saved","saved","archive B","saved","saved","unarchive B, switch->A","saved","saved"],"declined_reasons":{},"retries":330}; D4 {"outcomes":{"committed":120},"flips":{"campaign":10,"link":2},"deadlocks_retried":0,"spins_per_game":{"A":"73","B":"47"}}; D5 {"burst_40_distinct_grants":{"granted":40,"refused":0,"codes":{}},"edit_outcomes":{"updated:true":9,"updated:false":1}}; D6 {"outcomes":{"committed":40},"bingo_outcomes":{"committed":12}}; D7 {"outcomes":{"committed":50},"retries_changed_or_context":74,"redraws_sold_out":43}; D8 {"seed":{"fans":400,"spins":2000,"wall_ms":13321},"deleted_fan_outcomes":{"committed:":3}}

### HTTP half (`--http`, demo `next start` on the round's port)

| Scenario | Checks | p50 / p95 / max ms (n) | Result |
|---|---|---|---|
| H1 100-request spin flood from one IP+token (limit 10/10s) while a legitimate fan keeps playing | 7/7 | legit spin during flood: 6 / 266 / 266 (10), ceiling 400<br>flood request (mostly 429): 66.7 / 278.9 / 290.3 (100), ceiling 400 | pass |
| H2 11000 distinct IPs on a public route (limiter capacity 10k windows): fails open, a blocked caller stays blocked | 5/5 | public GET under address flood: 80.8 / 127.7 / 1648.5 (11000), ceiling 250 | pass |
| H3 60 fans spin a finite-stock prize (stock 10) concurrently through /api/spin | 6/6 | spin (concurrent, one prize): 121.5 / 140.5 / 142.4 (60), ceiling 1500 | pass |
| H4 30 concurrent /api/spin with one requestId, a seed mismatch, and /api/spin/status recovery | 6/6 | spin replay: 48 / 56.2 / 56.8 (30), ceiling 400<br>spin/status: 4.9 / 4.9 / 4.9 (1), ceiling 300 | pass |
| H5 40 fans play 2 rounds while the creator saves odds/stock, creates/switches/archives games and pins a campaign | 5/5 | spin during edits: 128 / 196.4 / 200.1 (80), ceiling 1500 | pass |
| H6 a 500-row import replayed 5x in parallel while 30 fans play, the per-IP cap, then 9 more batches to grow the store | 6/6 | spin during import: 100 / 158.7 / 161.3 (60), ceiling 400<br>import 500 rows: 76.6 / 86 / 86 (5), ceiling 3000 | pass |
| H7 10 push devices subscribed, then 20 winning spins: fan-out happens after the response and never slows the spin | 4/4 | spin with push fan-out: 80.6 / 100.9 / 103 (20), ceiling 400 | pass |
| H9 abuse inputs: oversized bodies, malformed JSON, unicode/HTML injection, path traversal, bad encoding, token guessing | 12/12 | oversized body refusal: 74.4 / 110.5 / 110.5 (5), ceiling 2000<br>token guess (SSR 404): 309.7 / 383.1 / 464.6 (300), ceiling 1500 | pass |
| H10 dashboard reads by 20 users x 5, then 200 fans load /spin, recent wins and the leaderboard behind two shared addresses | 5/5 | GET /api/overview (one user): 3.6 / 6.9 / 6.9 (5), ceiling 1500<br>GET /api/fans (one user): 235.8 / 339.2 / 339.2 (5), ceiling 1500<br>GET /api/messages/inbox (one user): 7.3 / 11.3 / 11.3 (5), ceiling 1500<br>GET /api/notifications (one user): 4.1 / 6.2 / 6.2 (5), ceiling 1500<br>GET /api/redemptions (one user): 3.4 / 7.3 / 7.3 (5), ceiling 1500<br>GET /api/crm (one user): 215.8 / 242.2 / 242.2 (5), ceiling 1500<br>GET /api/campaigns/stats (one user): 5.1 / 8.8 / 8.8 (5), ceiling 1500<br>GET /api/metrics?days=30 (one user): 7.9 / 12.3 / 12.3 (5), ceiling 1500<br>GET /spin/[token] (SSR, 200 concurrent): 1085.9 / 2102.6 / 2173.2 (200), ceiling 4000<br>GET /api/recent-wins (during the page load): 1051.3 / 2069.3 / 2148.1 (200), ceiling 4000<br>GET /api/leaderboard (during the page load): 1053.5 / 2071.3 / 2150 (200), ceiling 4000<br>POST /api/fan/checkin (during the page load): 2364.3 / 2507.5 / 2528.3 (200), ceiling 4000 | pass |
| H8 retention cron twice in parallel, a fan deleted mid-play, then an account reset while 20 fans play | 10/10 | spin during cron/deletion: 125 / 219.6 / 225.6 (60), ceiling 400<br>cron retention: 3.3 / 57.8 / 57.8 (2), ceiling 2000 | pass |
| H0 server totals | 1/1 | - | pass |

Key numbers: H1 {"flood_statuses":{"200":10,"429":90},"fan_message_statuses":{"200":10,"429":5}}; H2 {"prime_statuses":{"404":120,"429":1},"flood_statuses":{"404":11000},"throughput_rps":719}; H3 {"statuses":{"200":60}}; H4 {"statuses":{"200":30}}; H5 {"spin_statuses":{"200":80},"editor":["save:200","save:200","save:200","save:200","save:200","save:200","save:200","save:200","create:200","prizesB:200","activateB:200","campaign:200","pin:200","unpin:200","archiveB:200","activateA:200"]}; H6 {"spin_statuses":{"200":60},"import_statuses":{"200":5}}; H7 {"subscribe_statuses":{"201":10,"429":1},"deliveries":50}; H9 {"oversized_6MB":[400,400,400,400,413],"traversal_statuses":["/api/demo/creator-media/..%2F..%2Fpackage.json -> 404","/api/demo/creator-media/../../package.json -> 404","/api/share-cards/..%2f..%2fetc%2fpasswd -> 404","/c/..%2f..%2f.env -> 200","/api/account/media/..%2F..%2F..%2Fetc%2Fpasswd -> 404","/spin/%2e%2e%2f%2e%2e%2fetc%2fpasswd -> 404","/_next/static/../../package.json -> 404","/api/public/wheel/..%2f..%2fadmin -> 200","/spin/%E0%A4%A -> 400","/api/share-cards/%00 -> 404"],"report_statuses":{"200":15,"429":15},"error_report_statuses":{"204":40}}; H10 {"burst_read_statuses":{"200":480},"burst_reads":{"users":20,"requests":480,"batches_timed_out":0,"wall_ms":26545,"rps":18,"p50_ms":1728,"p95_ms":24995},"fan_page_statuses":{"200":200},"recent_wins_statuses":{"200":200},"leaderboard_statuses":{"200":120,"429":80},"checkin_statuses":{"200":200},"nat_429_fans":80}; H8 {"spin_statuses":{"200":57,"404":3},"cron_statuses":{"200":2},"reset":200,"spins_during_reset":{"404":10,"409":10}}; H0 {"requests":14107,"by_status":{"200":2395,"201":10,"204":40,"400":11,"401":1,"404":11443,"409":12,"413":1,"429":194}}
