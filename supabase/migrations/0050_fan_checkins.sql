-- 0050 Fan check-ins for the visit glow (RM-3).
--
-- One row per fan per calendar day the fan opened one of their links (the
-- fan's own date, clamped server-side to UTC today ± 1 day). The fan page
-- glows brighter the more of the last 7 days hold a row. Purely visual: no
-- function reads this table to grant spins or change odds.
--
-- Writes: only the server, with the service role, for the fan behind an ACTIVE
-- link token (POST /api/fan/checkin). There is deliberately NO insert, update
-- or delete policy, and those privileges are revoked from anon and
-- authenticated, so neither a fan nor a creator can write a visit.
-- Reads: the owning creator (active), an org member with 'view' on that
-- creator, or an admin. Anon reads nothing. Rows go with the fan (cascade).
create table if not exists public.fan_checkins (
  fan_id     uuid not null references public.fans(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (fan_id, day)
);
create index if not exists fan_checkins_creator_day_idx on public.fan_checkins (creator_id, day);

alter table public.fan_checkins enable row level security;
drop policy if exists fan_checkins_select on public.fan_checkins;
create policy fan_checkins_select on public.fan_checkins for select
  using ((creator_id = auth.uid() and public.current_user_active())
         or public.can_act_for(creator_id, 'view')
         or public.is_admin());

revoke all on table public.fan_checkins from anon;
revoke insert, update, delete, truncate on table public.fan_checkins from authenticated;
