-- 0068: tenant boundaries, fan consent and deletion traces
-- (privacy / database-authorization audit at 7bea8ac, plus the outside-attacker
-- pass). Additive and idempotent. Redefines creator_storage_account,
-- creator_redemption_queue, org_account_stats, org_invite_creator,
-- org_add_member, org_invite_respond, org_scope_creator, set_public_profile,
-- set_creator_note and run_retention_cleanup from their latest definitions;
-- everything else is a new guard, column, trigger or function.
--
-- The audit reproduced these on Postgres with Supabase's REAL default grants
-- (every table and function in public is granted to anon, authenticated and
-- service_role unless the schema revokes it). The local drift harness now
-- emulates those defaults (scripts/db/supabase-stub.sql), and the probe for
-- this migration (scripts/db/dbSecurityProbe.mjs) fails before it and passes
-- after it on every build path.
--
--  1  A creator or 'grant' seat could clear a fan's self-exclusion
--     (update fan_passes set self_excluded_at = null, is_active = true under
--     fan_passes_write). The product rule is "ask your creator for a NEW link
--     to play again": a paused link never resumes. guard_fan_pass_link now
--     makes self_excluded_at writable only by the service-role fan path, and
--     once set it is immutable for every role (like a break, guard_fan_break);
--     a paused link can never be is_active again. The same guard makes the
--     token immutable after insert (S2: a creator could rewrite a fan's bearer
--     credential to a guessable value; there is no rotation path).
--  2  Cross-tenant forged references: redemptions_write, grants_write,
--     messages_write, wishlists_rw, referrals_rw and fans.referred_by_fan_id
--     never checked that the referenced spin/fan/pass/prize belongs to the
--     row's creator. insert redemptions(spin_id = <B's spin>, creator_id = A)
--     then made creator_redemption_queue() (SECURITY DEFINER) leak B's fan
--     name, prize and pool snapshot to A. Every such reference now has a
--     same-creator BEFORE trigger for every role, and the queue joins spins
--     on creator_id as well (defence in depth; the push payload embeds do the
--     same in src/lib/push/notify.ts).
--  3  Fan consent was forgeable by the creator (fans_write): leaderboard
--     opt-in, board name and the age-gate/terms acknowledgement. Those four
--     columns are now written only by the service-role fan paths
--     (/api/leaderboard/opt-in, /api/fans/ack); a creator session that
--     touches them is refused. Residual: the creator holds the link token,
--     so a creator could still open the fan page and act as the fan. Binding
--     consent to the fan's own device is not possible without fan accounts;
--     documented in docs/LEGAL_NOTES.md.
--  4  A suspended creator could close its own account and the cascade wiped
--     the safety reports about it (child-safety reports included).
--     creator_storage_account('begin', account.self_close) now refuses a
--     suspended account ('suspended') and one with open reports
--     ('reports_open'); an admin delete still works. creator_reports.creator_id
--     is ON DELETE SET NULL, every report carries a minimal non-PII snapshot
--     of the account (display name, public slug; the deletion time is stamped
--     when it goes) so the report survives the account. Owner policy
--     decision: reports are kept when the law requires (docs/DATA_RETENTION.md).
--  5  Every agency seat with 'view' could read every fan_passes.token (the
--     column grant included it). With the token a chatter can export or delete
--     the fan's data, reveal reward codes and spend spins. The column is
--     revoked from authenticated; links are served by creator_link_tokens(),
--     which requires can_act_for(creator, 'grant') (minting a link is already
--     'grant', so a seat that may read a link is exactly a seat that could
--     mint one; 'grant' and 'manage' are the same roles today), and a token
--     the dashboard was served is resolved to its pass by creator_link_pass()
--     for a 'view' caller (no token in the answer).
--  6  Creators and chatters could UPDATE/DELETE fan-sent messages and INSERT
--     sender = 'fan' messages. guard_message_writes: a browser role inserts
--     only sender = 'creator', may only set read_at (null -> value) on a fan's
--     message, never changes a message otherwise and never deletes a fan's.
--  7  Email enumeration and non-consensual seats: org_add_member seated an
--     existing account without consent and, with org_invite_creator, answered
--     ok / no_such_user / already_in_org. Both now send an invitation
--     (org_invites.role: null = creator, else a seat role) that the invitee
--     accepts through org_invite_respond, and answer 'ok' whether or not the
--     address has an account ('invalid_email', 'invalid_role', 'not_owner' and
--     'rate_limited' are the only other answers). An org may send 20
--     invitations per hour (database-level, so direct PostgREST calls are
--     throttled too). An owner may still seat itself directly.
--  8  profiles.email was never synced after an e-mail change, so invitations
--     matched the old address. A trigger on auth.users copies a confirmed
--     change, and existing rows are backfilled.
--  9  Deletion traces: deleting a fan (creator-side, the fan's own request or
--     the account wipe) now scrubs creator_reports.token and the fan's
--     spin_attempts (declined ones deleted, the rest lose token_hash and
--     context) in one BEFORE DELETE trigger on fans; the daily retention also
--     drops token_hash from finished attempts with their context; the wipe
--     removes the orphaned attempt shells (wipe_my_spin_attempts).
--  L2 set_public_profile / set_creator_note stored any tip/avatar URL when
--     called directly: tip links must be https (<= 2048 chars) and avatars
--     must be our storage origin; prizes.image_url must be https.
--  L4 org_scope_creator did not check the creator belongs to the owner's org.
--  Info org_account_stats returned every creator's e-mail and revenue to any
--     scoped seat; both are now null unless the caller owns the org, is an
--     admin or may 'manage' that creator.
--  Info Defence in depth: TRUNCATE is revoked from anon/authenticated on every
--     table, and anon has no table or sequence privilege at all (every fan
--     page runs on the service role; the browser only ever holds a signed-in
--     session). The RLS helper functions stay anon-callable.
--
-- Lock order unchanged (fan -> pass -> wheel -> prize); the new triggers take
-- no row locks beyond the row being written.
--
-- With 0067: trg_redemption_tenant and redemptions_stock_unit_guard (0067)
-- both refuse a redemption that names another creator's spin (the 0067 guard
-- fires first, by name); set_redemption_state() never writes spin_id or
-- creator_id, so this guard does not fire on its path, and the queue below
-- carries no 0067 change (0067 redefined no function). schema_version() is
-- redefined to 68 at the end, as 0067 requires of every later migration.

