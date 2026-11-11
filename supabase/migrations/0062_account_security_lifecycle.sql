-- 0062: enrolled creator MFA, bounded consent invitations, active-admin safety.
-- No public fan credential is changed. Only authenticated business access uses
-- the signed session assurance and authoritative Auth factor records.
create or replace function public._session_mfa_satisfied()
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and (
    coalesce(auth.jwt()->>'aal','')='aal2' or not exists (
      select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified'
    )
  );
$$;
revoke execute on function public._session_mfa_satisfied() from public,anon,authenticated;
grant execute on function public._session_mfa_satisfied() to service_role;


create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public._session_mfa_satisfied() and exists(
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
  if not public._session_mfa_satisfied() then return false; end if;
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
  select public._session_mfa_satisfied() and exists(select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
                 where o.id = p_org and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public._is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._session_mfa_satisfied() and exists(select 1 from public.org_members m join public.profiles p on p.id = m.profile_id
                  join public.orgs o on o.id = m.org_id
                  join public.profiles owner_profile on owner_profile.id = o.owner_id
                 where m.org_id = p_org and m.profile_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin')
                   and owner_profile.is_active
                   and (owner_profile.approval_status = 'approved' or owner_profile.role = 'admin'));
$$;

create or replace function public._owns_org_seat(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._session_mfa_satisfied() and exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                  join public.profiles p on p.id = o.owner_id
                 where m.id = p_member and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set display_name = coalesce(nullif(trim(p_name), ''), display_name)
   where id = auth.uid() and public._session_mfa_satisfied();
$$;

create or replace function public.set_notification_prefs(
  p_new_spin boolean, p_low_balance boolean, p_messages boolean
)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set notify_new_spin    = coalesce(p_new_spin, notify_new_spin),
         notify_low_balance = coalesce(p_low_balance, notify_low_balance),
         notify_messages    = coalesce(p_messages, notify_messages)
   where id = auth.uid() and public._session_mfa_satisfied();
$$;

create or replace function public.set_onboarding_dismissed(p_dismissed boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set onboarding_dismissed = p_dismissed where id = auth.uid() and public._session_mfa_satisfied();
$$;

create or replace function public.set_notifications_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set notifications_seen_at = now() where id = auth.uid() and public._session_mfa_satisfied();
$$;

-- A pending invitation lasts seven days. Historical accepted rows stay
-- immutable; sending a fresh invitation never reuses an expired identifier.
alter table public.org_invites add column if not exists expires_at timestamptz;
update public.org_invites set expires_at=least(created_at,clock_timestamp())+interval '7 days' where expires_at is null;
alter table public.org_invites alter column expires_at set default (now()+interval '7 days');
alter table public.org_invites alter column expires_at set not null;
alter table public.org_invites drop constraint if exists org_invites_org_id_email_key;
-- Retire duplicate pending spellings before the canonical pending-only index.
with duplicates as (
 select id,row_number() over(partition by org_id,lower(email) order by created_at desc,id desc) n
 from public.org_invites where status='pending'
) update public.org_invites set status='revoked' where id in(select id from duplicates where n>1);
create unique index if not exists org_invites_pending_email_key on public.org_invites(org_id,lower(email)) where status='pending';
create index if not exists org_invites_pending_expiry_idx on public.org_invites(expires_at) where status='pending';
-- Business mutations are consent RPCs, never a direct owner UPDATE of a stale
-- invitation's deadline/status/identifier. Existing reads remain tenant-scoped.
drop policy if exists org_invites_owner on public.org_invites;
create policy org_invites_owner on public.org_invites for select to authenticated
 using(public._owns_org(org_id) or public.is_admin());
drop policy if exists org_invites_invitee_read on public.org_invites;
create policy org_invites_invitee_read on public.org_invites for select to authenticated
 using(public.current_user_active() and lower(email)=lower((select email from public.profiles where id=auth.uid())));
revoke insert,update,delete on public.org_invites from anon,authenticated;

create or replace function public.org_invite_creator(p_org uuid,p_email text)
returns text language plpgsql security definer set search_path=public as $$
declare v_creator uuid; v_org uuid; v_inv public.org_invites%rowtype; v_time timestamptz;
begin
 if not public._owns_org(p_org) then return 'not_owner'; end if;
 if p_email is null or length(p_email)>254 then return 'no_such_user'; end if;
 -- Lock one recipient before any invite: accept and reinvite share this order.
 select id,org_id into v_creator,v_org from public.profiles
 where lower(email)=lower(trim(p_email)) and is_active
 and(approval_status='approved' or role='admin') order by id limit 1 for update;
 if v_creator is null then return 'no_such_user'; end if;
 if v_org is not null then return 'already_in_org'; end if;
 select * into v_inv from public.org_invites where org_id=p_org
 and lower(email)=lower(trim(p_email)) and status='pending' for update;
 -- Recheck the sender after every existing recipient/invitation lock wait.
 if not public._owns_org(p_org) then return 'not_owner'; end if;
 v_time:=clock_timestamp();
 if v_inv.id is not null then
   if v_inv.expires_at>v_time then return 'ok'; end if;
   update public.org_invites set status='expired' where id=v_inv.id;
 end if;
 insert into public.org_invites(org_id,email,status,created_at,expires_at)
 values(p_org,lower(trim(p_email)),'pending',v_time,v_time+interval '7 days');
 return 'ok';
end;
$$;

create or replace function public.org_invite_respond(p_invite uuid,p_accept boolean)
returns text language plpgsql security definer set search_path=public as $$
declare v_inv public.org_invites%rowtype; v_profile public.profiles%rowtype;
begin
 if not public.current_user_active() then return 'inactive'; end if;
 select * into v_profile from public.profiles where id=auth.uid() for update;
 -- Security state may change while the recipient row lock is awaited.
 if not public.current_user_active() then return 'inactive'; end if;
 select * into v_inv from public.org_invites where id=p_invite for update;
 if v_inv.id is null then return 'gone'; end if;
 if lower(v_inv.email)<>lower(coalesce(v_profile.email,'')) then return 'not_invitee'; end if;
 if v_inv.status<>'pending' then return case when v_inv.status='expired' then 'expired' else 'gone' end; end if;
 if v_inv.expires_at<=clock_timestamp() then
   update public.org_invites set status='expired' where id=p_invite;
   return 'expired';
 end if;
 if not exists(select 1 from public.orgs o join public.profiles p on p.id=o.owner_id
   where o.id=v_inv.org_id and p.is_active and(p.approval_status='approved' or p.role='admin')) then return 'inactive'; end if;
 if p_accept then
   if v_profile.org_id is not null then return 'already_in_org'; end if;
   update public.profiles set org_id=v_inv.org_id where id=auth.uid();
   update public.org_invites set status='accepted' where id=p_invite;
 else
   update public.org_invites set status='declined' where id=p_invite;
 end if;
 return 'ok';
end;
$$;


create or replace function public.org_invite_revoke(p_invite uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_inv public.org_invites%rowtype;
begin
 select * into v_inv from public.org_invites where id=p_invite for update;
 if v_inv.id is null then return 'gone'; end if;
 if not public._owns_org(v_inv.org_id) then return 'not_owner'; end if;
 if v_inv.status<>'pending' then return 'gone'; end if;
 update public.org_invites set status=case when expires_at<=clock_timestamp() then 'expired' else 'revoked' end where id=p_invite;
 return 'ok';
end;
$$;

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

  delete from public.creator_actor_contexts where expires_at<=clock_timestamp();
  delete from public.org_invites
   where (status in ('declined','revoked') and created_at<now()-make_interval(days=>p_closed_invite_days))
      or (status in ('expired','pending') and expires_at<now()-make_interval(days=>p_closed_invite_days));
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

-- One serialization order for every statement that can remove an active
-- administrator. Acquire before profile row locks, never lock another admin's
-- profile while holding the target row. RLS still authorizes the actual caller.
create or replace function public._serialize_active_admins()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
 return null;
end;
$$;
revoke execute on function public._serialize_active_admins() from public,anon,authenticated;
drop trigger if exists profiles_admin_serialization on public.profiles;
create trigger profiles_admin_serialization before update of role,is_active or delete on public.profiles
 for each statement execute function public._serialize_active_admins();

create or replace function public._preserve_active_admin()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- A statement can wait behind another admin mutation. Recheck the actual
 -- authenticated caller after that serialization, not a stale outer RLS read.
 if current_setting('role',true)='authenticated' and (
   coalesce(auth.jwt()->>'aal','')<>'aal2' or not exists(
     select 1 from public.profiles p where p.id=auth.uid() and p.role='admin' and p.is_active
   )
 ) then raise exception 'admin authorization changed' using errcode='42501'; end if;
 if old.role='admin' and old.is_active and
    (tg_op='DELETE' or new.role<>'admin' or not new.is_active) and
    not exists(select 1 from public.profiles p where p.id<>old.id and p.role='admin' and p.is_active) then
   raise exception 'last_active_admin' using errcode='P0001';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
revoke execute on function public._preserve_active_admin() from public,anon,authenticated;
drop trigger if exists profiles_preserve_active_admin on public.profiles;
create trigger profiles_preserve_active_admin before update of role,is_active or delete on public.profiles
 for each row execute function public._preserve_active_admin();

create or replace function public.reserve_self_account_deletion(p_user uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_profile public.profiles%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
 select * into v_profile from public.profiles where id=p_user for update;
 if v_profile.id is null then return 'not_found'; end if;
 if v_profile.role='admin' then
   if v_profile.is_active and not exists(select 1 from public.profiles where id<>p_user and role='admin' and is_active) then return 'last_admin'; end if;
   update public.profiles set role='creator' where id=p_user;
 end if;
 return 'ok';
end;
$$;
revoke execute on function public.reserve_self_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.reserve_self_account_deletion(uuid) to service_role;

create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path=public as $$
begin
 if not public.is_admin() then return 'forbidden'; end if;
 if p_target=auth.uid() then return 'cannot_delete_self'; end if;
 return public.reserve_self_account_deletion(p_target);
end;
$$;
revoke execute on function public.admin_reserve_account_deletion(uuid) from public,anon;
grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;


create or replace function public.creator_storage_account(p_operation text, p_owner uuid, p_was_admin boolean default false, p_worker uuid default null, p_actor uuid default null, p_action text default 'account.self_close', p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.creator_storage_deletions%rowtype; v_profile public.profiles%rowtype; v_hashes jsonb; v_reserve text;
begin
  perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
  if p_error is not null and p_error not in ('storage_cleanup_failed', 'delete_failed', 'db_error', 'upload_unconfirmed') then raise exception 'invalid work error' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select * into v_profile from public.profiles where id = p_owner for update;
  select * into v_job from public.creator_storage_deletions where owner_id = p_owner for update;
  if p_operation = 'begin' then
    if (p_action = 'account.self_close' and p_actor is distinct from p_owner) or
       (p_action = 'account.delete' and (p_actor = p_owner or not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active))) or
       p_action not in ('account.self_close', 'account.delete') then raise exception 'deletion actor forbidden' using errcode = '42501'; end if;
    if v_job.owner_id is not null and v_job.state <> 'paused' then
      return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
    end if;
    if v_profile.id is null then raise exception 'account missing' using errcode = '22023'; end if;
    -- Reservation and durable quiescence commit together: a crash cannot leave
    -- an admin demoted with no deletion record to resume or restore.
    v_reserve := public.reserve_self_account_deletion(p_owner);
    if v_reserve <> 'ok' then return jsonb_build_object('error', v_reserve); end if;
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') h from public.fan_passes where creator_id = p_owner) hashes;
    if jsonb_array_length(v_hashes) > 100000 then raise exception 'too many links' using errcode = '54000'; end if;
    insert into public.creator_storage_deletions (owner_id, state, was_role, was_active, actor_id, action, link_hashes)
      values (p_owner, 'pending', v_profile.role, v_profile.is_active, p_actor, p_action, v_hashes)
      on conflict (owner_id) do update set state = 'pending', attempt_id=gen_random_uuid(), was_role = excluded.was_role, was_active = excluded.was_active, actor_id = excluded.actor_id, action = excluded.action,
        link_hashes = excluded.link_hashes, lease_id = null, lease_until = null, updated_at = now(), last_error = null
      returning * into v_job;
    update public.profiles set is_active = false where id = p_owner;
    -- Re-arm only after our own reservation/quiescence updates, with the
    -- profile row still locked. An external admin cannot interleave here.
    update public.creator_storage_deletions set restore_allowed=true where owner_id=p_owner;
    update public.creator_storage_objects set cleanup_kind = 'account', deletion_attempt=v_job.attempt_id, updated_at = now() where owner_id = p_owner and removed_at is null;
    insert into public.creator_storage_dispatches(id,owner_id,attempt_id,kind,object_id,bucket,path,state,settled_at)
      select gen_random_uuid(),p_owner,v_job.attempt_id,'manifest',id,bucket,path,'acknowledged',now() from public.creator_storage_objects where owner_id=p_owner and removed_at is null
      on conflict(attempt_id,object_id) where kind='manifest' do nothing;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.owner_id is null then return null; end if;
  if v_job.state = 'complete' then return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes)); end if;
  if p_operation = 'claim' then
    if v_job.state in ('paused', 'complete') or (v_job.lease_until > now() and v_job.lease_id is distinct from p_worker) then return null; end if;
    if p_worker is null then raise exception 'worker id required' using errcode = '22023'; end if;
    update public.creator_storage_deletions set lease_id = p_worker, lease_until = now() + interval '3 minutes', attempts = attempts + 1, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.lease_id is distinct from p_worker or v_job.lease_until <= now() then return null; end if;
  if p_operation = 'check' then
    update public.creator_storage_deletions set lease_until=now()+interval '3 minutes' where owner_id=p_owner;
    return jsonb_build_object('state',v_job.state,'attempt_id',v_job.attempt_id);
  end if;
  if p_operation = 'prepare' then
    if exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null and upload_state in ('inflight', 'uncertain')) then return jsonb_build_object('state', 'pending'); end if;
    if v_profile.id is not null and v_profile.is_active then raise exception 'account not quiesced' using errcode = '42501'; end if;
    -- Refresh hashes immediately before the auth call; only hashes survive it.
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct value h from jsonb_array_elements_text(v_job.link_hashes) union select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') from public.fan_passes where creator_id = p_owner) hashes;
    if exists(select 1 from public.creator_storage_objects where owner_id=p_owner and removed_at is null) then return jsonb_build_object('state','pending'); end if;
    update public.creator_storage_deletions set state = 'auth_deleting', link_hashes = v_hashes, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleting');
  elsif p_operation = 'auth_deleted' then
    if exists (select 1 from auth.users where id = p_owner) then return null; end if;
    update public.creator_storage_dispatches set state='acknowledged',settled_at=now() where owner_id=p_owner and kind='auth' and state in ('pending','uncertain');
    update public.creator_storage_deletions set state = 'auth_deleted', updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleted');
  elsif p_operation = 'complete' then
    if v_job.state <> 'auth_deleted' or exists (select 1 from auth.users where id = p_owner) or exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null) then return null; end if;
    insert into public.link_tombstones (token_hash, reason)
      select value, 'creator_closed' from jsonb_array_elements_text(v_job.link_hashes) on conflict (token_hash) do nothing;
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_job.id, v_job.actor_id, v_job.action, 'profile', p_owner, jsonb_build_object('role', v_job.was_role, 'fanLinks', jsonb_array_length(v_job.link_hashes))) on conflict (id) do nothing;
    update public.creator_storage_deletions set state = 'complete', completed_at = now(), updated_at = now(), lease_id = null, lease_until = null, last_error = null where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes));
  elsif p_operation = 'pause' then
    if v_profile.id is null or exists(select 1 from public.creator_storage_dispatches where owner_id=p_owner and state in ('pending','uncertain')) then return null; end if;
    -- Change the service-owned state before our restoration write, in this
    -- same transaction under profile -> job locks. This is the sole safe way
    -- to reopen an account; ordinary profile writes cannot bypass quiescence.
    update public.creator_storage_deletions set state = 'paused', last_error = p_error, updated_at = now(), lease_id = null, lease_until = null where owner_id = p_owner;
    if v_job.restore_allowed then
      update public.profiles set role = v_job.was_role::public.app_role, is_active = v_job.was_active where id = p_owner;
    end if;
    return jsonb_build_object('state', 'paused');
  elsif p_operation = 'release' then
    update public.creator_storage_deletions set lease_id = null, lease_until = null, last_error = p_error, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', v_job.state);
  end if;
  raise exception 'invalid storage operation' using errcode = '22023';
