-- 0054 Privacy & safety pack.
--
--   1. admin_audit_log   — who did what on the admin surface (ids only, no PII).
--   2. creator_notices   — in-app notices the server leaves for a creator
--                          ("a fan deleted their data"); no fan PII.
--   3. link_tombstones   — SHA-256 hashes of fan links that stopped working
--                          because the creator closed their account or the fan
--                          deleted their data, so the link can say why.
--   4. is_admin()        — admin power now also needs a two-factor (aal2)
--                          session, so a stolen admin password alone can't use
--                          the admin RLS paths through PostgREST either.
--   5. admin_reserve_account_deletion — its caller check reuses is_admin().
--   6. reserve_self_account_deletion  — the last-admin guard for a creator
--                          closing their own account (server-only).
--   7. spins.fan_pass_id — ON DELETE SET NULL (was CASCADE + NOT NULL): deleting
--                          a fan anonymizes their spins instead of erasing the
--                          creator's spin and redemption history.
--   8. run_retention_cleanup — the daily retention job (server-only); the
--                          periods are passed in from src/lib/privacy/retention.ts.
--
-- Access (AGENTS.md rules 2/5/6): every new table has RLS on and a policy;
-- nothing new is writable by anon or authenticated. The server writes through
-- the service role. The two new functions are revoked from public, anon and
-- authenticated and granted only to service_role.

-- 1. Admin activity log ------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  -- No foreign keys: an entry must outlive the actor's or target's account.
  actor_id    uuid,
  action      text not null check (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  target_type text check (target_type is null or target_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  target_id   uuid,
  details     jsonb not null default '{}'::jsonb
              check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096),
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
drop policy if exists admin_audit_log_admin_select on public.admin_audit_log;
create policy admin_audit_log_admin_select on public.admin_audit_log for select to authenticated
  using (public.is_admin());
revoke all on table public.admin_audit_log from public, anon, authenticated;
grant select on table public.admin_audit_log to authenticated;
grant select, insert, delete on table public.admin_audit_log to service_role;

-- Entries are append-only: nobody (not even the service role) rewrites one.
-- Only the retention job deletes, by age.
create or replace function public.admin_audit_log_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'admin_audit_log entries are append-only' using errcode = '42501';
end;
$$;
drop trigger if exists admin_audit_log_no_update on public.admin_audit_log;
create trigger admin_audit_log_no_update before update on public.admin_audit_log
  for each row execute function public.admin_audit_log_immutable();

-- 2. Creator notices ---------------------------------------------------------
create table if not exists public.creator_notices (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('fan_deleted_data')),
  details    jsonb not null default '{}'::jsonb
             check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 2048),
  created_at timestamptz not null default now()
);
create index if not exists creator_notices_creator_idx on public.creator_notices (creator_id, created_at desc);

alter table public.creator_notices enable row level security;
drop policy if exists creator_notices_select on public.creator_notices;
create policy creator_notices_select on public.creator_notices for select to authenticated
  using (public.can_act_for(creator_id, 'view'));
revoke all on table public.creator_notices from public, anon, authenticated;
grant select on table public.creator_notices to authenticated;
grant select, insert, delete on table public.creator_notices to service_role;

-- 3. Link tombstones ---------------------------------------------------------
create table if not exists public.link_tombstones (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  reason     text not null check (reason in ('creator_closed', 'fan_deleted')),
  created_at timestamptz not null default now()
);
create index if not exists link_tombstones_created_idx on public.link_tombstones (created_at);

alter table public.link_tombstones enable row level security;
drop policy if exists link_tombstones_admin_select on public.link_tombstones;
create policy link_tombstones_admin_select on public.link_tombstones for select to authenticated
  using (public.is_admin());
revoke all on table public.link_tombstones from public, anon, authenticated;
grant select, insert, delete on table public.link_tombstones to service_role;

-- 4. Admin power needs a two-factor session ---------------------------------
-- aal2 is set by Supabase Auth only after a verified MFA challenge. The app
-- enforces the same rule in src/lib/auth/adminCheck.ts; this makes the
-- database agree, so an aal1 admin JWT gets no admin rows through PostgREST.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- 5. The admin delete reservation trusts the same predicate -----------------
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an ACTIVE admin on a two-factor session (is_admin()).
  if not public.is_admin() then
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

-- 6. Closing your own account: the same last-admin guard ---------------------
-- Called by POST /api/account/close (service role) after the password step-up.
create or replace function public.reserve_self_account_deletion(p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  if p_user is null then
    return 'not_found';
  end if;
  select role into v_role from public.profiles where id = p_user for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    update public.profiles set role = 'creator' where id = p_user;
  end if;
  return 'ok';
end;
$$;
revoke execute on function public.reserve_self_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.reserve_self_account_deletion(uuid) to service_role;

-- 7. Deleting a fan anonymizes their spins -----------------------------------
alter table public.spins alter column fan_pass_id drop not null;
alter table public.spins drop constraint if exists spins_fan_pass_id_fkey;
alter table public.spins add constraint spins_fan_pass_id_fkey
  foreign key (fan_pass_id) references public.fan_passes(id) on delete set null;

-- 8. Daily retention ---------------------------------------------------------
-- Periods come from the caller (src/lib/privacy/retention.ts, documented in
-- docs/DATA_RETENTION.md). app_errors arrives with migration 0053; until that
-- table exists this step is skipped. Agency invites that were declined or
-- revoked hold an email address and nothing else of use, so they go too;
-- pending and accepted invites stay. Fans, spins and redemptions are business
-- records and are never touched here.
create or replace function public.run_retention_cleanup(
  p_audit_days integer,
  p_notice_days integer,
  p_tombstone_days integer,
  p_app_error_days integer,
  p_closed_invite_days integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
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

  if v_has_app_errors then
    execute 'delete from public.app_errors
              where resolved and resolved_at is not null
                and resolved_at < now() - make_interval(days => $1)'
      using p_app_error_days;
    get diagnostics v_app_errors = row_count;
  end if;

  return jsonb_build_object(
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
