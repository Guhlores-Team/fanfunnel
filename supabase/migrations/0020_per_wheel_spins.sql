-- Per-wheel spins: spins belong to the wheel/campaign they were bought for.
-- Each fan_pass (one per wheel link) now holds its OWN balance; the fan's
-- spins_remaining stays as a maintained sum across passes so existing
-- aggregate reads keep working. Backwards-compatible on upgrade.

alter table public.fan_passes add column if not exists spins_remaining int not null default 0;
alter table public.fan_passes add column if not exists spins_granted_total int not null default 0;
alter table public.grants add column if not exists fan_pass_id uuid references public.fan_passes(id) on delete set null;

-- Backfill: move each fan's existing balance onto their OLDEST pass (the link
-- they've been using), so nothing is lost when this migration runs.
with ranked as (
  select id, fan_id,
         row_number() over (partition by fan_id order by created_at asc) as rn
    from public.fan_passes
)
update public.fan_passes fp
   set spins_remaining = f.spins_remaining,
       spins_granted_total = f.spins_granted_total
  from ranked r
  join public.fans f on f.id = r.fan_id
 where fp.id = r.id and r.rn = 1;

-- Attribute existing grants to each fan's oldest pass (best effort).
update public.grants g
   set fan_pass_id = (
     select id from public.fan_passes fp
      where fp.fan_id = g.fan_id
      order by created_at asc limit 1
   )
 where g.fan_pass_id is null;

-- Rebuild claim_spin to decrement THIS pass's balance (per-wheel), keep the
-- fan-level aggregate in sync, and preserve the rate limit + block / self-
-- exclude guards from 0012.
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

  -- Rolling-window rate limit (counts this fan's recent spins across all wheels).
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

  -- Keep the fan-level aggregate (sum of passes) in sync.
  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;