-- ── 1 / S2: a paused link stays paused; the token never changes ────────────
-- Not SECURITY DEFINER: current_user must be the calling role (PostgREST sets
-- it to anon/authenticated/service_role), as guard_fan_break does.
create or replace function public.guard_fan_pass_link()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.token is distinct from old.token then
    raise exception 'link token is immutable' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and new.self_excluded_at is not null)
     or (tg_op = 'UPDATE' and new.self_excluded_at is distinct from old.self_excluded_at) then
    if tg_op = 'UPDATE' and old.self_excluded_at is not null then
      raise exception 'a paused link stays paused' using errcode = '42501';
    end if;
    if current_user in ('anon', 'authenticated') then
      raise exception 'self-exclusion is set by the fan only' using errcode = '42501';
    end if;
  end if;
  if new.self_excluded_at is not null and new.is_active then
    raise exception 'a paused link stays paused' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_fan_pass_link_guard on public.fan_passes;
create trigger trg_fan_pass_link_guard
  before insert or update on public.fan_passes
  for each row execute function public.guard_fan_pass_link();
revoke execute on function public.guard_fan_pass_link() from public, anon, authenticated, service_role;

-- ── 2: every tenant reference belongs to the row's creator ─────────────────
-- SECURITY DEFINER like guard_atomic_pass_economy: the check must see the
-- referenced row whatever the caller's RLS view is, and refuse for every role.
create or replace function public.guard_redemption_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.spins s where s.id = new.spin_id and s.creator_id = new.creator_id) then
    raise exception 'redemption references another creator' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_redemption_tenant on public.redemptions;
create trigger trg_redemption_tenant
  before insert or update of spin_id, creator_id on public.redemptions
  for each row execute function public.guard_redemption_tenant();
revoke execute on function public.guard_redemption_tenant() from public, anon, authenticated, service_role;

create or replace function public.guard_grant_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.fans f where f.id = new.fan_id and f.creator_id = new.creator_id)
     or (new.fan_pass_id is not null and not exists (
           select 1 from public.fan_passes p where p.id = new.fan_pass_id and p.creator_id = new.creator_id and p.fan_id = new.fan_id))
     or (new.campaign_id is not null and not exists (
           select 1 from public.campaigns c where c.id = new.campaign_id and c.creator_id = new.creator_id)) then
    raise exception 'grant references another creator' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_grant_tenant on public.grants;
