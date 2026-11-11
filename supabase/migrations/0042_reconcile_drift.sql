-- 0042: Reconcile live-database drift (re-assert the repo's final state).
--
-- WHY THIS EXISTS: several migration files were edited (or renumbered) AFTER
-- they had already been applied to the live databases. `supabase db push` only
-- applies versions it has not recorded yet, so those post-apply edits never
-- reached TEST or PROD: both record the versions as applied, yet their catalogs
-- differ from what migrations/0001..0041 build. (Example: an early branch
-- shipped the fan-spin aggregate trigger as version 0025, so TEST recorded 0025
-- and the real 0025_account_settings, whose columns and RPCs are below, never
-- ran there.) Read-only fingerprinting on 2026-10-26 found:
--   TEST (recorded through 0041)
--     missing columns   profiles.notify_new_spin / notify_low_balance / notify_messages
--     missing functions credit_pass_spins, set_display_name, set_notification_prefs
--     stale bodies      current_user_active, set_chat_settings, sync_fan_spin_aggregate
--     stale policies    *_rw on campaign_packs, dm_templates, happy_hours,
--                       prize_templates, referrals, webhooks, wheel_templates,
--                       wishlists (pre-0032 shape: no current_user_active() gate)
--     extra policies    campaigns_rw, grants_rw, messages_rw (0014 drops them)
--   PROD (recorded through 0038; 0039..0041 apply before this one)
--     missing           org_invites + its two policies, org_invite_creator /
--                       org_invite_respond / org_invite_revoke (0018)
--     stale bodies      admin_reserve_account_deletion (0031), handle_new_user (0011)
--     extra policies    campaigns_rw, fan_passes_rw, fans_rw, grants_rw,
--                       messages_rw, prizes_rw, redemptions_rw, wheels_rw (0014 drops them)
--
-- WHAT IT DOES: re-states each of those objects exactly as the repo's final
-- migrations define them, so every starting state converges on the repo:
--   1. add the 0025 profiles.notify_* columns if missing;
--   2. create-or-replace the eight non-org_invite functions above with their
--      final bodies,
--      re-wire trg_sync_fan_spin_aggregate (0035), and re-apply the repo's own
--      grants/revokes for those functions. credit_pass_spins stays server-only
--      (0027): revoked from public/anon/authenticated, granted to service_role.
--      The revoke runs AFTER the create, so a database whose default privileges
--      hand new functions to anon/authenticated (Supabase) cannot keep them;
--   3. create org_invites (0018) with its index, RLS and both policies if
--      missing, and create-or-replace its three org_invite_* RPCs;
--   4. drop + re-create the nine 0032 creator-config *_rw policies;
--   5. drop the owner-only *_rw policies on wheels, prizes, fans, fan_passes,
--      campaigns, redemptions, grants and messages. 0014 replaced them with
--      *_select / *_write and the repo's final state has no policy of those
--      names. Permissive policies OR together, so leaving them in place would
--      keep those tables wider than the repo's RLS (no is_active/can_act_for gate).
--
-- IDEMPOTENT, and a no-op on a database built cleanly from 0001..0041: the
-- catalog is identical before and after (scripts/db/schema-drift-check.mjs).
-- No DROP TABLE / DELETE / TRUNCATE; the only things dropped are policies the
-- repo itself drops. No other grant, policy or function is touched.

-- 1. Columns (0025_account_settings). They come first: set_notification_prefs
--    is LANGUAGE sql, so its body is checked against them at create time.
alter table public.profiles
  add column if not exists notify_new_spin boolean not null default true;
alter table public.profiles
  add column if not exists notify_low_balance boolean not null default true;
alter table public.profiles
  add column if not exists notify_messages boolean not null default true;

-- 2. Functions, final definitions.
-- current_user_active (0032): the active-state gate the *_rw policies call.
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
  );
$$;

-- set_display_name / set_notification_prefs (0025): self-only profile updates.
create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set display_name = coalesce(nullif(trim(p_name), ''), display_name)
   where id = auth.uid();
$$;

create or replace function public.set_notification_prefs(
  p_new_spin boolean, p_low_balance boolean, p_messages boolean
)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set notify_new_spin    = coalesce(p_new_spin, notify_new_spin),
         notify_low_balance = coalesce(p_low_balance, notify_low_balance),
         notify_messages    = coalesce(p_messages, notify_messages)
   where id = auth.uid();
$$;

grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean) to authenticated;

-- set_chat_settings (0029): self-only, and refused for a suspended account.
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true;
$$;

grant execute on function public.set_chat_settings(text, text) to authenticated;

-- credit_pass_spins (0024): referral bonus credit. SERVER-ONLY (0027).
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

revoke execute on function public.credit_pass_spins(uuid, int) from public, anon, authenticated;
grant  execute on function public.credit_pass_spins(uuid, int) to service_role;

