-- 0047: Fairness v3 — the odds go into the commitment.
--
-- v2 lets a fan prove the random seed wasn't swapped; it says nothing about
-- the odds. A v3 spin records the exact prize pool it was drawn from (after
-- happy hour, with sold-out prizes left out) plus every modifier in force, as
-- a canonical snapshot, and mixes SHA-256 of that snapshot into the RNG:
--   SHA-256(serverSeed:clientSeed:nonce:poolHash:block)
-- The public verify page re-hashes the snapshot and replays the draw.
--
--   fair_version  — which derivation the spin used. 3 = v3. NULL = recorded
--                   before this column (v1/v2), verified by seed hash only.
--   pool_snapshot — the canonical pool: {v, game, prizes[{id,label,emoji,
--                   rarity,w}], modifiers{happyHour, pity, focus, chase}}.
--                   Fan-safe fields only (it is shown on the public verify
--                   page): never a cost or any other creator-private field.
--   pool_hash     — SHA-256 (hex) of the snapshot's canonical JSON.
--   fair_trace    — what happened after the RNG was fixed: limited prizes
--                   drawn but sold out mid-spin, in order, and the prize won.
--                   The replay re-checks each entry.
--
-- Columns only: no function is created or redefined, so no grants change.
-- Spins stay service-role-written (no insert/update policy for anon or
-- authenticated); the existing spins_select policy covers reads.

alter table public.spins add column if not exists fair_version smallint
  check (fair_version is null or fair_version in (1, 2, 3));
alter table public.spins add column if not exists pool_snapshot jsonb;
alter table public.spins add column if not exists pool_hash text
  check (pool_hash is null or pool_hash ~ '^[0-9a-f]{64}$');
alter table public.spins add column if not exists fair_trace jsonb;

-- A v3 row must carry everything the replay needs.
alter table public.spins drop constraint if exists spins_fair_v3_complete;
alter table public.spins add constraint spins_fair_v3_complete
  check (fair_version is distinct from 3
         or (pool_snapshot is not null and pool_hash is not null and fair_trace is not null));
