-- 0039: Record how each spin obtained its server seed.
--
-- Re-hashing a seed stored next to its own hash proves only that the pair is
-- self-consistent, not that the hash was published before the spin. The spin
-- path now tags every row so the public verify page claims exactly the
-- guarantee the spin has:
--   published — the pass's pre-committed seed; its hash was on the fan's spin
--               page before the request.
--   stored    — a concurrent spin consumed the shown commitment first; this
--               spin consumed the seed that spin committed (stored before it
--               was consumed, but its hash reached the fan only in the other
--               spin's response).
--   fresh     — generated at spin time (legacy pass with no commitment, or a
--               pre-0022 DB): nothing was published in advance.
-- NULL on spins recorded before this column existed (commitment unknown).

alter table public.spins add column if not exists seed_commitment text
  check (seed_commitment is null or seed_commitment in ('published', 'stored', 'fresh'));
