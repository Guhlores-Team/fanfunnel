-- 0022: Provably-fair v2 — true commit-reveal.
--
-- The server now PRE-generates each pass's next spin seed and publishes only
-- its hash to the fan BEFORE the spin (so seeds can't be ground after seeing
-- the request), and the fan's browser contributes a client seed mixed into the
-- RNG. The spin row records the client seed so the public verify page can show
-- the full derivation.

alter table public.fan_passes add column if not exists next_server_seed text;
alter table public.fan_passes add column if not exists next_server_seed_hash text;

alter table public.spins add column if not exists client_seed text;
