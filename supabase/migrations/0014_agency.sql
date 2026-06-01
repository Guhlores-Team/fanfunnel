-- Phase 8A — Agency console: orgs own creators; seats get scoped powers.
-- Layers BESIDE the existing single-creator model (everything stays keyed to
-- creator_id = profiles.id). Backwards-compatible: a creator with no org keeps
-- working exactly as before.

-- ── Roles & tables ──────────────────────────────────────────────────────────
do $$ begin
  create type org_role as enum ('owner','manager','chatter','fulfiller','analyst');
exception when duplicate_object then null; end $$;

create table if not exists public.orgs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  billing_model text not null default 'per_seat',  -- 'per_seat' | 'rev_share'
  created_at    timestamptz not null default now()
);

-- A person (profile) holding a seat in an org, with a role.
create table if not exists public.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role       org_role not null default 'analyst',
  created_at timestamptz not null default now(),
  unique (org_id, profile_id)
);
create index if not exists org_members_profile_idx on public.org_members(profile_id);

-- Which creator accounts a seat may act for. A row here grants scope; absence
-- means no access. (owners/managers may be granted all via a wildcard app-side.)
create table if not exists public.org_member_creators (
  member_id  uuid not null references public.org_members(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  primary key (member_id, creator_id)
);

-- Which org a creator account belongs to (null = independent creator).
alter table public.profiles add column if not exists org_id uuid references public.orgs(id) on delete set null;

-- ── Permission predicate (SECURITY DEFINER avoids RLS recursion) ─────────────
-- Returns true if the current auth user may perform `perm` on `target_creator`.
-- Perms: 'view','chat','fulfil','grant','edit_wheel','manage'.
create or replace function public.can_act_for(target_creator uuid, perm text)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_role org_role;
  v_member uuid;
  v_scoped boolean;
begin
  -- The creator themselves always has full power over their own account.
  if target_creator = auth.uid() then
    return true;
  end if;

  -- Find the caller's org membership that covers the target creator's org.
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid()
     and p.org_id = o.id
   limit 1;
  if v_member is null then
    return false;
  end if;

  -- Owners and managers act for every creator in their org.
  -- Other roles must be explicitly scoped to this creator.
  if v_role in ('owner','manager') then
    v_scoped := true;
  else
    select exists(
      select 1 from public.org_member_creators mc
       where mc.member_id = v_member and mc.creator_id = target_creator
    ) into v_scoped;
  end if;
  if not v_scoped then
    return false;
  end if;

  -- Role → permission matrix.
  return case perm
    when 'view'       then true
    when 'chat'       then v_role in ('owner','manager','chatter')
    when 'fulfil'     then v_role in ('owner','manager','fulfiller')
    when 'grant'      then v_role in ('owner','manager')
    when 'edit_wheel' then v_role in ('owner','manager')
    when 'manage'     then v_role in ('owner','manager')
    else false
  end case;
end;
$$;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_member_creators enable row level security;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select
  using (owner_id = auth.uid()
         or exists(select 1 from public.org_members m where m.org_id = id and m.profile_id = auth.uid())
         or public.is_admin());
drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs for all
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select
  using (profile_id = auth.uid()
         or exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid())
         or public.is_admin());
drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for all
  using (exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid()) or public.is_admin())
  with check (exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid()) or public.is_admin());

drop policy if exists omc_rw on public.org_member_creators;
create policy omc_rw on public.org_member_creators for all
  using (exists(
           select 1 from public.org_members m join public.orgs o on o.id = m.org_id
            where m.id = member_id and o.owner_id = auth.uid())
         or public.is_admin())
  with check (exists(
           select 1 from public.org_members m join public.orgs o on o.id = m.org_id
            where m.id = member_id and o.owner_id = auth.uid())
         or public.is_admin());

-- ── Split owner `for all` policies → per-command, OR-ing in can_act_for ──────
-- Pattern per table: SELECT uses 'view'; INSERT/UPDATE/DELETE use the matching
-- write perm. Independent creators (target = auth.uid()) are unaffected because
-- can_act_for short-circuits true for self.

-- wheels (edit_wheel)
drop policy if exists wheels_rw on public.wheels;
drop policy if exists wheels_select on public.wheels;
drop policy if exists wheels_write on public.wheels;
create policy wheels_select on public.wheels for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy wheels_write on public.wheels for all
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin())
  with check (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

-- prizes inherit via their wheel's creator; keep simple: tie to wheel ownership.
drop policy if exists prizes_rw on public.prizes;
drop policy if exists prizes_select on public.prizes;
drop policy if exists prizes_write on public.prizes;
create policy prizes_select on public.prizes for select
  using (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'view') or public.is_admin())));
create policy prizes_write on public.prizes for all
  using (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'edit_wheel') or public.is_admin())))
  with check (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'edit_wheel') or public.is_admin())));

-- fans (view; edits via manage)
drop policy if exists fans_rw on public.fans;
create policy fans_select on public.fans for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy fans_write on public.fans for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- fan_passes (view; create/edit via grant — minting a link is part of granting)
drop policy if exists fan_passes_rw on public.fan_passes;
create policy fan_passes_select on public.fan_passes for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy fan_passes_write on public.fan_passes for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- campaigns (edit_wheel-level config)
drop policy if exists campaigns_rw on public.campaigns;
create policy campaigns_select on public.campaigns for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy campaigns_write on public.campaigns for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- redemptions (fulfil)
drop policy if exists redemptions_rw on public.redemptions;
create policy redemptions_select on public.redemptions for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy redemptions_write on public.redemptions for all
  using (public.can_act_for(creator_id, 'fulfil') or public.is_admin())
  with check (public.can_act_for(creator_id, 'fulfil') or public.is_admin());

-- grants (grant — money in)
drop policy if exists grants_rw on public.grants;
create policy grants_select on public.grants for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy grants_write on public.grants for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- messages (chat)
drop policy if exists messages_rw on public.messages;
create policy messages_select on public.messages for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy messages_write on public.messages for all
  using (public.can_act_for(creator_id, 'chat') or public.is_admin())
  with check (public.can_act_for(creator_id, 'chat') or public.is_admin());

-- ── Org roll-up stats (generalized admin_account_stats, scoped to an org) ────
create or replace function public.org_account_stats(p_org uuid)
returns table (
  id uuid, email text, display_name text, role app_role, is_active boolean,
  features jsonb, wheels bigint, fans bigint, spins bigint, pending bigint,
  revenue bigint
)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.role, p.is_active, p.features,
         (select count(*) from public.wheels w where w.creator_id = p.id),
         (select count(*) from public.fans f where f.creator_id = p.id),
         (select count(*) from public.spins s where s.creator_id = p.id),
         (select count(*) from public.redemptions r where r.creator_id = p.id and r.status = 'pending'),
         (select coalesce(sum(g.amount_cents),0) from public.grants g where g.creator_id = p.id)
    from public.profiles p
   where p.org_id = p_org
     and (
       exists(select 1 from public.orgs o where o.id = p_org and o.owner_id = auth.uid())
       or exists(select 1 from public.org_members m where m.org_id = p_org and m.profile_id = auth.uid())
       or public.is_admin()
     );
$$;
