-- 0049 Spend-awareness guardrail for fans (RM-6).
--
-- A fan can set a soft daily play reminder and take a break (24h / 7d / 30d).
-- Fans have no Supabase session: every write goes through a token-scoped
-- server route that uses the service role. The break is the hard part and is
-- enforced here; the reminder is soft and only drives a card on the fan page.
--
--   fans.break_until      when the fan's break ends (null = not on a break).
--                         The creator may read it (the fan drawer shows "On a
--                         break until ..." and outreach skips the fan), but
--                         only the fan sets it, and a break in force is never
--                         shortened or lifted early, by anyone. A trigger
--                         enforces both, so the creator's own fans_write
--                         policy can't be used to cut a fan's break short.
--   fan_play_reminders    the fan's daily reminder number. Private to the fan:
--                         its own table with an admin-only read policy, so the
--                         creator can't read it even through the raw API.
--                         Written only by the server (service role).
--   fan_take_break()      server-only: lengthens (never shortens) the break of
--                         the fan behind a live link token.
--   claim_spin()          redefined to refuse a spin while the fan is on a
--                         break (the spin route maps that to `on_break`).

alter table public.fans add column if not exists break_until timestamptz;

-- Only the fan (through the server) sets a break, and a break in force only
-- ever gets longer. SECURITY INVOKER on purpose: current_user is the caller's
-- role, so a creator's session (authenticated) is refused while the service
-- role and the SECURITY DEFINER fan_take_break() pass the first check.
create or replace function public.guard_fan_break()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.break_until is distinct from old.break_until then
    if current_user in ('anon', 'authenticated') then
      raise exception 'break_until is set by the fan only' using errcode = '42501';
    end if;
    if old.break_until is not null and old.break_until > now()
       and (new.break_until is null or new.break_until < old.break_until) then
      raise exception 'a break cannot be shortened' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_fan_break on public.fans;
create trigger trg_guard_fan_break
  before update of break_until on public.fans
  for each row execute function public.guard_fan_break();

create table if not exists public.fan_play_reminders (
  fan_id     uuid primary key references public.fans(id) on delete cascade,
  daily      integer not null check (daily between 10 and 500),
  updated_at timestamptz not null default now()
);
alter table public.fan_play_reminders enable row level security;
drop policy if exists fan_play_reminders_admin_read on public.fan_play_reminders;
create policy fan_play_reminders_admin_read on public.fan_play_reminders for select
  using (public.is_admin());

create or replace function public.fan_take_break(p_token text, p_until timestamptz)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if p_until is null or p_until <= now() or p_until > now() + interval '31 days' then
    raise exception 'invalid break end' using errcode = '22023';
  end if;
  update public.fans f
     set break_until = greatest(coalesce(f.break_until, now()), p_until)
    from public.fan_passes fp
   where fp.token = p_token
     and fp.fan_id = f.id
     and fp.is_active = true
     and fp.self_excluded_at is null
     and f.blocked_at is null
  returning f.break_until into v_until;
  return v_until; -- null: no live link for this token
end;
$$;

revoke execute on function public.fan_take_break(text, timestamptz) from public, anon, authenticated;
grant  execute on function public.fan_take_break(text, timestamptz) to service_role;

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
     and f.blocked_at is null
     and (f.break_until is null or f.break_until <= now());
  if v_fan is null then
    return null; -- bad/inactive/blocked/self-excluded token, or on a break
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

  -- Touch ONLY last_spin_at here. trg_sync_fan_spin_aggregate (0025) already set
  -- fans.spins_remaining to the new sum of passes after the decrement above;
  -- decrementing it again would double-count.
  update public.fans set last_spin_at = now() where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;