create trigger trg_grant_tenant
  before insert or update of fan_id, fan_pass_id, campaign_id, creator_id on public.grants
  for each row execute function public.guard_grant_tenant();
revoke execute on function public.guard_grant_tenant() from public, anon, authenticated, service_role;

create or replace function public.guard_wishlist_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.fans f where f.id = new.fan_id and f.creator_id = new.creator_id)
     or (new.prize_id is not null and not exists (
           select 1 from public.prizes pr join public.wheels w on w.id = pr.wheel_id
            where pr.id = new.prize_id and w.creator_id = new.creator_id)) then
    raise exception 'wishlist references another creator' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_wishlist_tenant on public.wishlists;
create trigger trg_wishlist_tenant
  before insert or update of fan_id, prize_id, creator_id on public.wishlists
  for each row execute function public.guard_wishlist_tenant();
revoke execute on function public.guard_wishlist_tenant() from public, anon, authenticated, service_role;

create or replace function public.guard_referral_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.referrer_fan_id = new.referred_fan_id
     or not exists (select 1 from public.fans f where f.id = new.referrer_fan_id and f.creator_id = new.creator_id)
     or not exists (select 1 from public.fans f where f.id = new.referred_fan_id and f.creator_id = new.creator_id) then
    raise exception 'referral references another creator' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_referral_tenant on public.referrals;
create trigger trg_referral_tenant
  before insert or update of referrer_fan_id, referred_fan_id, creator_id on public.referrals
  for each row execute function public.guard_referral_tenant();
revoke execute on function public.guard_referral_tenant() from public, anon, authenticated, service_role;

create or replace function public.guard_fan_referrer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.referred_by_fan_id is not null
     and (new.referred_by_fan_id = new.id
          or not exists (select 1 from public.fans f where f.id = new.referred_by_fan_id and f.creator_id = new.creator_id)) then
    raise exception 'referrer belongs to another creator' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_fan_referrer on public.fans;
create trigger trg_fan_referrer
  before insert or update of referred_by_fan_id, creator_id on public.fans
  for each row execute function public.guard_fan_referrer();
revoke execute on function public.guard_fan_referrer() from public, anon, authenticated, service_role;

-- ── 6 (+2): message writes ─────────────────────────────────────────────────
-- Not SECURITY DEFINER (current_user is the calling role). The tenant check
-- runs under the caller's own RLS view of fans, which is exactly the set of
-- fans a chatter may write to; the service role sees every row.
create or replace function public.guard_message_writes()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if current_user in ('anon', 'authenticated') and old.sender <> 'creator' then
      raise exception 'a fan message cannot be deleted by the creator' using errcode = '42501';
    end if;
    return old;
  end if;
  if not exists (select 1 from public.fans f where f.id = new.fan_id and f.creator_id = new.creator_id) then
    raise exception 'message references another creator' using errcode = '42501';
  end if;
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.sender <> 'creator' then
      raise exception 'a creator writes only creator messages' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (
         (to_jsonb(new) - 'read_at') <> (to_jsonb(old) - 'read_at')
         or (old.read_at is not null and new.read_at is distinct from old.read_at)) then
      raise exception 'messages are append-only (read receipts excepted)' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_message_writes on public.messages;
create trigger trg_message_writes
  before insert or update or delete on public.messages
  for each row execute function public.guard_message_writes();
revoke execute on function public.guard_message_writes() from public, anon, authenticated, service_role;

-- ── 3: fan consent is the fan's ────────────────────────────────────────────
create or replace function public.guard_fan_consent()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.leaderboard_opt_in or new.acked_at is not null or new.acked_terms_version is not null then
        raise exception 'fan consent is recorded by the fan only' using errcode = '42501';
      end if;
    elsif new.leaderboard_opt_in is distinct from old.leaderboard_opt_in
       or new.handle is distinct from old.handle
       or new.acked_at is distinct from old.acked_at
       or new.acked_terms_version is distinct from old.acked_terms_version then
      raise exception 'fan consent is recorded by the fan only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_fan_consent_guard on public.fans;