-- sync_fan_spin_aggregate + its trigger (0035): fans.spins_remaining is the sum
-- of the fan's active passes. Drop + create (one transaction) re-wires the
-- trigger with the final definition whether it was present, stale or missing.
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

-- admin_reserve_account_deletion (0031): only an ACTIVE admin may reserve.
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an ACTIVE admin (defense in depth; the route checks too).
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  -- Lock the target row; missing => not found.
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    -- Lock ALL admin rows so concurrent reservations serialize here.
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    -- Atomic reservation: demote so a concurrent call sees one fewer admin.
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;

grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;

-- handle_new_user (0011): new signups land as approval_status = 'pending'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, approval_status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 3. org_invites (0018_agency_invites): creator invite & consent, exactly as
--    0018 defines it (no later migration changes it; 0030 only locks the
--    separate org_add_creator).
create table if not exists public.org_invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  email      text not null,                       -- lowercased target email
  status     text not null default 'pending',     -- pending|accepted|declined|revoked
  created_at timestamptz not null default now(),
  unique (org_id, email)
);
create index if not exists org_invites_email_idx on public.org_invites(lower(email));

alter table public.org_invites enable row level security;

drop policy if exists org_invites_owner on public.org_invites;
create policy org_invites_owner on public.org_invites for all
  using (public._owns_org(org_id) or public.is_admin())
  with check (public._owns_org(org_id) or public.is_admin());

drop policy if exists org_invites_invitee_read on public.org_invites;
create policy org_invites_invitee_read on public.org_invites for select
  using (lower(email) = lower((select email from public.profiles where id = auth.uid())));

create or replace function public.org_invite_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) limit 1;
  if v_creator is null then return 'no_such_user'; end if;
  if v_org is not null then
    return case when v_org = p_org then 'already_in_org' else 'already_in_org' end;
  end if;
  insert into public.org_invites (org_id, email, status)
    values (p_org, lower(trim(p_email)), 'pending')
    on conflict (org_id, email)
      do update set status = 'pending', created_at = now()
      where org_invites.status <> 'accepted';
  return 'ok';
end;
$$;

create or replace function public.org_invite_respond(p_invite uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_inv record; v_my_email text; v_my_org uuid;
begin
  select email, org_id into v_my_email, v_my_org from public.profiles where id = auth.uid();
  select * into v_inv from public.org_invites where id = p_invite;
  if v_inv is null then return 'gone'; end if;
  if lower(v_inv.email) <> lower(coalesce(v_my_email, '')) then return 'not_invitee'; end if;
  if v_inv.status <> 'pending' then return 'gone'; end if;

  if p_accept then
    if v_my_org is not null then return 'already_in_org'; end if;
    update public.profiles set org_id = v_inv.org_id where id = auth.uid();
    update public.org_invites set status = 'accepted' where id = p_invite;
  else
    update public.org_invites set status = 'declined' where id = p_invite;
  end if;
  return 'ok';
end;
$$;

create or replace function public.org_invite_revoke(p_invite uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.org_invites i where i.id = p_invite and public._owns_org(i.org_id)) then
    return 'not_owner';
  end if;
  delete from public.org_invites where id = p_invite;
  return 'ok';
end;
$$;

-- 4. Creator-config *_rw policies, final 0032 shape: the self branch requires
--    an active account; admins keep access via is_admin() (also active-only).
drop policy if exists dm_templates_rw on public.dm_templates;
create policy dm_templates_rw on public.dm_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists campaign_packs_rw on public.campaign_packs;
create policy campaign_packs_rw on public.campaign_packs for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists prize_templates_rw on public.prize_templates;
create policy prize_templates_rw on public.prize_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wheel_templates_rw on public.wheel_templates;
create policy wheel_templates_rw on public.wheel_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wishlists_rw on public.wishlists;
create policy wishlists_rw on public.wishlists for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists referrals_rw on public.referrals;
create policy referrals_rw on public.referrals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists webhooks_rw on public.webhooks;
create policy webhooks_rw on public.webhooks for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists autopilot_dismissals_rw on public.autopilot_dismissals;
create policy autopilot_dismissals_rw on public.autopilot_dismissals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

-- 5. Owner-only policies that 0014 replaced with *_select / *_write. The repo's
--    final state has no policy of these names, so none may remain.
drop policy if exists wheels_rw on public.wheels;
drop policy if exists prizes_rw on public.prizes;
drop policy if exists fans_rw on public.fans;
drop policy if exists fan_passes_rw on public.fan_passes;
drop policy if exists campaigns_rw on public.campaigns;
drop policy if exists redemptions_rw on public.redemptions;
drop policy if exists grants_rw on public.grants;
drop policy if exists messages_rw on public.messages;
