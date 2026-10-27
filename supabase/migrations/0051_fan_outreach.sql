-- 0051 Win-back outreach log (RM-5).
--
-- One row per win-back action a creator (or an org seat acting for them) took
-- on a fan: "contacted" (contacted_at set; the creator copied a filled DM to
-- paste into their own DMs, FanFunnel sends nothing) or "snoozed"
-- (contacted_at null, snoozed_until set). The dashboard derives the rest:
-- the 14-day contact cooldown, the snooze, and "came back" (a spin after
-- contacted_at), so no other table changes.
--
-- Append-only from the client: SELECT and INSERT policies only. With no
-- UPDATE or DELETE policy, RLS refuses both; rows go away with the fan or the
-- creator (cascade). The insert check pins the fan (and any template) to the
-- same creator, so a row can never point one creator's log at another's fan.
-- No function is added, so nothing new is executable by anon (0044's rule).
create table if not exists public.fan_outreach (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  fan_id        uuid not null references public.fans(id) on delete cascade,
  template_id   uuid references public.dm_templates(id) on delete set null,
  kind          text not null default 'winback' check (kind in ('winback')),
  contacted_at  timestamptz,
  snoozed_until timestamptz,
  created_at    timestamptz not null default now(),
  constraint fan_outreach_has_action check (contacted_at is not null or snoozed_until is not null)
);
create index if not exists fan_outreach_creator_created_idx
  on public.fan_outreach (creator_id, created_at desc);
create index if not exists fan_outreach_fan_idx on public.fan_outreach (fan_id);

alter table public.fan_outreach enable row level security;

drop policy if exists fan_outreach_select on public.fan_outreach;
create policy fan_outreach_select on public.fan_outreach for select
  using ((public.can_act_for(creator_id, 'view') and public.current_user_active()) or public.is_admin());

drop policy if exists fan_outreach_insert on public.fan_outreach;
create policy fan_outreach_insert on public.fan_outreach for insert
  with check (
    (public.can_act_for(creator_id, 'chat') or public.is_admin())
    and exists (
      select 1 from public.fans f
       where f.id = fan_outreach.fan_id and f.creator_id = fan_outreach.creator_id
    )
    and (
      fan_outreach.template_id is null
      or exists (
        select 1 from public.dm_templates t
         where t.id = fan_outreach.template_id and t.creator_id = fan_outreach.creator_id
      )
    )
  );

-- Signed-in creators only; anon never reads or writes the log.
revoke all on table public.fan_outreach from anon;