create trigger trg_fan_consent_guard
  before insert or update on public.fans
  for each row execute function public.guard_fan_consent();
revoke execute on function public.guard_fan_consent() from public, anon, authenticated, service_role;

-- ── 4: safety reports outlive the account; no self-close while suspended ───
alter table public.creator_reports alter column creator_id drop not null;
alter table public.creator_reports drop constraint if exists creator_reports_creator_id_fkey;
alter table public.creator_reports
  add constraint creator_reports_creator_id_fkey
  foreign key (creator_id) references public.profiles(id) on delete set null;
alter table public.creator_reports add column if not exists creator_snapshot jsonb;
comment on column public.creator_reports.creator_snapshot is 'The reported account as it was when the report was made: display name and public slug only (no e-mail); account_deleted_at is stamped when the account is deleted, so the report keeps its subject (0068).';

-- Taken when the report is made (the service-role insert), so it exists
-- whatever happens to the account later; older reports are backfilled below.
create or replace function public.creator_reports_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.creator_snapshot is null and new.creator_id is not null then
    select jsonb_build_object('display_name', p.display_name, 'public_slug', p.public_slug)
      into new.creator_snapshot from public.profiles p where p.id = new.creator_id;
  end if;
  return new;
end;
$$;
drop trigger if exists creator_reports_snapshot on public.creator_reports;
create trigger creator_reports_snapshot
  before insert on public.creator_reports
  for each row execute function public.creator_reports_snapshot();
revoke execute on function public.creator_reports_snapshot() from public, anon, authenticated, service_role;
update public.creator_reports r
   set creator_snapshot = (select jsonb_build_object('display_name', p.display_name, 'public_slug', p.public_slug) from public.profiles p where p.id = r.creator_id)
 where r.creator_snapshot is null and r.creator_id is not null;

-- 0064's review stamp, plus: the account deletion (ON DELETE SET NULL) is the
-- one write that may clear creator_id; it stamps the snapshot and drops the
-- link token, which the fan cascade of that same deletion makes useless.
create or replace function public.creator_reports_review_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.id := old.id;
  if new.creator_id is null and old.creator_id is not null then
    new.creator_snapshot := coalesce(old.creator_snapshot, '{}'::jsonb) || jsonb_build_object('account_deleted_at', now());
    new.token := null;
  else
    new.creator_id := old.creator_id;
  end if;
  new.reason := old.reason;
  new.detail := old.detail;
  new.created_at := old.created_at;
  if new.fan_id is not null then new.fan_id := old.fan_id; end if;
  if new.token is not null then new.token := old.token; end if;
  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.resolved_at := null;
      new.resolved_by := null;
      new.resolution_note := null;
    else
      new.resolved_at := now();
      new.resolved_by := auth.uid();
    end if;
  else
    new.resolved_at := old.resolved_at;
    -- Only clearable: deleting the reviewing admin's profile sets it null.
    if new.resolved_by is not null then new.resolved_by := old.resolved_by; end if;
    if new.status = 'open' then new.resolution_note := old.resolution_note; end if;
  end if;
  return new;
end; $$;

-- Same as 0063/0064's definition, plus the two self-close refusals in 'begin'.
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
    -- 0068: a suspended account, or one with an open safety report, cannot
    -- remove itself (and the evidence); an admin delete is unaffected.
    if p_action = 'account.self_close' then
      if not v_profile.is_active then return jsonb_build_object('error', 'suspended'); end if;
      if exists (select 1 from public.creator_reports r where r.creator_id = p_owner and r.status = 'open') then
        return jsonb_build_object('error', 'reports_open');
      end if;
    end if;
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

-- ── 5: link tokens are served, not selected ────────────────────────────────
revoke select (token) on public.fan_passes from authenticated;

-- Every link of one creator (or of one of its fans), for a caller that may
-- grant for that creator. A 'view' seat gets no rows.
create or replace function public.creator_link_tokens(p_creator uuid, p_fan uuid default null)
returns table (pass_id uuid, fan_id uuid, token text)
language sql stable security definer set search_path = public as $$
  select p.id, p.fan_id, p.token
    from public.fan_passes p
   where p.creator_id = p_creator
     and (p_fan is null or p.fan_id = p_fan)
     and (public.can_act_for(p_creator, 'grant') or public.is_admin())
   order by p.created_at desc, p.id desc
   limit 10000;
