-- 0056 Web push: closed-tab notifications for creators.
--
-- push_subscriptions: one row per browser/device a creator turned push on for.
-- The creator manages ONLY their own devices (list, remove, the per-device
-- "show names and prizes on the lock screen" switch, owner decision D9, off by
-- default). Columns a creator may write are granted explicitly: they insert
-- their own device and may update show_details and nothing else, so they can't
-- reassign a device to another account or forge the delivery bookkeeping
-- (last_success_at, failures). Suspended creators (is_active = false) lose
-- access through current_user_active(), like every creator-owned table (0032).
--
-- push_log: one row per notification sent to an account, so the same feed item
-- (event) is never pushed twice and a thread is throttled. Written only by the
-- server's service role; a creator can read their own rows and nothing else.
--
-- Sending runs server-side through the service client
-- (src/lib/push/notify.ts, server-only), never from the browser.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique
    check (endpoint ~ '^https://' and length(endpoint) <= 1024),
  p256dh text not null check (length(p256dh) between 1 and 256),
  auth text not null check (length(auth) between 1 and 64),
  show_details boolean not null default false,
  user_agent text check (user_agent is null or length(user_agent) <= 80),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures integer not null default 0 check (failures >= 0)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions for insert
  with check (user_id = auth.uid() and public.current_user_active());

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions for update
  using (user_id = auth.uid() and public.current_user_active())
  with check (user_id = auth.uid() and public.current_user_active());

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions for delete
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;
grant insert (user_id, endpoint, p256dh, auth, show_details, user_agent)
  on public.push_subscriptions to authenticated;
grant update (show_details) on public.push_subscriptions to authenticated;

create table if not exists public.push_log (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null check (length(item_id) <= 200),
  tag text not null check (length(tag) <= 120),
  sent_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists push_log_user_tag_idx on public.push_log (user_id, tag, sent_at desc);

alter table public.push_log enable row level security;

drop policy if exists push_log_select on public.push_log;
create policy push_log_select on public.push_log for select
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

revoke all on public.push_log from public, anon, authenticated;
grant select on public.push_log to authenticated;


-- Approval is authorization, not just dashboard navigation ------------------
-- New self-signups start active but pending. Every creator business write,
-- agency action and push subscription must also require admin approval.
-- Read-only own-account access and personal account/application settings remain
-- available. An active admin role is approved for its own creator operations
-- even on legacy profiles whose approval_status is still pending; cross-account
-- admin power continues to require is_admin(), including its aal2 check.
-- No roles or permissions are read from user/app metadata. Existing grants and
-- SECURITY DEFINER search paths are preserved by CREATE OR REPLACE.
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
      and (approval_status = 'approved' or role = 'admin')
  );
$$;

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
  v_active boolean;
begin
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_active
      and (approval_status = 'approved' or role = 'admin')
  ) into v_active;

  -- The creator themselves: always 'view'; every mutating perm needs an
  -- active account (a suspended creator gets a read-only dashboard).
  if target_creator = auth.uid() then
    return perm = 'view' or v_active;
  end if;

  -- Reaching another creator through an org seat: never while suspended.
  if not v_active then
    return false;
  end if;

  -- Find the caller's org membership that covers the target creator's org.
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles owner_profile on owner_profile.id = o.owner_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid()
     and p.org_id = o.id
     and owner_profile.is_active
     and (owner_profile.approval_status = 'approved' or owner_profile.role = 'admin')
     and p.is_active and (p.approval_status = 'approved' or p.role = 'admin')
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

create or replace function public._owns_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
                 where o.id = p_org and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public._is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.profiles p on p.id = m.profile_id
                  join public.orgs o on o.id = m.org_id
                  join public.profiles owner_profile on owner_profile.id = o.owner_id
                 where m.org_id = p_org and m.profile_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin')
                   and owner_profile.is_active
                   and (owner_profile.approval_status = 'approved' or owner_profile.role = 'admin'));
$$;

