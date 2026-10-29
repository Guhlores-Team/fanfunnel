# Interplay stress suite (A26)

Proof that features work in tandem: game resolution, scheduling, pins, archiving,
prize edits, concurrency, tenancy and the scratch feature flag, exercised as real
SQL on a throwaway local Postgres 16 (same harness as the other `scripts/db/*-check.mjs`).

## Run

```
PG_BIN=/usr/lib/postgresql/16/bin node scripts/db/interplay-check.mjs          # default: KNOWN-BUG lines, exit 0
INTERPLAY_STRICT=1 PG_BIN=... node scripts/db/interplay-check.mjs               # fails while a documented bug reproduces
INTERPLAY_WRITE_FIXTURE=1 PG_BIN=... node scripts/db/interplay-check.mjs        # regenerate the TS-mirror fixture
npm test                                                                        # src/lib/data/wheelResolutionInterplay.test.ts replays the fixture
```

`scripts/db/schema-drift-check.mjs` (CI `schema-drift` job) runs the probe on every
built database, like its siblings. The matrix (`scripts/db/interplayCases.mjs`, 42
cases) is data-driven: `expected` records CURRENT behaviour, `bug` marks a documented
disagreement, `surprise` marks agreed behaviour that needs clear UI.

Per case the suite asserts that issuance (`_create_pass_grant_core`), the prepare
context (`_spin_attempt_context`), spin time (`_resolved_spin_wheel`) and the TS
mirror (`resolveWheelId`, replayed on the recorded rows) choose the same game, that
`prepare_spin_attempt` serves it with its real kind, and that ledger invariants hold
(fan aggregate = sum of passes, no negative stock/balance, one redemption per spin,
unique nonces, prizes belong to the wheel played, no attempt left pending).

## Known bugs (printed as KNOWN-BUG; fatal under INTERPLAY_STRICT=1)

| Id | Severity | Repro case | Fix |
|---|---|---|---|
| ISSUANCE_IGNORES_SCHEDULE | High (the TEST Preview bug) | `active-wheel-vs-open-scratch`: link minted for the active wheel, fan plays the scheduled scratch game | Make `_create_pass_grant_core` (0060:404-408) call `_resolved_spin_wheel`-equivalent ordering (pin → open window → is_active → oldest), or stop storing a per-wheel `fan_passes.wheel_id` label; mirror in `src/lib/data/wheels.ts:41-89` |
| ACTIVE_ORDER_MISMATCH | Low | `two-active-id-vs-age`, `four-all-active` | Use one ordering (`created_at,id`) in both 0060:139 and 0060:407 and `wheels.ts:82` |
| A2_STALE_STOCK_SAVE | High | concurrency 3c: 3 units awarded from stock 2 when the creator re-saves the prize list between spins | `save_wheel_prizes` (schema.sql) should apply a stock delta or a CAS (`expected_stock`), `saveWheel` in `wheels.ts` sends the loaded value |
| CROSS_TENANT_HAPPY_HOUR | Medium | cross-tenant 4: creator B inserts a 5x happy hour on A's wheel via PostgREST; A's fans get `happyHourMultiplier=5` | `happy_hours_rw` with-check must require the wheel's `creator_id` (schema.sql:2754); `_spin_attempt_context` (0059:225) should filter `creator_id=w.creator_id` |

## Surprising but intended (needs clear UI)

S1 pass.wheel_id is a label, not routing · S2 an open schedule beats the active flag,
even for unpinned links · S3 a future/expired-only schedule still serves as the
oldest-game fallback · S4 a cross-tenant pin id is accepted by RLS and silently ignored ·
S5 a pinned game ignores its own window · S6 disabling scratch leaves an existing scratch
game live (grandfathered; archive it to fall back) · S7 archiving the only live game
yields a clean `no_wheel` with credits intact.