$$;
revoke execute on function public.creator_link_tokens(uuid, uuid) from public, anon;
grant execute on function public.creator_link_tokens(uuid, uuid) to authenticated, service_role;

-- The pass behind a token the dashboard was served. It answers a caller that
-- may at least view the creator (what fan_passes_select already lets it read
-- about every pass: id, fan, creator, campaign, state; never a token) and
-- nothing for anyone else, so a foreign token is "not found" rather than a
-- confirmation. Acting on the pass still needs can_act_for(creator, 'grant'),
-- rechecked by the caller and by the economic RPC itself.
create or replace function public.creator_link_pass(p_token text)
returns table (id uuid, creator_id uuid, fan_id uuid, campaign_id uuid, is_active boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.creator_id, p.fan_id, p.campaign_id, p.is_active
    from public.fan_passes p
   where p.token = p_token
     and (public.can_act_for(p.creator_id, 'view') or public.is_admin())
   limit 1;
$$;
revoke execute on function public.creator_link_pass(text) from public, anon;
grant execute on function public.creator_link_pass(text) to authenticated, service_role;

-- ── 2 (defence in depth): the fulfilment queue joins on creator_id ─────────
-- 0066's definition with `and s.creator_id = r.creator_id` on the spins join.
create or replace function public.creator_redemption_queue(
  p_status text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50,
  p_creator uuid default null
)
returns table (
  id uuid,
  status public.redemption_status,
  created_at timestamptz,
  notes text,
  due_at timestamptz,
  prize_label text,
  prize_rarity public.prize_rarity,
  fan_name text,
  pool_snapshot jsonb,
  fair_trace jsonb,
  reward_kind text,
  reward_views integer,
  reward_last_viewed_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with target as (
    select coalesce(p_creator, auth.uid()) as id
     where case when p_creator is null or p_creator = auth.uid()
                then public.can_act_for(auth.uid(), 'view')
                else public.can_act_for(p_creator, 'fulfil') end
  ), q as (
    select nullif(btrim(coalesce(p_query, '')), '') as raw
  ), pattern as (
    select case when raw is null then null
      else '%' || replace(replace(replace(left(raw, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' end as p
    from q
  )
  select r.id, r.status, r.created_at, r.notes, r.due_at,
         s.prize_label, s.prize_rarity,
         coalesce(f.display_name, f.handle, 'Fan') as fan_name,
         s.pool_snapshot, s.fair_trace,
         sr.kind, sr.views, sr.last_viewed_at
    from public.redemptions r
    join target t on r.creator_id = t.id
    join public.spins s on s.id = r.spin_id and s.creator_id = r.creator_id
    left join public.fans f on f.id = s.fan_id and f.creator_id = r.creator_id
    left join public.spin_rewards sr on sr.spin_id = s.id
    cross join pattern
   where (p_status is null or r.status::text = p_status)
     and (pattern.p is null
          or s.prize_label ilike pattern.p
          or f.display_name ilike pattern.p
          or f.handle ilike pattern.p)
     and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ── 7: seats and creators join by invitation; uniform answers; throttled ──
alter table public.org_invites add column if not exists role public.org_role;
comment on column public.org_invites.role is 'null: an invitation to join as a creator (profiles.org_id). Otherwise the seat role the invitee takes in org_members on acceptance (0068).';

-- 20 invitations per org per hour, counted in the database so a direct
-- PostgREST call is throttled like the route.
create or replace function public._org_invite_throttled(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (select count(*) from public.org_invites i
           where i.org_id = p_org and i.created_at > clock_timestamp() - interval '1 hour') >= 20;
$$;
revoke execute on function public._org_invite_throttled(uuid) from public, anon, authenticated, service_role;

-- The address an invitation is stored under, or null when it is not one.
create or replace function public._org_invite_email(p_email text)
returns text language sql immutable as $$
  select case when v ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(v) <= 254 then v end
    from (select lower(trim(coalesce(p_email, ''))) as v) e;
$$;
revoke execute on function public._org_invite_email(text) from public, anon, authenticated, service_role;

-- Both senders answer 'ok' whether or not the address has an account: an
-- unknown address gets a pending invitation that appears when (if) that
-- account exists and is active, and expires like any other.
create or replace function public.org_invite_creator(p_org uuid,p_email text)
returns text language plpgsql security definer set search_path=public as $$
declare v_email text; v_inv public.org_invites%rowtype; v_time timestamptz;
begin
 if not public._owns_org(p_org) then return 'not_owner'; end if;
 v_email := public._org_invite_email(p_email);
 if v_email is null then return 'invalid_email'; end if;
 -- The owner's own address already runs this agency.
 if exists(select 1 from public.orgs o join public.profiles p on p.id=o.owner_id
   where o.id=p_org and lower(p.email)=v_email) then return 'ok'; end if;
 if public._org_invite_throttled(p_org) then return 'rate_limited'; end if;
 -- Lock one recipient before any invite: accept and reinvite share this order.
 perform 1 from public.profiles where lower(email)=v_email and is_active
 and(approval_status='approved' or role='admin') order by id limit 1 for update;
 select * into v_inv from public.org_invites where org_id=p_org
 and lower(email)=v_email and status='pending' for update;
 -- Recheck the sender after every existing recipient/invitation lock wait.
 if not public._owns_org(p_org) then return 'not_owner'; end if;
 v_time:=clock_timestamp();
 if v_inv.id is not null then
   if v_inv.expires_at>v_time and v_inv.role is null then return 'ok'; end if;
   update public.org_invites set status=case when v_inv.expires_at>v_time then 'revoked' else 'expired' end
   where id=v_inv.id;
 end if;
 insert into public.org_invites(org_id,email,status,created_at,expires_at,role)
 values(p_org,v_email,'pending',v_time,v_time+interval '7 days',null);
 return 'ok';
end;
$$;

-- Same signature as before; it now sends a seat invitation instead of seating
-- the account. The owner may still seat itself directly (its own account,
-- any role).
create or replace function public.org_add_member(p_org uuid, p_email text, p_role org_role)
returns text language plpgsql security definer set search_path = public as $$
declare v_email text; v_inv public.org_invites%rowtype; v_time timestamptz; v_owner public.profiles%rowtype;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  if p_role is null then return 'invalid_role'; end if;
  v_email := public._org_invite_email(p_email);
  if v_email is null then return 'invalid_email'; end if;
  select p.* into v_owner from public.orgs o join public.profiles p on p.id = o.owner_id where o.id = p_org;
  if lower(coalesce(v_owner.email, '')) = v_email then
    insert into public.org_members (org_id, profile_id, role) values (p_org, v_owner.id, p_role)
      on conflict (org_id, profile_id) do update set role = excluded.role;
    return 'ok';
  end if;
  if p_role = 'owner' then return 'invalid_role'; end if;
  if public._org_invite_throttled(p_org) then return 'rate_limited'; end if;
  -- Lock one recipient before any invite: accept and reinvite share this order.
  perform 1 from public.profiles where lower(email) = v_email and is_active
     and (approval_status = 'approved' or role = 'admin') order by id limit 1 for update;
  select * into v_inv from public.org_invites where org_id = p_org
     and lower(email) = v_email and status = 'pending' for update;
  -- Recheck the sender after every existing recipient/invitation lock wait.
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  v_time := clock_timestamp();
  if v_inv.id is not null then
    if v_inv.expires_at > v_time and v_inv.role = p_role then return 'ok'; end if;
    update public.org_invites set status = case when v_inv.expires_at > v_time then 'revoked' else 'expired' end
     where id = v_inv.id;
  end if;
  insert into public.org_invites (org_id, email, status, created_at, expires_at, role)
    values (p_org, v_email, 'pending', v_time, v_time + interval '7 days', p_role);
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
   if v_inv.role is not null then
     -- A seat: the owner's own seat row is never rewritten through an invite.
     if exists(select 1 from public.orgs where id=v_inv.org_id and owner_id=auth.uid()) then return 'already_in_org'; end if;
     insert into public.org_members(org_id,profile_id,role) values(v_inv.org_id,auth.uid(),v_inv.role)
       on conflict(org_id,profile_id) do update set role=excluded.role;
   else
     if v_profile.org_id is not null then return 'already_in_org'; end if;
     update public.profiles set org_id=v_inv.org_id where id=auth.uid();
   end if;
   update public.org_invites set status='accepted' where id=p_invite;
 else
   update public.org_invites set status='declined' where id=p_invite;
 end if;
 return 'ok';
end;
$$;

-- ── L4: a seat is scoped only to a creator of the owner's org ──────────────
create or replace function public.org_scope_creator(p_member uuid, p_creator uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public._owns_org_seat(p_member) then
    return 'not_owner';
  end if;
  if not exists (select 1 from public.org_members m join public.profiles p on p.org_id = m.org_id
                  where m.id = p_member and p.id = p_creator) then
    return 'not_found';
  end if;
  if p_on then
    insert into public.org_member_creators (member_id, creator_id)
      values (p_member, p_creator) on conflict do nothing;
  else
    delete from public.org_member_creators where member_id = p_member and creator_id = p_creator;
  end if;
  return 'ok';
end;
$$;

-- ── Info: a scoped seat sees no e-mail or revenue ──────────────────────────
create or replace function public.org_account_stats(p_org uuid)
returns table (
  id uuid, email text, display_name text, role app_role, is_active boolean,
  features jsonb, wheels bigint, fans bigint, spins bigint, pending bigint,
  revenue bigint
)
language sql stable security definer set search_path = public as $$
  select p.id,
         case when public._owns_org(p_org) or public.is_admin() or public.can_act_for(p.id, 'manage') then p.email end,
         p.display_name, p.role, p.is_active, p.features,
         (select count(*) from public.wheels w where w.creator_id = p.id),
         (select count(*) from public.fans f where f.creator_id = p.id),
         (select count(*) from public.spins s where s.creator_id = p.id),
         (select count(*) from public.redemptions r where r.creator_id = p.id and r.status = 'pending'),
         case when public._owns_org(p_org) or public.is_admin() or public.can_act_for(p.id, 'manage')
              then (select coalesce(sum(g.amount_cents),0) from public.grants g where g.creator_id = p.id) end
    from public.profiles p
   where p.org_id = p_org
     and (
       public._owns_org(p_org)
       or public.is_admin()
       or (public._is_org_member(p_org) and public.can_act_for(p.id, 'view'))
     );
$$;

-- ── 8: profiles.email follows a confirmed e-mail change ────────────────────
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id and email is distinct from new.email;
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email();
revoke execute on function public.sync_profile_email() from public, anon, authenticated, service_role;
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is distinct from u.email;

-- ── 9: a deleted fan leaves no link trace ──────────────────────────────────
create or replace function public.scrub_fan_traces()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Rows whose creator is being deleted in this same statement are cascaded
  -- away right after this; touching them would re-check the creator FK.
  update public.creator_reports set token = null
   where token is not null
     and (fan_id = old.id or token in (select p.token from public.fan_passes p where p.fan_id = old.id))
     and (creator_id is null or exists (select 1 from public.profiles p where p.id = creator_reports.creator_id));
  delete from public.spin_attempts where fan_id = old.id and state = 'declined';
  update public.spin_attempts set token_hash = '', context = null
   where fan_id = old.id and exists (select 1 from public.profiles p where p.id = spin_attempts.creator_id);
  return old;
end;
$$;
drop trigger if exists trg_fan_scrub_traces on public.fans;
create trigger trg_fan_scrub_traces
  before delete on public.fans
  for each row execute function public.scrub_fan_traces();
revoke execute on function public.scrub_fan_traces() from public, anon, authenticated, service_role;

-- The account wipe (clearMyData) deletes every fan; the attempt shells that
-- survive (fan and pass gone, state settled) carry nothing a fan could replay.
create or replace function public.wipe_my_spin_attempts()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if auth.uid() is null or not public.current_user_active() then return 0; end if;
  delete from public.spin_attempts
   where creator_id = auth.uid() and state <> 'pending' and fan_id is null and fan_pass_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.wipe_my_spin_attempts() from public, anon;
grant execute on function public.wipe_my_spin_attempts() to authenticated;

-- 0065's definition, plus token_hash scrubbed with the context of a finished attempt.
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
  -- 0065 (A11): bounded operational history. Each constant matches
  -- RETENTION_DAYS in src/lib/privacy/retention.ts (retention.test.ts pins it).
  v_checkin_days constant integer := 90;
  v_attempt_days constant integer := 90;
  v_journal_days constant integer := 90;
  v_import_batch_days constant integer := 90;
  v_checkins integer := 0;
  v_attempt_contexts integer := 0;
  v_declined_attempts integer := 0;
  v_journal integer := 0;
  v_import_batches integer := 0;
  v_cancellations integer := 0;
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

  -- The visit glow reads back CHECKIN_READ_DAYS (59); older days are unused.
  delete from public.fan_checkins
   where day < current_date - v_checkin_days;
  get diagnostics v_checkins = row_count;

  -- A finished attempt keeps its short record (state, outcome, times, spin);
  -- the prepared context (seed, pool, reward hints) only serves a pending one,
  -- and the link's hash (0068) is only needed to answer that pending one.
  update public.spin_attempts set context = null, token_hash = ''
   where state <> 'pending' and (context is not null or token_hash <> '')
     and finished_at < now() - make_interval(days => v_attempt_days);
  get diagnostics v_attempt_contexts = row_count;
  -- A declined attempt moved no credit, stock or seed: nothing to keep.
  delete from public.spin_attempts
   where state = 'declined' and spin_id is null
     and finished_at < now() - make_interval(days => v_attempt_days);
  get diagnostics v_declined_attempts = row_count;

  -- Settled idempotency journals and import batches: a retry this old is not
  -- a retry. Grants and fans they created are business records and stay.
  delete from public.creator_request_journal
   where state <> 'pending'
     and finished_at < now() - make_interval(days => v_journal_days);
  get diagnostics v_journal = row_count;

  -- A cancelled request's fence (actor_request_cancellations) keeps a late
  -- retry of that request id from running; it lives as long as the journal
  -- (a creator's pending request only survives in that browser tab's session
  -- storage, so a retry this old is not a retry either).
  delete from public.actor_request_cancellations
   where created_at < now() - make_interval(days => v_journal_days);
  get diagnostics v_cancellations = row_count;

  -- An import batch is also the import's idempotency record: after this a
  -- re-sent import with the same request id is a new import.
  delete from public.fan_import_batches b
   where b.created_at < now() - make_interval(days => v_import_batch_days)
     and not exists(select 1 from public.creator_request_journal j where j.batch_id = b.id and j.state = 'pending');
  get diagnostics v_import_batches = row_count;

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
    'fan_checkins', v_checkins,
    'spin_attempt_contexts', v_attempt_contexts,
    'declined_spin_attempts', v_declined_attempts,
    'creator_request_journal', v_journal,
    'actor_request_cancellations', v_cancellations,
    'fan_import_batches', v_import_batches,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;

-- ── L2: stored URLs are validated in the database too ──────────────────────
create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(coalesce(p_tip_url, '')), '') is not null
     and (length(trim(p_tip_url)) > 2048 or trim(p_tip_url) !~ '^https://[^[:space:]]+$') then
    raise exception 'invalid tip url' using errcode = '22023';
  end if;
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
  if nullif(trim(coalesce(p_avatar, '')), '') is not null
     and (length(trim(p_avatar)) > 2048
          or trim(p_avatar) !~ '^https://[^/[:space:]]+/storage/v1/object/public/avatars/[^[:space:]]+$') then
    raise exception 'invalid avatar url' using errcode = '22023';
  end if;
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;

create or replace function public.guard_prize_image_url()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.image_url is not null
     and (length(new.image_url) > 2048 or new.image_url !~ '^https://[^[:space:]]+$') then
    raise exception 'invalid prize image url' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_prize_image_url on public.prizes;
create trigger trg_prize_image_url
  before insert or update of image_url on public.prizes
  for each row execute function public.guard_prize_image_url();
revoke execute on function public.guard_prize_image_url() from public, anon, authenticated, service_role;

-- ── Defence in depth: no TRUNCATE for browser roles; nothing at all for anon ─
revoke truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ── With 0067: set_redemption_state is the signed-in caller's write only ────
-- Supabase's default grants (now emulated by the stub) gave service_role
-- EXECUTE on it; the server calls it on the caller's session (fulfilment.ts),
-- never with the service client, so the grant is removed.
revoke execute on function public.set_redemption_state(uuid, uuid, jsonb) from service_role;

-- ── A39 (0067): the migration level this database was built to ────────────
create or replace function public.schema_version()
returns integer language sql immutable as $$ select 68 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0068). Every migration redefines it with its own number; the app flags a database behind its expected level.';