create or replace function public._owns_org_seat(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                  join public.profiles p on p.id = o.owner_id
                 where m.id = p_member and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public.org_invite_respond(p_invite uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_inv record; v_my_email text; v_my_org uuid; v_active boolean;
begin
  select email, org_id, (is_active and (approval_status = 'approved' or role = 'admin')) into v_my_email, v_my_org, v_active from public.profiles where id = auth.uid();
  if not coalesce(v_active, false) then return 'inactive'; end if;
  select * into v_inv from public.org_invites where id = p_invite;
  if v_inv is null then return 'gone'; end if;
  if not exists (
    select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
     where o.id = v_inv.org_id and p.is_active
       and (p.approval_status = 'approved' or p.role = 'admin')
  ) then return 'inactive'; end if;
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

create or replace function public.org_add_member(p_org uuid, p_email text, p_role org_role)
returns text language plpgsql security definer set search_path = public as $$
declare v_profile uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id into v_profile from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
  if v_profile is null then return 'no_such_user'; end if;
  insert into public.org_members (org_id, profile_id, role)
    values (p_org, v_profile, p_role)
    on conflict (org_id, profile_id) do update set role = excluded.role;
  return 'ok';
end;
$$;

create or replace function public.org_add_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
  if v_creator is null then return 'no_such_user'; end if;
  if v_org is not null and v_org <> p_org then return 'already_in_org'; end if;
  update public.profiles set org_id = p_org where id = v_creator;
  return 'ok';
end;
$$;

create or replace function public.org_invite_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
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

create or replace function public.import_fans(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid := auth.uid();
begin
  if v_creator is null then
    raise exception 'unauthorized';
  end if;

  if not public.current_user_active() then
    raise exception 'account is not active or approved' using errcode = '42501';
  end if;

  -- SECURITY DEFINER bypasses RLS, so verify the caller owns every referenced
  -- wheel and campaign before inserting anything that points at them.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where not exists (
      select 1 from public.wheels w
       where w.id = (r->>'wheel_id')::uuid and w.creator_id = v_creator
    )
  ) then
    raise exception 'wheel_not_owned';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (r->>'campaign_id') is not null
      and not exists (
        select 1 from public.campaigns c
         where c.id = (r->>'campaign_id')::uuid and c.creator_id = v_creator
      )
  ) then
    raise exception 'campaign_not_owned';
  end if;

  insert into public.fans (id, creator_id, display_name, spins_remaining, spins_granted_total)
  select (r->>'fan_id')::uuid, v_creator,
         coalesce(nullif(r->>'name', ''), 'Fan'),
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.fan_passes
         (id, token, creator_id, wheel_id, fan_id, campaign_id, spins_remaining, spins_granted_total)
  select (r->>'pass_id')::uuid, r->>'token', v_creator,
         (r->>'wheel_id')::uuid, (r->>'fan_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.grants
         (creator_id, fan_id, fan_pass_id, campaign_id, spins, amount_cents, bonus_spins)
  select v_creator, (r->>'fan_id')::uuid, (r->>'pass_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'amount_cents')::int, 0
    from jsonb_array_elements(p_rows) r;
end;
$$;

create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;

create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true and public.current_user_active();
$$;

create or replace function public.set_pwa_icon_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_mode is null or p_mode not in ('neutral', 'avatar') then
    raise exception 'invalid pwa_icon_mode' using errcode = '22023';
  end if;
  update public.profiles set pwa_icon_mode = p_mode
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;
revoke execute on function public.set_pwa_icon_mode(text) from public, anon;
grant execute on function public.set_pwa_icon_mode(text) to authenticated;

create or replace function public.set_leaderboard_enabled(p_enabled boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set leaderboard_enabled = p_enabled where id = auth.uid() and public.current_user_active();
$$;


-- Daily push history cleanup ------------------------------------------------
-- Preserve the existing five-argument RPC, all existing periods and its
-- server-only grant. Include push delivery logs even for inactive accounts.
create or replace function public.run_retention_cleanup(
  p_audit_days integer,
  p_notice_days integer,
  p_tombstone_days integer,
  p_app_error_days integer,
  p_closed_invite_days integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- Matches PUSH_LOG_RETENTION_DAYS; retention.test.ts checks every SQL mirror.
  v_push_log_days constant integer := 30;
  v_push_log integer := 0;
  v_audit integer := 0;
  v_notices integer := 0;
  v_tombstones integer := 0;
  v_app_errors integer := 0;
  v_invites integer := 0;
  v_has_app_errors boolean := to_regclass('public.app_errors') is not null;
begin
  if p_audit_days is null or p_notice_days is null or p_tombstone_days is null
     or p_app_error_days is null or p_closed_invite_days is null
     or least(p_audit_days, p_notice_days, p_tombstone_days, p_app_error_days,
              p_closed_invite_days) < 1 then
    raise exception 'retention periods must be at least 1 day' using errcode = '22023';
  end if;

  delete from public.admin_audit_log
   where created_at < now() - make_interval(days => p_audit_days);
  get diagnostics v_audit = row_count;

  delete from public.creator_notices
   where created_at < now() - make_interval(days => p_notice_days);
  get diagnostics v_notices = row_count;

  delete from public.link_tombstones
   where created_at < now() - make_interval(days => p_tombstone_days);
  get diagnostics v_tombstones = row_count;

  delete from public.org_invites
   where status in ('declined', 'revoked')
     and created_at < now() - make_interval(days => p_closed_invite_days);
  get diagnostics v_invites = row_count;

  -- Deterministic, global cleanup: no future notification or active account
  -- is needed for old deduplication history to expire.
  delete from public.push_log
   where sent_at < now() - make_interval(days => v_push_log_days);
  get diagnostics v_push_log = row_count;

  if v_has_app_errors then
    execute 'delete from public.app_errors
              where resolved and resolved_at is not null
                and resolved_at < now() - make_interval(days => $1)'
      using p_app_error_days;
    get diagnostics v_app_errors = row_count;
  end if;

  return jsonb_build_object(
    'push_log', v_push_log,
    'admin_audit_log', v_audit,
    'creator_notices', v_notices,
    'link_tombstones', v_tombstones,
    'org_invites', v_invites,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;
revoke execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) to service_role;
