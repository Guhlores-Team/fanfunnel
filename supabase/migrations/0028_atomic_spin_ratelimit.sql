-- 0028 Atomic per-fan spin rate limit (multi-review Audit 2 #1 — HIGH).
--
-- RACE: the old claim_spin enforced "8 spins / 10s" by COUNTING public.spins rows
-- in the window, but the app inserts the spin row AFTER claim_spin returns. So N
-- concurrent calls all read the same stale count (often 0) and every one passes —
-- the rate limit is bypassable in a burst. (Balance integrity was already safe:
-- the `update fan_passes ... where spins_remaining > 0` is row-locked, so the
-- balance can't go negative — only the rate limit raced.)
--
-- FIX: keep the window counter IN-ROW on fans and enforce it under `FOR UPDATE`,
-- so concurrent claims for the same fan serialize and the count is never stale.
-- Fixed-window (vs rolling) is sufficient for anti-burst/anti-bot.

alter table public.fans
  add column if not exists rl_window_start timestamptz,
  add column if not exists rl_count int not null default 0;

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
  -- enforce a fixed-window counter held IN-ROW (independent of the post-hoc
  -- public.spins insert that made the old rolling count race-prone).
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

  -- Keep the fan-level aggregate (sum of passes) in lockstep.
  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

-- Preserve the 0027 lockdown (create-or-replace keeps ACLs, but be explicit).
revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;
