-- 0024: Make per-wheel spin balances authoritative and heal drifted counts.
--
-- Root cause of "the fan page shows 3 at load but they really have 2, and it
-- only fixes itself after a spin": DBs initialised from schema.sql shipped a
-- claim_spin that decremented the FAN aggregate (fans.spins_remaining) but never
-- the per-wheel pass (fan_passes.spins_remaining) — even though the fan page and
-- dashboard DISPLAY the pass. So every spin left the pass stale-high while the
-- aggregate fell, the two disagreed (pass 3 vs aggregate 2), and the page only
-- "corrected" once claim_spin returned the lower aggregate.
--
-- This migration (1) installs the correct pass-decrementing claim_spin, (2)
-- reconciles existing pass balances from real spin history, (3) snaps each fan
-- aggregate to the sum of its passes, and (4) adds a helper so fan-level bonuses
-- (referrals) land on a spendable pass.

-- 1. claim_spin: decrement THIS pass (per-wheel) and keep the fan aggregate in
--    lockstep. `create or replace` overrides any older fan-only version that a
--    schema.sql setup may have left in place.
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

  -- Decrement THIS wheel's pass balance.
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Keep the fan-level aggregate (sum of passes) in lockstep.
  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

-- 2. Heal existing PASS balances from actual spin history: a pass's remaining =
--    spins granted to it minus spins actually taken on it (never below 0). This
--    repairs passes that never decremented under the old claim_spin.
update public.fan_passes p
   set spins_remaining = greatest(0, p.spins_granted_total - coalesce(s.cnt, 0))
  from (
    select fan_pass_id, count(*)::int as cnt
      from public.spins
     where fan_pass_id is not null
     group by fan_pass_id
  ) s
 where s.fan_pass_id = p.id;

-- 3. Snap every fan aggregate to the sum of its active passes (covers fans with
--    no spins to reconcile above, e.g. drift from the old referral credit path).
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

-- 4. Credit N spins to a fan's OLDEST active pass (spendable) and resync the
--    aggregate. Used for referral bonuses so they land somewhere spinnable
--    instead of inflating the fan aggregate only.
create or replace function public.credit_pass_spins(p_fan_id uuid, p_spins int)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_pass uuid;
begin
  if p_spins is null or p_spins <= 0 then
    return;
  end if;

  -- Oldest active pass = the fan's original link (matches the 0020 backfill).
  select id into v_pass
    from public.fan_passes
   where fan_id = p_fan_id and is_active = true
   order by created_at asc
   limit 1;
  if v_pass is null then
    return; -- no active pass to credit; nothing spendable to add to
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining + p_spins,
         spins_granted_total = spins_granted_total + p_spins
   where id = v_pass;

  -- Keep the fan-level aggregate exactly equal to the sum of passes.
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0)
   where f.id = p_fan_id;
end;
$$;
