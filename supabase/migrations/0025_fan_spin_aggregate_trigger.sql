-- 0025: make fans.spins_remaining a DERIVED value via a trigger, so it can never
-- drift from the per-wheel passes again.
--
-- Spin balances live in two places: the per-wheel fan_passes.spins_remaining
-- (authoritative — what claim_spin spends) and the fan-level fans.spins_remaining
-- aggregate (the dashboard headline). Until now every write path had to update
-- BOTH by hand; any path that updated one and not the other, or used stale
-- arithmetic, silently drifted them apart — the entire class of bug behind 0024.
--
-- Here the aggregate becomes a derived value: any insert/update/delete of a
-- fan_pass recomputes that fan's aggregate as the sum of its active passes. The
-- aggregate can no longer drift regardless of which code path writes a pass.
-- The grant/top-up paths still write the aggregate explicitly (absolute
-- value = old + delta) for pre-0025 deploy safety; that equals what the trigger
-- computes, so they agree. claim_spin, however, decremented the aggregate
-- RELATIVELY (spins_remaining - 1); with the trigger that would double-count, so
-- claim_spin is rebuilt below to decrement only the pass and let the trigger
-- sync the aggregate.

-- 1. The trigger function: resync one fan's aggregate to the sum of its active
--    passes. SECURITY DEFINER so it can update fans regardless of the writer.
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

-- 2. Rebuild claim_spin to decrement ONLY the pass; the trigger above keeps the
--    fan aggregate in sync (decrementing fans here too would double-count).
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_recent integer;
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

  -- Rolling-window rate limit (this fan's recent spins across all wheels).
  select count(*) into v_recent
    from public.spins
   where fan_id = v_fan and created_at > now() - p_window;
  if v_recent >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  end if;

  -- Decrement THIS wheel's pass balance; the trigger resyncs fans.spins_remaining.
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Touch only the fan's last_spin_at here — NOT spins_remaining (the trigger
  -- already set it to the new sum of passes; decrementing again would double).
  update public.fans set last_spin_at = now() where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

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
