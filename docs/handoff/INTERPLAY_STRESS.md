# Interplay stress suite (A26)

Proof that features work in tandem: game resolution, scheduling, pins, archiving,
prize edits, concurrency, tenancy and the scratch/bingo feature flags, exercised as
real SQL on a throwaway local Postgres 16 (same harness as the other
`scripts/db/*-check.mjs`).

## Run

```
PG_BIN=/usr/lib/postgresql/16/bin node scripts/db/interplay-check.mjs          # default: KNOWN-BUG lines (none since 0061), exit 0
INTERPLAY_STRICT=1 PG_BIN=... node scripts/db/interplay-check.mjs               # fails while a documented bug reproduces
INTERPLAY_WRITE_FIXTURE=1 PG_BIN=... node scripts/db/interplay-check.mjs        # regenerate the TS-mirror fixture (review the diff)
npm test                                                                        # src/lib/data/wheelResolutionInterplay.test.ts replays the fixture
```

`scripts/db/schema-drift-check.mjs` (CI `schema-drift` job) runs the probe on every
built database, like its siblings. The matrix (`scripts/db/interplayCases.mjs`, 50
cases incl. 8 personal-Bingo cases) is data-driven: `expected` records the agreed
behaviour, `bug` would mark a documented disagreement (the map is empty since 0061),
`surprise` marks agreed behaviour that needs clear UI.

Per case the suite asserts that issuance (`_create_pass_grant_core`), the prepare
context (`_spin_attempt_context`), spin time (`_resolved_spin_wheel`) and the TS
mirror (`resolveWheelId`, replayed on the recorded rows) choose the same game, that
`prepare_spin_attempt` serves it with its real kind, and that ledger invariants hold
(fan aggregate = sum of passes, no negative stock/balance, one redemption per spin,
unique nonces, prizes belong to the wheel played, no attempt left pending).

## Fixed in 0061 (now asserted as correct; strict mode exits 0)

| Id | Severity | Fix | Proving assertion |
|---|---|---|---|
| ISSUANCE_IGNORES_SCHEDULE | High (the TEST Preview bug) | One shared ranking, `_creator_default_wheel(creator, campaign)` (pin → open window → is_active → oldest), called by both `_create_pass_grant_core` and `_resolved_spin_wheel`; `wheels.ts resolveActiveWheelId` mirrors it | every matrix case now expects `issuance === spin` (e.g. `active-wheel-vs-open-scratch` B/B); the probe also checks both SQL functions reference `_creator_default_wheel` so they cannot drift again |
| ACTIVE_ORDER_MISMATCH | Low | One tie-break `created_at, id` for several `is_active` games, in SQL and `wheels.ts` | `two-active-id-vs-age` B/B, `four-all-active` D/D |
| A2_STALE_STOCK_SAVE | High | `save_wheel_prizes` takes each prize's `expected_stock` (the value the editor loaded, sent by `WheelEditor` → `/api/wheel` → `saveWheel`); a finite edit over moved stock is applied as the creator's delta, a limited/unlimited switch the creator did not see is a clean `stock_changed` conflict (HTTP 409, dashboard message "Stock changed while you were editing… reload") | concurrency 3c: ≤2 units from stock 2 (sequential) and ≤3 from 3 (parallel race) with stale re-saves; delta (+2 over 5→4 lands 6) and conflict checks |
| CROSS_TENANT_HAPPY_HOUR | Medium (security) | `happy_hours_rw` with-check requires the wheel to belong to the same creator; BEFORE trigger `aa_happy_hour_tenant` refuses every role; `_spin_attempt_context` and `getActiveHappyHour` filter `creator_id = w.creator_id` | cross-tenant 4: RLS refusal, service-role refusal, B's own wheel still accepts one, a pre-guard foreign row never boosts A; runtime negative in `scripts/security/rls-runtime-test.mjs` |

Bingo cases added to the matrix: a published Bingo game ranks like any other
(`one-bingo`, `active-wheel-vs-open-bingo`, `pin-bingo`,
`two-active-bingo-vs-wheel-age`, `flag-off-active-bingo`, `bingo-archived-after`),
and an unpublished draft (`game_ready=false`) is never served nor honoured as a pin
(`bingo-draft-never-served`, `pin-bingo-draft`).

Related 0061 fixes proven in `scripts/db/bingoGamesProbe.mjs`: no 40P01 between a
credited play and `set_prize_delivery` / `add_reward_codes` / `_release_fan_focus`
(every prize writer locks wheel → prize; the prize guard locks the wheel only for
Bingo games), a blocked fan keeps a readable card (`get_bingo_card_state` no longer
gates on `blocked_at` or creator approval), and archiving a Bingo game with active
cards is allowed (cards persist, the link stops serving the game, unarchive restores
play) while delete / un-publish / destructive prize edits stay refused.

## Surprising but intended (needs clear UI)

S1 pass.wheel_id is a label, not routing · S2 an open schedule beats the active flag,
even for unpinned links · S3 a future/expired-only schedule still serves as the
oldest-game fallback · S4 a cross-tenant pin id is accepted by RLS and silently ignored ·
S5 a pinned game ignores its own window · S6 disabling scratch/bingo leaves an existing
game live (grandfathered; archive it to fall back) · S7 archiving the only live game
yields a clean `no_wheel` with credits intact.
