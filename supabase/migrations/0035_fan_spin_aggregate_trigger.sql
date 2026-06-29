-- 0035: derive fans.spins_remaining via a trigger, and stop claim_spin
-- double-decrementing it. Consolidated + renumbered after 0034 so it applies in
-- order on a prod DB that already has 0025_account_settings (the old branch put
-- the trigger at 0025, colliding with that version — Supabase keys migrations by
-- numeric prefix and would have SKIPPED it, leaving the trigger uninstalled).
--
-- Spin balances live in two places: the per-wheel fan_passes.spins_remaining
-- (authoritative — what claim_spin spends) and the fan-level fans.spins_remaining
-- aggregate (the dashboard headline). Making the aggregate a DERIVED value (sum of
-- active passes, maintained by a trigger) stops the two drifting apart. Because
-- 0028's claim_spin ALSO decremented the aggregate explicitly, with the trigger
-- present that would subtract twice per spin — so claim_spin is rebuilt here to
-- decrement only the pass and let the trigger sync the aggregate, while keeping
-- 0028's atomic fixed-window rate limit exactly.
--
-- NON-DESTRUCTIVE: no DROP/DELETE/TRUNCATE. The one-time resync only recomputes
-- the fans aggregate from the passes (correcting any prior drift); it does not
-- touch accounts, admins, wheels, prizes, fans, or links.

-- 1. Trigger function: resync one fan's aggregate to the sum of its active passes.
create or replace function public.sync_fan_spin_aggregate()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid := coalesce(new.fan_id, old.fan_id);
begin
  if v_fan is null then
    return null;
  end if;
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0)
   where f.id = v_fan;
  return null; -- AFTER trigger; updates fans (not fan_passes) so no recursion
end;
$$;

drop trigger if exists trg_sync_fan_spin_aggregate on public.fan_passes;
create trigger trg_sync_fan_spin_aggregate
  after insert or delete
     or update of spins_remaining, spins_granted_total, is_active, fan_id
  on public.fan_passes
  for each row execute function public.sync_fan_spin_aggregate();

-- 2. claim_spin: 0028's atomic fixed-window rate limit, but the final fans update
--    touches ONLY last_spin_at (the trigger owns spins_remaining — no double).
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_win_start timestamptz;
  v_win_count int;
  remaining integer;
  p_max integer := 8;                       -- max spins per window
  p_window interval := interval '10 seconds';
begin
  select fp.fan_id into v_fan
    from public.fan_passes fp
    join public.fans f on f.id = fp.fan_id
   where fp.token = p_token
     and fp.is_active = true
     and fp.self_excluded_at is null
     and f.blocked_at is null;
  if v_fan is null then
    return null; -- bad/inactive/blocked/self-excluded token
  end if;

  -- Atomic rate limit: lock the fan row so concurrent claims serialize, then
  -- enforce a fixed-window counter held IN-ROW.
  select rl_window_start, rl_count into v_win_start, v_win_count
    from public.fans where id = v_fan for update;
  if v_win_start is null or now() - v_win_start > p_window then
    update public.fans set rl_window_start = now(), rl_count = 1 where id = v_fan;
  elsif v_win_count >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  else
    update public.fans set rl_count = rl_count + 1 where id = v_fan;
  end if;

  -- Decrement THIS wheel's pass balance (row-locked; can't go below 0).
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Touch ONLY last_spin_at; trg_sync_fan_spin_aggregate already set
  -- fans.spins_remaining to the new sum of passes. Decrementing again = double.
  update public.fans set last_spin_at = now() where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

-- Preserve the 0027/0028 lockdown (create-or-replace keeps ACLs, but be explicit).
revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;

-- 3. One-time resync so the aggregate matches the invariant immediately.
update public.fans f
   set spins_remaining = coalesce((
         select sum(p.spins_remaining) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0),
       spins_granted_total = coalesce((
         select sum(p.spins_granted_total) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0)
 where exists (
   select 1 from public.fan_passes p where p.fan_id = f.id and p.is_active
 );