end; $$;

-- 0062 actor-context bridge: the separate service JWT is never creator assurance.
-- Only an authenticated signed session may mint this unguessable, narrowly bound
-- context. No browser actor/assurance flag, metadata or custom GUC is authoritative.
create table if not exists public.creator_actor_contexts (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references public.profiles(id) on delete cascade,
 session_id uuid not null references auth.sessions(id) on delete cascade,
 creator_id uuid references public.profiles(id) on delete cascade,
 permission text not null check(permission in('grant','edit_wheel','reconcile','system_health')),
 aal text not null check(aal in('aal1','aal2')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 check(expires_at>created_at and expires_at<=created_at+interval '60 seconds'),
 check(permission='reconcile' or creator_id is not null)
);
create index if not exists creator_actor_contexts_actor_expiry on public.creator_actor_contexts(actor_id,expires_at);
create index if not exists creator_actor_contexts_expiry on public.creator_actor_contexts(expires_at);
alter table public.creator_actor_contexts enable row level security;
drop policy if exists creator_actor_contexts_own on public.creator_actor_contexts;
create policy creator_actor_contexts_own on public.creator_actor_contexts for select to authenticated using(actor_id=auth.uid());
-- Even own capabilities are not queryable/exportable through ordinary tables.
revoke all on public.creator_actor_contexts from public,anon,authenticated,service_role;

create or replace function public.issue_creator_actor_context(p_creator uuid,p_permission text)
returns uuid language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid uuid; deadline timestamptz; issued timestamptz; context_id uuid;
begin
 if actor is null or claims->>'sub' is distinct from actor::text or claims->>'role' is distinct from 'authenticated'
  or p_permission not in('grant','edit_wheel','reconcile','system_health') or p_permission is null
  or (p_permission<>'reconcile' and p_creator is null)
  or coalesce(claims->>'session_id','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or coalesce(claims->>'exp','') !~ '^[0-9]{1,12}$'
  or claims->>'aal' not in('aal1','aal2') or claims->>'aal' is null then
  raise exception 'authenticated session required' using errcode='42501';
 end if;
 if p_permission='system_health' and (p_creator is distinct from actor or claims->>'aal'<>'aal2' or not public.is_admin()) then raise exception 'admin step-up required' using errcode='42501'; end if;
 sid:=(claims->>'session_id')::uuid;
 -- Independent issuance namespace: no profile/fan/inventory/admin locks nest.
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-actor-context:'||actor::text,62));
 issued:=clock_timestamp();
 select least(issued+interval '60 seconds',to_timestamp((claims->>'exp')::double precision),coalesce(s.not_after,'infinity'::timestamptz))
  into deadline from auth.sessions s where s.id=sid and s.user_id=actor;
 if deadline is null or deadline<=issued or not exists(select 1 from public.profiles where id=actor) then
  raise exception 'authenticated session required' using errcode='42501';
 end if;
 delete from public.creator_actor_contexts where actor_id=actor and expires_at<=issued;
 if (select count(*) from public.creator_actor_contexts where actor_id=actor)>=32 then
  raise exception 'actor context limit' using errcode='54000';
 end if;
 insert into public.creator_actor_contexts(actor_id,session_id,creator_id,permission,aal,created_at,expires_at)
  values(actor,sid,p_creator,p_permission,claims->>'aal',issued,deadline) returning id into context_id;
 return context_id;
end $$;
revoke execute on function public.issue_creator_actor_context(uuid,text) from public,anon,service_role;
grant execute on function public.issue_creator_actor_context(uuid,text) to authenticated;

create or replace function public._creator_actor_context_valid(p_context uuid,p_actor uuid,p_creator uuid,p_permission text)
returns boolean language sql volatile security definer set search_path=public as $$
 select exists(select 1 from public.creator_actor_contexts c join auth.sessions s on s.id=c.session_id and s.user_id=c.actor_id
  where c.id=p_context and c.actor_id=p_actor and c.creator_id is not distinct from p_creator and c.permission=p_permission
   and c.expires_at>clock_timestamp() and (s.not_after is null or s.not_after>clock_timestamp()));
$$;
revoke execute on function public._creator_actor_context_valid(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function public._creator_actor_allowed(p_context uuid,p_actor uuid,p_creator uuid,p_scope text,p_permission text)
returns boolean language plpgsql security definer set search_path=public as $$
declare c public.creator_actor_contexts%rowtype; original_sub text:=current_setting('request.jwt.claim.sub',true);
 original_claim text:=current_setting('request.jwt.claim',true); original_claims text:=current_setting('request.jwt.claims',true); allowed boolean;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,p_scope) then return false; end if;
 select * into c from public.creator_actor_contexts where id=p_context;
 if c.aal<>'aal2' and exists(select 1 from auth.mfa_factors where user_id=p_actor and status='verified') then return false; end if;
 -- Shared profiles/agency permission matrix, with temporary claims derived
 -- ONLY from the validated DB context, never caller GUCs or request JSON.
 perform set_config('request.jwt.claim.sub',c.actor_id::text,true);
 perform set_config('request.jwt.claim','',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',c.actor_id,'role','authenticated','aal',c.aal,'session_id',c.session_id)::text,true);
 if p_scope='system_health' then allowed:=public.is_admin();else allowed:=public.can_act_for(p_creator,p_permission);end if;
 perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
 perform set_config('request.jwt.claim',coalesce(original_claim,''),true);
 perform set_config('request.jwt.claims',coalesce(original_claims,''),true);
 return coalesce(allowed,false);
exception when others then
 perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
 perform set_config('request.jwt.claim',coalesce(original_claim,''),true);
 perform set_config('request.jwt.claims',coalesce(original_claims,''),true);
 raise;
end $$;
revoke execute on function public._creator_actor_allowed(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;

create or replace function public._creator_actor_grant_allowed(p_actor uuid,p_creator uuid,p_context uuid,p_scope text default 'grant')
returns boolean language sql volatile security definer set search_path=public as $$
 select public._creator_actor_allowed(p_context,p_actor,p_creator,p_scope,'grant');
$$;
revoke execute on function public._creator_actor_grant_allowed(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create or replace function public._game_actor_edit_allowed(p_actor uuid,p_creator uuid,p_context uuid)
returns boolean language sql volatile security definer set search_path=public as $$
 select public._creator_actor_allowed(p_context,p_actor,p_creator,'edit_wheel','edit_wheel');
$$;
revoke execute on function public._game_actor_edit_allowed(uuid,uuid,uuid) from public,anon,authenticated,service_role;
-- Retired private impersonation helpers fail closed even if a future owner-only
-- legacy function accidentally calls them. Service JWT is never actor assurance.
create or replace function public._creator_actor_grant_allowed(p_actor uuid,p_creator uuid)
returns boolean language sql security definer set search_path=public as $$ select false; $$;
create or replace function public._game_actor_edit_allowed(p_actor uuid,p_creator uuid)
returns boolean language sql security definer set search_path=public as $$ select false; $$;

-- The previous reconcile_creator_request signature is owner-only; no service bypass remains.
revoke execute on function public.reconcile_creator_request(uuid,uuid,uuid,text,boolean,boolean) from public,anon,authenticated,service_role;
create or replace function public.reconcile_creator_request(p_context uuid,p_request uuid,p_creator uuid,p_actor uuid,p_kind text,p_cancel boolean default false,p_authorized boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.creator_request_journal%rowtype; allowed boolean:=false; receipt jsonb; identity jsonb; fenced_actor uuid;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'reconcile') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 identity:=jsonb_build_object('requestId',p_request,'kind',p_kind);
 if p_request is null or p_actor is null or p_kind not in('pass','grant','focus','import','edit')
   or not exists(select 1 from public.profiles where id=p_actor) then return identity||jsonb_build_object('status','unavailable'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 -- Actor+UUID discovers an already accepted operation before any absent-key
 -- cancellation, even if its original creator target was omitted or changed.
 select * into j from public.creator_request_journal where id=p_request and actor_id=p_actor for update;
 if not found and p_creator is not null then
   select * into j from public.creator_request_journal where id=p_request and creator_id=p_creator for update;
 end if;
 if j.id is null then
   if exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request) then
     return identity||jsonb_build_object('status',case when exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request and kind=p_kind) then 'cancelled' else 'conflict' end,'authorized',false);
   end if;
   if p_cancel then
     insert into public.actor_request_cancellations(actor_id,id,kind) values(p_actor,p_request,p_kind);
     return identity||jsonb_build_object('status','cancelled','authorized',false);
   end if;
   return identity||jsonb_build_object('status','absent','authorized',false);
 end if;
 if j.kind<>p_kind then return identity||jsonb_build_object('status','conflict','authorized',false); end if;
 allowed:=p_authorized and p_creator is not distinct from j.creator_id and public._creator_actor_grant_allowed(p_actor,j.creator_id,p_context,'reconcile');
 if not allowed and j.actor_id is distinct from p_actor and j.creator_id<>p_actor then return identity||jsonb_build_object('status','unavailable','authorized',false); end if;
 if j.state='committed' then
   receipt:=public._creator_request_receipt(p_request,j.creator_id);
   if receipt->>'status'='gone' then
     update public.creator_request_journal set state='gone',error='gone' where id=p_request and creator_id=j.creator_id;
     return identity||jsonb_build_object('status','gone','authorized',allowed);
   end if;
   if allowed then return identity||jsonb_build_object('status','committed','authorized',true,'receipt',receipt); end if;
   return identity||jsonb_build_object('status','committed','authorized',false);
 end if;
 if j.state='pending' and p_cancel then
   update public.creator_request_journal set state='cancelled',error='cancelled',finished_at=now() where id=p_request and creator_id=j.creator_id;
   fenced_actor:=coalesce(j.actor_id,p_actor);
   insert into public.actor_request_cancellations(actor_id,id,kind) values(fenced_actor,p_request,p_kind) on conflict(actor_id,id) do nothing;
   return identity||jsonb_build_object('status','cancelled','authorized',allowed);
 end if;
 return identity||jsonb_build_object('status',j.state,'authorized',allowed);
end $$;
revoke execute on function public.reconcile_creator_request(uuid,uuid,uuid,uuid,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_creator_request(uuid,uuid,uuid,uuid,text,boolean,boolean) to service_role;

-- The previous grant_pass_spins signature is owner-only; no service bypass remains.
revoke execute on function public.grant_pass_spins(uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.grant_pass_spins(p_context uuid,p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid default null,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 if not public._creator_actor_context_valid(p_context,actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_spins,p_bonus,p_amount,p_campaign)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 allowed:=public._creator_actor_grant_allowed(actor,p_creator,p_context);
 prior:=public._creator_request_open(p_request,p_creator,actor,'grant',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._grant_pass_spins_core(p_request,p_creator,p_fan,p_pass,p_spins,p_bonus,p_amount,p_campaign);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.grant_pass_spins(uuid,uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.grant_pass_spins(uuid,uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid) to service_role;

-- The previous grant_focus_pack signature is owner-only; no service bypass remains.
revoke execute on function public.grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.grant_focus_pack(p_context uuid,p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_pack uuid,p_prize uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 if not public._creator_actor_context_valid(p_context,actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_pack,p_prize)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 allowed:=public._creator_actor_grant_allowed(actor,p_creator,p_context);
 prior:=public._creator_request_open(p_request,p_creator,actor,'focus',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._grant_focus_pack_core(p_request,p_creator,p_fan,p_pass,p_pack,p_prize);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid) to service_role;

-- The previous create_pass_grant signature is owner-only; no service bypass remains.
revoke execute on function public.create_pass_grant(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid) from public,anon,authenticated,service_role;
create or replace function public.create_pass_grant(p_context uuid,p_request uuid,p_creator uuid,p_fan uuid,p_wheel uuid,p_name text,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid,p_referral_code text default null,p_pack uuid default null,p_pack_units integer default 1,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 if not public._creator_actor_context_valid(p_context,actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 h:=encode(digest(jsonb_build_array('create-pass-v1',p_creator,p_fan,p_wheel,p_name,case when p_pack is null then p_spins else null end,case when p_pack is null then p_bonus else null end,case when p_pack is null then p_amount else null end,p_campaign,p_referral_code,p_pack,p_pack_units)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 allowed:=public._creator_actor_grant_allowed(actor,p_creator,p_context);
 prior:=public._creator_request_open(p_request,p_creator,actor,'pass',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._create_pass_grant_core(p_request,p_creator,p_fan,p_wheel,p_name,p_spins,p_bonus,p_amount,p_campaign,p_referral_code,p_pack,p_pack_units);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.create_pass_grant(uuid,uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.create_pass_grant(uuid,uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid) to service_role;

-- The previous import_fans_durable signature is owner-only; no service bypass remains.
revoke execute on function public.import_fans_durable(uuid,uuid,text,jsonb,uuid) from public,anon,authenticated,service_role;
create or replace function public.import_fans_durable(p_context uuid,p_batch uuid,p_creator uuid,p_request_hash text,p_rows jsonb,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare actor uuid:=coalesce(p_actor,p_creator); allowed boolean; prior jsonb; outcome jsonb;
begin
 if not public._creator_actor_context_valid(p_context,actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 if p_request_hash is distinct from encode(digest(public._canonical_proof_json(jsonb_build_array('fan-import-v1',p_rows)),'sha256'),'hex') then raise exception 'invalid import binding' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_batch::text,59));
 allowed:=public._creator_actor_grant_allowed(actor,p_creator,p_context);
 prior:=public._creator_request_open(p_batch,p_creator,actor,'import',p_request_hash,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._import_fans_durable_core(p_batch,p_creator,p_request_hash,p_rows);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_batch,p_creator,outcome);
end $$;
revoke execute on function public.import_fans_durable(uuid,uuid,uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.import_fans_durable(uuid,uuid,uuid,text,jsonb,uuid) to service_role;

-- The previous edit_pass_grant signature is owner-only; no service bypass remains.
revoke execute on function public.edit_pass_grant(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role;
create or replace function public.edit_pass_grant(p_context uuid,p_request uuid,p_creator uuid,p_grant uuid,p_patch jsonb,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 -- There is no creator fallback for this new public edit contract. The server
 -- route must bind the actual getUser() actor to its captured request UUID.
 if p_actor is null or not exists(select 1 from public.profiles where id=p_actor) then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 h:=encode(digest(public._canonical_proof_json(jsonb_build_array('edit-grant-v1',p_creator,p_grant,p_patch)),'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 perform 1 from public.fans where id=(select fan_id from public.grants where id=p_grant and creator_id=p_creator) and creator_id=p_creator for update;
 allowed:=public._creator_actor_grant_allowed(p_actor,p_creator,p_context);
 prior:=public._creator_request_open(p_request,p_creator,p_actor,'edit',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._edit_grant_patch_core(p_creator,p_grant,p_patch);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.edit_pass_grant(uuid,uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.edit_pass_grant(uuid,uuid,uuid,uuid,jsonb,uuid) to service_role;

-- The previous cancel_fan_focus signature is owner-only; no service bypass remains.
revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.cancel_fan_focus(p_context uuid,p_creator uuid,p_fan uuid,p_focus uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'grant') then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 if p_focus is null then raise exception 'expected focus id required' using errcode='22023'; end if;
 if p_actor is null then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 if not found or not public._creator_actor_grant_allowed(p_actor,p_creator,p_context) then return jsonb_build_object('status','unavailable'); end if;
 return public.cancel_fan_focus(p_creator,p_fan,p_focus);
end $$;
revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_fan_focus(uuid,uuid,uuid,uuid,uuid) to service_role;

-- The previous save_game_wheel signature is owner-only; no service bypass remains.
revoke execute on function public.save_game_wheel(uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
create or replace function public.save_game_wheel(p_context uuid,p_wheel uuid,p_creator uuid,p_prizes jsonb,p_config jsonb,p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
declare w public.wheels%rowtype; error_code text;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'edit_wheel') then raise exception 'forbidden' using errcode='42501'; end if;
 select * into w from public.wheels where id=p_wheel and creator_id=p_creator for update;
 if not found then raise exception 'game_not_found' using errcode='P0002'; end if;
 if not public._game_actor_edit_allowed(p_actor,p_creator,p_context) then raise exception 'forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_config) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in('title','subtitle','brand_color','label_color','label_size','show_stock','game_kind','game_config'))
  or p_config->>'game_kind' is distinct from 'bingo' then raise exception 'invalid_game_config' using errcode='22023'; end if;
 perform set_config('fanfunnel.game_configuration',w.id::text,true);
 -- Keep existing readiness while editing; no intermediate state leaves this
 -- statement transaction, and active-card lifecycle guards remain in force.
 update public.wheels set game_kind='bingo',game_config=p_config->'game_config',
  title=case when p_config ? 'title' then p_config->>'title' else title end,subtitle=case when p_config ? 'subtitle' then p_config->>'subtitle' else subtitle end,
  brand_color=case when p_config ? 'brand_color' then p_config->>'brand_color' else brand_color end,
  label_color=case when p_config ? 'label_color' then p_config->>'label_color' else label_color end,label_size=case when p_config ? 'label_size' then p_config->>'label_size' else label_size end,
  show_stock=case when p_config ? 'show_stock' then (p_config->>'show_stock')::boolean else show_stock end where id=w.id;
 perform public.save_wheel_prizes(w.id,p_creator,p_prizes);
 error_code:=public._bingo_ready_error(w.id);if error_code is not null then raise exception '%',error_code using errcode='22023'; end if;
 update public.wheels set game_ready=true where id=w.id;
 perform set_config('fanfunnel.game_configuration','',true);
end $$;
revoke execute on function public.save_game_wheel(uuid,uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_game_wheel(uuid,uuid,uuid,jsonb,jsonb,uuid) to service_role;
