-- 0071: ledger guards, seat consent, profile hygiene and lock order (security
-- audit 3 and the DB concurrency audit on orch/fixes 829a288). Additive and
-- idempotent; every redefinition keeps its grants (re-issued below each one).
--
--  Security (direct PostgREST writes that skipped an RPC's guard):
--   (a) H1  A game with play history or a link stored on it is never deleted:
--           DELETE on wheels is revoked from authenticated and a BEFORE DELETE
--           trigger refuses it for every role (game_has_history), except the
--           account-deletion cascade (the profile row is already gone) and
--           the owner's full reset, now the service-only
--           reset_creator_content (actor context, own account only).
--   (b) H1  grants is the money ledger: INSERT, UPDATE and DELETE are revoked
--           from authenticated (no session path writes it; the grant RPCs are
--           SECURITY DEFINER), and an invoker trigger refuses a session write
--           even if a grant comes back.
--   (c) H1 sweep  fan_passes DELETE (a link and its paid balance) is revoked
--           from authenticated (no session path deletes a link; a fan
--           deletion still cascades). Campaign deletion becomes the
--           delete_campaign RPC (F5), so DELETE on campaigns is revoked too.
--   (d) H1 sweep  A game chosen for play (scheduled, or set on a campaign or
--           a link) keeps at least 2 prizes: deleting or moving its prizes
--           below that is refused (game_needs_prizes); and a game inserted
--           with a schedule must have 2 prizes when its transaction commits
--           (0069 guarded only the UPDATE path).
--   (e) M1  The sign-up e-mail is never a display name: handle_new_user and a
--           profiles trigger drop a name that is, contains or looks like the
--           e-mail (null = the app's "Creator" fallback); existing rows are
--           backfilled; org_account_stats and my_seat_creators mask it.
--   (f) M2  Seating only by consent: INSERT/UPDATE on org_members and INSERT
--           on orgs are revoked from authenticated (org_create and the invite
--           RPCs are the writers); one agency per owner (unique index, so the
--           per-org invite throttle is a per-sender throttle); org_leave lets a
--           seat or a member creator leave on their own.
--   (g) L1  The own-row read policies (spins, request journal, cancellations,
--           storage work, applications) require the enrolled-MFA session.
--   (h) L2  set_public_profile / set_display_name validate shape and length,
--           and a profiles trigger re-checks a changed slug or tagline.
--   (i) L7  Invitation acceptance and the invitee read policy use the
--           confirmed sign-in address (auth.users.email_confirmed_at).
--   (j) I1  Future tables: no TRUNCATE for API roles, nothing for anon.
--   (k) I8  No actor context for an inactive or unapproved account.
--  Lock order (fan -> pass -> wheel -> prize kept everywhere):
--   (l) F1  commit/cancel_spin_attempt lock fan -> pass before the attempt.
--   (m) F2  self_exclude_pass: the fan's link pause locks fan -> pass.
--   (n) F3  _lock_wheel_focus_fans: the prize writers take the game's
--           Focus/Chase fans before the game.
--   (o) F4  A suspension/deletion pre-locks its fans; the account/storage
--           writers take the profile FOR NO KEY UPDATE.
--   (p) F5  delete_campaign locks the campaign's fans -> links -> campaign.
--   (q) F6  commit takes its creator's profile (key share) before the fan.
--   (r) schema_version() reports 71.

-- ── shared helpers ───────────────────────────────────────────────────────────
-- An e-mail-shaped string (the same shape _org_invite_email accepts).
create or replace function public._looks_like_email(p text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(btrim(p) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$', false)
$$;
revoke execute on function public._looks_like_email(text) from public, anon, authenticated, service_role;

-- A display name safe to show: trimmed, at most 80 characters, and never the
-- account's e-mail, a name containing it, or any e-mail-shaped string.
create or replace function public._safe_display_name(p_name text, p_email text)
returns text language sql immutable set search_path = public as $$
  select case
    when v is null or v = '' then null
    when public._looks_like_email(v) then null
    when nullif(btrim(coalesce(p_email, '')), '') is not null and strpos(lower(v), lower(btrim(p_email))) > 0 then null
    else v end
  from (select left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 80) as v) n
$$;
revoke execute on function public._safe_display_name(text, text) from public, anon, authenticated, service_role;

-- ── (a) H1: a game with history is archived, never deleted ──────────────────
create or replace function public._guard_game_history_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The account-deletion cascade (profiles -> wheels; the profile row is
  -- already gone) and the owner's full reset may remove a game with history.
  if exists (select 1 from public.profiles where id = old.creator_id)
     and current_setting('fanfunnel.creator_reset', true) is distinct from old.creator_id::text
     and (exists (select 1 from public.spins where wheel_id = old.id)
          or exists (select 1 from public.fan_passes where wheel_id = old.id)) then
    raise exception 'game_has_history' using errcode = '42501';
  end if;
  return old;
end $$;
revoke execute on function public._guard_game_history_delete() from public, anon, authenticated, service_role;
drop trigger if exists ad_game_history_delete on public.wheels;
create trigger ad_game_history_delete before delete on public.wheels
  for each row execute function public._guard_game_history_delete();
revoke delete on public.wheels from authenticated;

-- The owner's "reset all my data" (POST /api/account/reset, after the route's
-- MFA step-up, confirm phrase and rate limit): the creator's campaigns and
-- games, history included. Fans are deleted by the route's own statements
-- first. Service role only, with an edit_wheel actor context on the owner's
-- own session; a seat can never reset a creator.
create or replace function public.reset_creator_content(p_context uuid, p_creator uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if p_creator is null or p_actor is distinct from p_creator
     or not public._creator_actor_allowed(p_context, p_actor, p_creator, 'edit_wheel', 'edit_wheel') then
    return 'forbidden';
  end if;
  -- fan -> pass -> campaign/wheel -> prize, as every play takes them.
  perform 1 from public.fans where creator_id = p_creator order by id for update;
  perform 1 from public.fan_passes where creator_id = p_creator order by id for update;
  delete from public.campaigns where creator_id = p_creator;
  perform 1 from public.wheels where creator_id = p_creator order by id for update;
  perform set_config('fanfunnel.creator_reset', p_creator::text, true);
  delete from public.wheels where creator_id = p_creator;
  perform set_config('fanfunnel.creator_reset', '', true);
  return 'ok';
end $$;
revoke execute on function public.reset_creator_content(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reset_creator_content(uuid, uuid, uuid) to service_role;
comment on function public.reset_creator_content(uuid, uuid, uuid) is 'The owner''s full reset of campaigns and games, history included (0071). Service role only, edit_wheel actor context of the owner itself.';

-- ── (b) H1: the grant ledger is written by the grant RPCs only ──────────────
revoke insert, update, delete on public.grants from authenticated;
-- SECURITY INVOKER on purpose: inside the SECURITY DEFINER grant RPCs and the
-- foreign-key cascades current_user is the owner, a session is not.
create or replace function public._guard_grant_ledger()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'grants are written by the grant RPCs' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public._guard_grant_ledger() from public, anon, authenticated, service_role;
drop trigger if exists ab_grant_ledger on public.grants;
create trigger ab_grant_ledger before insert or update or delete on public.grants
  for each row execute function public._guard_grant_ledger();

-- ── (c) H1 sweep: links and campaigns ───────────────────────────────────────
revoke delete on public.fan_passes from authenticated;
revoke delete on public.campaigns from authenticated;

-- ── (d) H1 sweep: a chosen game keeps its prizes ────────────────────────────
-- Chosen = what 0069 refuses to choose with fewer than 2 prizes: a schedule,
-- a campaign's game, a link's game. Archived games are out of play.
create or replace function public._game_is_chosen(p_wheel uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.wheels w where w.id = p_wheel and w.archived_at is null
                   and (w.active_from is not null or w.active_until is not null
                        or exists (select 1 from public.campaigns c where c.pinned_wheel_id = w.id)
                        or exists (select 1 from public.fan_passes p where p.pinned_wheel_id = w.id)))
$$;
revoke execute on function public._game_is_chosen(uuid) from public, anon, authenticated, service_role;

-- AFTER ROW: runs at the end of the statement, so a save that inserts the new
-- prizes before deleting the old (save_wheel_prizes) is judged on the result.
-- A game being deleted (cascade) no longer exists and is not checked.
create or replace function public._guard_chosen_game_prizes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public._game_is_chosen(old.wheel_id) and not public._game_has_min_prizes(old.wheel_id) then
    raise exception 'game_needs_prizes' using errcode = '22023';
  end if;
  return null;
end $$;
revoke execute on function public._guard_chosen_game_prizes() from public, anon, authenticated, service_role;
drop trigger if exists zz_chosen_game_prizes on public.prizes;
create trigger zz_chosen_game_prizes after delete or update of wheel_id on public.prizes
  for each row execute function public._guard_chosen_game_prizes();

-- A game inserted with a schedule: judged when its transaction commits, so a
-- transaction that inserts the game and then its prizes passes.
create or replace function public._guard_new_game_schedule()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.wheels w where w.id = new.id and (w.active_from is not null or w.active_until is not null))
     and not public._game_has_min_prizes(new.id) then
    raise exception 'game_needs_prizes' using errcode = '22023';
  end if;
  return null;
end $$;
revoke execute on function public._guard_new_game_schedule() from public, anon, authenticated, service_role;
drop trigger if exists ae_new_game_schedule on public.wheels;
create constraint trigger ae_new_game_schedule after insert on public.wheels
  deferrable initially deferred for each row execute function public._guard_new_game_schedule();

-- ── (e) M1: the e-mail is never a display name ──────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, approval_status)
  values (
    new.id,
    new.email,
    -- 0071 (M1): the chosen name or nothing, never the e-mail (null shows as "Creator").
    public._safe_display_name(new.raw_user_meta_data->>'display_name', new.email),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- (h) is folded in: a changed slug or tagline is re-checked for every writer
-- (the RPCs answer first with the same rule). Only a changed value is
-- checked, so a legacy row never blocks an unrelated update.
create or replace function public._guard_profile_public_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.display_name is distinct from old.display_name or new.email is distinct from old.email then
    new.display_name := public._safe_display_name(new.display_name, new.email);
  end if;
  if new.public_slug is not null and (tg_op = 'INSERT' or new.public_slug is distinct from old.public_slug)
     and not public._valid_public_slug(new.public_slug) then
    raise exception 'invalid slug' using errcode = '22023';
  end if;
  if new.public_tagline is not null and (tg_op = 'INSERT' or new.public_tagline is distinct from old.public_tagline)
     and char_length(new.public_tagline) > 200 then
    raise exception 'invalid tagline' using errcode = '22023';
  end if;
  return new;
end $$;

-- The stored link-in-bio slug: what normalizePublicSlug produces (lowercase
-- ASCII letters and digits in dash-separated runs), at most 64 characters.
-- The byte check keeps any non-ASCII look-alike out whatever the collation.
create or replace function public._valid_public_slug(p text)
returns boolean language sql immutable set search_path = public as $$
  select p is not null and char_length(p) between 1 and 64 and octet_length(p) = char_length(p)
     and p ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
$$;
revoke execute on function public._valid_public_slug(text) from public, anon, authenticated, service_role;
revoke execute on function public._guard_profile_public_fields() from public, anon, authenticated, service_role;
drop trigger if exists ab_profile_public_fields on public.profiles;
create trigger ab_profile_public_fields before insert or update of display_name, email, public_slug, public_tagline on public.profiles
  for each row execute function public._guard_profile_public_fields();

-- Backfill: a name that is, contains or looks like the account's e-mail
-- (profiles.email or the auth address) goes back to the "Creator" fallback.
update public.profiles p set display_name = null
 where p.display_name is not null
   and (public._safe_display_name(p.display_name, p.email) is null
        or exists (select 1 from auth.users u where u.id = p.id
                     and public._safe_display_name(p.display_name, u.email) is null));

create or replace function public.org_account_stats(p_org uuid)
returns table (id uuid, email text, display_name text, role public.app_role, is_active boolean, features jsonb,
               wheels bigint, fans bigint, spins bigint, pending bigint, revenue bigint)
language sql stable security definer set search_path = public as $$
  select p.id,
         case when public._owns_org(p_org) or public.is_admin() or public.can_act_for(p.id, 'manage') then p.email end,
         -- 0071 (M1): a caller not entitled to the e-mail never gets one through the name.
         case when public._owns_org(p_org) or public.is_admin() or public.can_act_for(p.id, 'manage') then p.display_name
              else public._safe_display_name(p.display_name, p.email) end,
         p.role, p.is_active, p.features,
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
revoke execute on function public.org_account_stats(uuid) from public, anon;
grant execute on function public.org_account_stats(uuid) to authenticated, service_role;

create or replace function public.my_seat_creators()
returns table (creator_id uuid, display_name text, can_chat boolean, can_fulfil boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.display_name, c.can_chat, c.can_fulfil
    from (
      -- 0071 (M1): a chat/fulfil seat is not entitled to the creator's e-mail.
      select distinct p.id, coalesce(public._safe_display_name(p.display_name, p.email), 'Creator') as display_name,
             public.can_act_for(p.id, 'chat') as can_chat,
             public.can_act_for(p.id, 'fulfil') as can_fulfil
        from public.org_members m
        join public.profiles p on p.org_id = m.org_id
       where m.profile_id = auth.uid() and p.id <> auth.uid()
    ) c
   where c.can_chat or c.can_fulfil
   order by c.display_name, c.id
   limit 200;
$$;
revoke execute on function public.my_seat_creators() from public, anon;
grant execute on function public.my_seat_creators() to authenticated, service_role;

-- ── (f) M2: seats and agencies only through their RPCs ──────────────────────
revoke insert, update on public.org_members from authenticated;
revoke insert on public.orgs from authenticated;
do $$
begin
  if exists (select 1 from public.orgs group by owner_id having count(*) > 1) then
    raise exception '0071: an account owns more than one agency (orgs.owner_id); merge or remove the extra orgs, then re-apply'
      using errcode = '23505';
  end if;
end $$;
create unique index if not exists orgs_owner_id_key on public.orgs (owner_id);

create or replace function public.org_create(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.current_user_active() then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  -- 0071: one agency per owner (orgs_owner_id_key); a concurrent second call
  -- answers the same org instead of a unique violation.
  insert into public.orgs (name, owner_id)
    values (coalesce(nullif(trim(p_name), ''), 'My agency'), auth.uid())
    on conflict (owner_id) do nothing
    returning id into v_id;
  if v_id is null then select id into v_id from public.orgs where owner_id = auth.uid(); end if;
  return v_id;
end;
$$;
revoke execute on function public.org_create(text) from public, anon;
grant execute on function public.org_create(text) to authenticated, service_role;

-- A seat holder or a member creator leaves an agency on their own.
create or replace function public.org_leave(p_org uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_seats integer := 0; v_creator integer := 0;
begin
  if auth.uid() is null or p_org is null or not public._session_mfa_satisfied() then return 'not_member'; end if;
  delete from public.org_members where org_id = p_org and profile_id = auth.uid();
  get diagnostics v_seats = row_count;
  update public.profiles set org_id = null where id = auth.uid() and org_id = p_org;
  get diagnostics v_creator = row_count;
  return case when v_seats + v_creator > 0 then 'ok' else 'not_member' end;
end $$;
revoke execute on function public.org_leave(uuid) from public, anon;
grant execute on function public.org_leave(uuid) to authenticated, service_role;
comment on function public.org_leave(uuid) is 'The caller leaves an agency: its own seat and, as a member creator, the org (0071).';

-- ── (g) L1: own-row reads need the enrolled-MFA session ─────────────────────
drop policy if exists spins_select on public.spins;
create policy spins_select on public.spins for select
  using ((creator_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());
drop policy if exists creator_request_journal_select on public.creator_request_journal;
create policy creator_request_journal_select on public.creator_request_journal for select to authenticated
  using ((actor_id = auth.uid() and public._session_mfa_satisfied()) or public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists actor_request_cancellations_select on public.actor_request_cancellations;
create policy actor_request_cancellations_select on public.actor_request_cancellations for select to authenticated
  using ((actor_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());
drop policy if exists creator_storage_deletions_read on public.creator_storage_deletions;
create policy creator_storage_deletions_read on public.creator_storage_deletions for select to authenticated
  using ((owner_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());
drop policy if exists creator_storage_dispatches_read on public.creator_storage_dispatches;
create policy creator_storage_dispatches_read on public.creator_storage_dispatches for select to authenticated
  using ((owner_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());
drop policy if exists creator_storage_objects_read on public.creator_storage_objects;
create policy creator_storage_objects_read on public.creator_storage_objects for select to authenticated
  using ((owner_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());
drop policy if exists creator_apps_select on public.creator_applications;
create policy creator_apps_select on public.creator_applications for select
  using ((profile_id = auth.uid() and public._session_mfa_satisfied()) or public.is_admin());

-- ── (h) L2: profile fields validated in the RPCs ────────────────────────────
create or replace function public.set_public_profile(p_slug text, p_tip_url text, p_tagline text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(coalesce(p_tip_url, '')), '') is not null
     and (length(trim(p_tip_url)) > 2048 or trim(p_tip_url) !~ '^https://[^[:space:]]+$') then
    raise exception 'invalid tip url' using errcode = '22023';
  end if;
  -- 0071 (L2): the slug the route accepts after normalizePublicSlug (ASCII
  -- only, so no look-alike), and the route's tagline limit.
  if nullif(trim(coalesce(p_slug, '')), '') is not null and not public._valid_public_slug(trim(p_slug)) then
    raise exception 'invalid slug' using errcode = '22023';
  end if;
  if p_tagline is not null and char_length(trim(p_tagline)) > 200 then
    raise exception 'invalid tagline' using errcode = '22023';
  end if;
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;
revoke execute on function public.set_public_profile(text, text, text) from public, anon;
grant execute on function public.set_public_profile(text, text, text) to authenticated, service_role;

create or replace function public.set_display_name(p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_name, '')); v_email text;
begin
  if v = '' then return; end if;  -- blank keeps the current name, as before
  -- 0071 (L2, M1): the route's 80-character limit, no control characters, and
  -- never an e-mail address (the caller's own or any e-mail-shaped string).
  if char_length(v) > 80 or v ~ '[[:cntrl:]]' then
    raise exception 'invalid display name' using errcode = '22023';
  end if;
  select email into v_email from public.profiles where id = auth.uid();
  if public._safe_display_name(v, v_email) is distinct from v then
    raise exception 'display name looks like an e-mail address' using errcode = '22023';
  end if;
  update public.profiles set display_name = v where id = auth.uid() and public._session_mfa_satisfied();
end $$;
revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated, service_role;

-- ── (i) L7: the invitee's confirmed address ─────────────────────────────────
-- The caller's sign-in address, lower-cased, only once Supabase confirmed it.
create or replace function public._my_confirmed_email()
returns text language sql stable security definer set search_path = public as $$
  select lower(btrim(u.email)) from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null and nullif(btrim(u.email), '') is not null
$$;
revoke execute on function public._my_confirmed_email() from public, anon;
grant execute on function public._my_confirmed_email() to authenticated, service_role;
drop policy if exists org_invites_invitee_read on public.org_invites;
create policy org_invites_invitee_read on public.org_invites for select to authenticated
  using (public.current_user_active() and lower(email) = public._my_confirmed_email());

-- (org_invite_respond: 0068_tenant_boundaries_privacy.sql's definition, edited)
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
 -- 0071 (L7): the invitee's confirmed sign-in address (auth.users), never an unconfirmed one.
 if public._my_confirmed_email() is null or lower(v_inv.email) is distinct from public._my_confirmed_email() then return 'not_invitee'; end if;
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
revoke execute on function public.org_invite_respond(uuid, boolean) from public, anon;
grant execute on function public.org_invite_respond(uuid, boolean) to authenticated, service_role;

-- ── (j) I1: default privileges of future tables ─────────────────────────────
-- Tables and sequences the migration owner (postgres) creates from here on:
-- no TRUNCATE for the API roles and nothing at all for anon (0068 revoked the
-- same on every existing table). Each new table still grants what it needs.
alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- ── (k) I8: actor contexts for eligible accounts only ───────────────────────
-- (issue_creator_actor_context: 0062_account_security_lifecycle.sql's definition, edited)
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
 -- 0071 (I8): only an active, approved account (or an admin) gets a context.
 if deadline is null or deadline<=issued or not exists(select 1 from public.profiles where id=actor and is_active and (approval_status='approved' or role='admin')) then
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
revoke execute on function public.issue_creator_actor_context(uuid, text) from public, anon;
grant execute on function public.issue_creator_actor_context(uuid, text) to authenticated;

-- ── (l) F1 + (q) F6: a play locks profile -> fan -> pass -> attempt ──────────
-- (commit_spin_attempt: 0070_resolve_spin_game_once.sql's definition, edited)
create or replace function public.commit_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_context jsonb,p_spin jsonb,p_expected_reward jsonb,p_next_seed jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a public.spin_attempts%rowtype; p public.fan_passes%rowtype; f public.fans%rowtype; ff public.fan_focus%rowtype;
 r public.chase_reservations%rowtype; pr public.prizes%rowtype; target public.prizes%rowtype;
 code public.prize_reward_codes%rowtype; reward public.prize_rewards%rowtype; s public.spins%rowtype;
 current_context jsonb; snapshot jsonb; proof jsonb; mod_focus jsonb; mod_chase jsonb; row_proof jsonb;
 hh numeric; factor numeric; effective numeric; applied boolean:=false; eligible boolean:=false; target_available boolean:=false;
 pity_due boolean; focus_consumed boolean:=false; chase_due boolean:=false; chase_complete boolean:=false; has_rare boolean; v_stock_after integer;
 card public.bingo_cards%rowtype; before_state jsonb; after_state jsonb; bonus jsonb; trace_bonus jsonb; bonus_receipt jsonb; bonuses jsonb:='[]'::jsonb; line_number integer; bonus_index integer; card_id uuid; excluded_id text; excluded_all jsonb; selected_id text; expected_lines jsonb;
 next_pity integer; next_focus integer; next_chase integer; v_error text; balance integer; is_held boolean:=false; v_wheel uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 -- 0071 (F1): the attempt is read without a lock; the fan and the pass are
 -- locked first, in the order every fan writer uses (a fan deletion holds the
 -- fan while its triggers rewrite the fan's attempts), and the attempt row is
 -- locked and re-checked after them. The advisory lock above still serialises
 -- every call on one attempt.
 select * into a from public.spin_attempts where id=p_attempt;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
 if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 -- 0071 (F6): the creator's profile is taken (key share, the lock the spin
 -- insert's foreign key takes anyway) before any fan row, so a profile
 -- deletion cascade waits here instead of holding the profile while it waits
 -- for this fan.
 perform 1 from public.profiles where id=a.creator_id for key share;
 select * into f from public.fans where id=a.fan_id for update;
 select * into p from public.fan_passes where id=a.fan_pass_id and token=p_token for update;
 select * into a from public.spin_attempts where id=p_attempt for update;
 if not found or a.fan_id is distinct from f.id or a.fan_pass_id is distinct from p.id then return jsonb_build_object('status','unavailable'); end if;
 if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 if p.id is null or f.id is null or f.creator_id is distinct from p.creator_id or p.fan_id<>f.id or not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=a.creator_id and is_active and (approval_status='approved' or role='admin')) then
   return jsonb_build_object('status','unavailable');
 end if;
 -- The game is resolved exactly once per call, under the fan and pass locks
 -- (0070): every lock and the context below use v_wheel, so a campaign pin,
 -- flag, schedule or archive change mid-call can no longer split the wheel
 -- lock and the prize lock across two games (40P01); a change is caught by
 -- the context hash (retry_context) as before.
 v_wheel:=public._resolved_spin_wheel(p.id);
 if f.break_until>now() then v_error:='on_break';
 elsif f.acked_at is null or f.acked_terms_version is distinct from '2026-10-27' then v_error:='needs_ack';
 elsif p.spins_remaining<=0 then v_error:='no_spins';
 elsif f.rl_window_start>now()-interval '10 seconds' and f.rl_count>=8 then v_error:='rate_limited'; end if;
 if v_error is not null then
   update public.spin_attempts set state='declined',error=v_error,finished_at=now() where id=p_attempt;
   return jsonb_build_object('status','declined','error',v_error);
 end if;
 select * into ff from public.fan_focus where fan_id=f.id and status in('active','paused') for update;
 select * into r from public.chase_reservations where focus_id=ff.id for update;
 select * into card from public.bingo_cards where fan_id=f.id and wheel_id=v_wheel order by(status='active') desc,created_at desc,id desc limit 1 for update;
 -- Serialize game-kind/config edits against this credited play.
 perform 1 from public.wheels where id=v_wheel for update;
 -- Stable lock ordering for every candidate and reservation target.
 perform 1 from public.prizes where wheel_id=v_wheel or id=r.prize_id order by id for update;
 current_context:=public._spin_attempt_context(p.id,v_wheel);
 if p_context->>'contextHash' is distinct from current_context->>'contextHash'
   or a.context->>'contextHash' is distinct from current_context->>'contextHash' then
   return jsonb_build_object('status','retry_context');
 end if;
 select * into s from jsonb_populate_record(null::public.spins,p_spin);
 s.game_kind:=coalesce(s.game_kind,'wheel');
 if s.game_kind is distinct from current_context#>>'{wheel,game_kind}' or s.game_kind not in('wheel','scratch','bingo') or current_context#>'{wheel,game_ready}' is distinct from 'true'::jsonb then raise exception 'game context mismatch' using errcode='22023'; end if;
 if s.id is distinct from p_attempt or s.fan_id is distinct from f.id or s.fan_pass_id is distinct from p.id
   or s.creator_id is distinct from p.creator_id or s.wheel_id is distinct from (current_context->>'wheelId')::uuid
   or s.campaign_id is distinct from p.campaign_id or s.server_seed is distinct from p.next_server_seed
   or s.server_seed_hash is distinct from p.next_server_seed_hash or s.nonce is distinct from p.next_spin_nonce
   or s.fair_version is distinct from 3 or (p_next_seed->>'seed') !~ '^[a-f0-9]{64}$'
   or p_next_seed->>'hash' is distinct from encode(digest(p_next_seed->>'seed','sha256'),'hex')
   or p_next_seed->>'seed'=p.next_server_seed then
   raise exception 'spin context mismatch' using errcode='22023';
 end if;
 snapshot:=s.pool_snapshot;
 if snapshot->>'game' is distinct from s.game_kind or snapshot->>'v' is distinct from '3'
   or exists(select 1 from jsonb_object_keys(snapshot) k where k not in('v','rules','game','prizes','modifiers') and not(s.game_kind in('scratch','bingo') and k in('gameRules','gameConfig')) and not(s.game_kind='bingo' and k='bingo'))
   or exists(select 1 from jsonb_object_keys(snapshot->'modifiers') k where k not in('happyHour','pity','focus','chase'))
   or s.fair_trace->>'won' is distinct from s.prize_id::text then raise exception 'invalid proof envelope' using errcode='22023'; end if;
 if s.game_kind='scratch' then
   if snapshot->>'gameRules' is distinct from 'scratch-v1' or snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'
     or not public._valid_scratch_presentation(snapshot,s.prize_id,s.presentation)
     or s.fair_trace->'bonuses' is distinct from '[]'::jsonb
     or (select count(*) from jsonb_object_keys(s.fair_trace))<>3 then raise exception 'invalid scratch proof' using errcode='22023'; end if;
 elsif s.game_kind='bingo' then
   before_state:=case when card.id is null then null else public._bingo_public_state(to_jsonb(card)) end;
   if coalesce(p_context->'cardId','null'::jsonb) is distinct from coalesce(to_jsonb(card.id),'null'::jsonb)
    or coalesce(p_context->'cardVersion','null'::jsonb) is distinct from coalesce(to_jsonb(card.version),'null'::jsonb) then return jsonb_build_object('status','retry_context');end if;
   if snapshot->>'gameRules' is distinct from 'bingo-v1' or snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'
    or not public._validate_bingo_snapshot(snapshot,a.context,before_state) or not public._validate_bingo_presentation(snapshot,before_state,s.presentation,s.prize_id)
    or jsonb_typeof(s.fair_trace->'bonuses') is distinct from 'array' or(select count(*) from jsonb_object_keys(s.fair_trace))<>3
    or jsonb_typeof(p_spin->'bonuses') is distinct from 'array' then raise exception 'invalid bingo proof' using errcode='22023';end if;
   expected_lines:=s.presentation->'newLines';
   if jsonb_array_length(s.fair_trace->'bonuses')<>jsonb_array_length(expected_lines) or jsonb_array_length(p_spin->'bonuses')<>jsonb_array_length(expected_lines)
    or jsonb_array_length(expected_lines)>4 then raise exception 'missing or extra bingo bonuses' using errcode='22023';end if;
 elsif s.presentation is not null then raise exception 'unexpected wheel presentation' using errcode='22023'; end if;
 if s.game_kind<>'bingo' and coalesce(p_spin->'bonuses','[]'::jsonb)<>'[]'::jsonb then raise exception 'unexpected bonuses' using errcode='22023';end if;
 if snapshot->>'rules' is distinct from 'focus-v1' or snapshot#>>'{modifiers,pity,counter}' is distinct from f.pity_counter::text
   or snapshot#>>'{modifiers,pity,threshold}' is distinct from '10'
   or s.pool_hash is distinct from encode(digest(public._canonical_proof_json(snapshot),'sha256'),'hex') then
   raise exception 'invalid proof context' using errcode='22023';
 end if;
 hh:=(current_context->>'happyHourMultiplier')::numeric;
 if coalesce((snapshot#>>'{modifiers,happyHour,multiplier}')::numeric,1)<>hh then raise exception 'happy hour mismatch' using errcode='22023'; end if;
 mod_focus:=nullif(snapshot#>'{modifiers,focus}','null'::jsonb);
 mod_chase:=nullif(snapshot#>'{modifiers,chase}','null'::jsonb);
 select * into target from public.prizes where id=ff.prize_id;
 if ff.kind='focus' and target.wheel_id=s.wheel_id and
   ((select coalesce((x->>'stock')::int,1)>0 from jsonb_array_elements(a.context->'prizes') x where x->>'id'=ff.prize_id::text)
      is distinct from (target.stock is null or target.stock>0)) then return jsonb_build_object('status','retry_context'); end if;
 target_available:=target.id is not null and target.wheel_id=s.wheel_id and (target.stock is null or target.stock>0 or (r.state='held' and r.prize_id=target.id));
 if ff.id is null then
   if mod_focus is not null or mod_chase is not null then raise exception 'ungranted focus' using errcode='22023'; end if;
 elsif ff.kind='focus' then
   if mod_focus is null or mod_chase is not null or mod_focus->>'prizeId' is distinct from ff.prize_id::text
     or (mod_focus->>'multiplier')::numeric is distinct from ff.multiplier
     or (mod_focus->>'spinsLeft')::int is distinct from ff.spins_left
     or (mod_focus->>'totalSpins')::int is distinct from ff.total_spins then raise exception 'focus terms mismatch' using errcode='22023'; end if;
   applied:=coalesce((mod_focus->>'applied')::boolean,false);
   if applied is distinct from (target_available and public._focus_odds_increased(snapshot,'[]'::jsonb)) then raise exception 'focus odds eligibility mismatch' using errcode='22023'; end if;
   factor:=case when target.wheel_id=s.wheel_id and target.rarity in('rare','epic','legendary') then hh else 1 end;
   if applied and (not target_available or (mod_focus->>'effectiveMultiplier')::numeric is distinct from least(5,factor*ff.multiplier)) then
     raise exception 'ineligible focus' using errcode='22023';
   end if;
   if not applied and (mod_focus->>'effectiveMultiplier')::numeric is distinct from factor then raise exception 'paused focus weight' using errcode='22023'; end if;
 else
   if mod_chase is null or mod_focus is not null or mod_chase->>'prizeId' is distinct from ff.prize_id::text
     or (mod_chase->>'counter')::int is distinct from ff.chase_counter or (mod_chase->>'within')::int is distinct from ff.total_spins
     or coalesce((mod_chase->>'reserved')::boolean,false) is distinct from (r.state='held') then raise exception 'chase terms mismatch' using errcode='22023'; end if;
   eligible:=coalesce((mod_chase->>'eligible')::boolean,false);
   if eligible is distinct from target_available then raise exception 'chase eligibility mismatch' using errcode='22023'; end if;
   if eligible and coalesce(s.fair_trace->'excluded','[]'::jsonb) ? ff.prize_id::text then raise exception 'reserved chase target excluded' using errcode='22023'; end if;
   chase_due:=eligible and ff.chase_counter+1>=ff.total_spins;
   chase_complete:=eligible and s.prize_id=ff.prize_id;
   if chase_due and not chase_complete then raise exception 'chase guarantee violated' using errcode='22023'; end if;
 end if;
 -- Compare every published base/effective ticket count with current locked rows.
 -- Sold-out exclusions stay in the immutable trace; SQL does not reroll RNG.
 for row_proof in select value from jsonb_array_elements(snapshot->'prizes') loop
   if exists(select 1 from jsonb_object_keys(row_proof) k where k not in('id','label','emoji','rarity','w','baseW')) then raise exception 'invalid proof prize' using errcode='22023'; end if;
   select * into pr from public.prizes where id=(row_proof->>'id')::uuid and wheel_id=s.wheel_id;
   if not found or row_proof->>'label' is distinct from pr.label or row_proof->>'rarity' is distinct from pr.rarity::text
     or (s.game_kind in('scratch','bingo') and row_proof->'emoji' is distinct from coalesce(to_jsonb(pr.emoji),'null'::jsonb))
     or (row_proof->>'baseW')::numeric is distinct from pr.weight::numeric then raise exception 'pool base mismatch' using errcode='22023'; end if;
   factor:=case when pr.rarity in('rare','epic','legendary') then hh else 1 end;
   if applied and pr.id=ff.prize_id then factor:=least(5,factor*ff.multiplier); end if;
   effective:=case when pr.weight=0 then 0 else greatest(1,floor(pr.weight*factor+0.5)) end;
   if (row_proof->>'w')::numeric is distinct from effective then raise exception 'pool effective weight mismatch' using errcode='22023'; end if;
 end loop;
 select * into pr from public.prizes where id=s.prize_id and wheel_id=s.wheel_id;
 if not found then return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null); end if;
 if p_spin#>>'{response_prize,id}' is distinct from pr.id::text or p_spin#>>'{response_prize,label}' is distinct from pr.label
   or p_spin#>>'{response_prize,rarity}' is distinct from pr.rarity::text
   or exists(select 1 from jsonb_object_keys(p_spin->'response_prize') k where k not in('id','label','description','rarity','weight','color','emoji','imageUrl','stock'))
   or (p_spin->>'response_prize_index')::int not between 0 and 49
   or (p_spin->>'response_show_stock')::boolean is distinct from coalesce((current_context#>>'{wheel,show_stock}')::boolean,false) then
   raise exception 'response metadata mismatch' using errcode='22023'; end if;
 if pr.label is distinct from s.prize_label or pr.rarity is distinct from s.prize_rarity or pr.image_url is distinct from s.prize_image_url
   or not exists(select 1 from jsonb_array_elements(snapshot->'prizes') x where x->>'id'=pr.id::text) then raise exception 'selected prize mismatch' using errcode='22023'; end if;
 select exists(select 1 from jsonb_array_elements(snapshot->'prizes') x where x->>'rarity' in('rare','epic','legendary')
   and not (coalesce(s.fair_trace->'excluded','[]'::jsonb) ? (x->>'id'))) into has_rare;
 pity_due:=not chase_due and f.pity_counter+1>=10 and has_rare;
 if pity_due and pr.rarity not in('rare','epic','legendary') then raise exception 'pity guarantee violated' using errcode='22023'; end if;
 focus_consumed:=applied and public._focus_odds_increased(snapshot,coalesce(s.fair_trace->'excluded','[]'::jsonb));
 next_pity:=case when pr.rarity in('rare','epic','legendary') then 0 else f.pity_counter+1 end;
 next_focus:=case when ff.kind='focus' then ff.spins_left-case when focus_consumed then 1 else 0 end else null end;
 next_chase:=case when ff.kind='chase' then ff.chase_counter+case when eligible then 1 else 0 end else null end;
 if (p_spin->>'next_pity_counter')::int is distinct from next_pity
   or coalesce((p_spin->>'focus_consumed')::boolean,false) is distinct from focus_consumed
   or coalesce((p_spin->>'chase_consumed')::boolean,false) is distinct from eligible
   or coalesce((p_spin->>'chase_completed')::boolean,false) is distinct from chase_complete
   or (p_spin->>'next_focus_spins_left')::int is distinct from next_focus
   or (p_spin->>'next_chase_counter')::int is distinct from next_chase then raise exception 'counter transition mismatch' using errcode='22023'; end if;
 if pr.delivery is distinct from p_expected_reward->>'delivery' then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 is_held:=r.state='held' and r.prize_id=pr.id and eligible;
 if pr.delivery='codes' then
   select * into code from public.prize_reward_codes where id=(p_expected_reward->>'codeId')::uuid and prize_id=pr.id and spin_id is null for update;
   if code.id is null or (is_held and code.id is distinct from r.code_id) or (not is_held and code.reserved_focus_id is not null) then
     if is_held or exists(select 1 from public.prize_reward_codes where prize_id=pr.id and spin_id is null and reserved_focus_id is null) then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
     return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null);
   end if;
   if code.cipher is distinct from p_expected_reward->>'cipher' or code.iv is distinct from p_expected_reward->>'iv'
     or code.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 elsif pr.delivery in('link','text') then
   select * into reward from public.prize_rewards where prize_id=pr.id;
   if reward.kind is distinct from pr.delivery or reward.cipher is distinct from p_expected_reward->>'cipher'
     or reward.iv is distinct from p_expected_reward->>'iv' or reward.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 end if;
 if not is_held and pr.stock is not null and pr.stock<=0 then return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null); end if;
 -- No mutation above this point consumes a credit, seed, stock, pity or promise.
 perform set_config('fanfunnel.economic_write','on',true);
 perform set_config('fanfunnel.reward_finalization',p_attempt::text,true);
 if pr.delivery='codes' then
   update public.prize_reward_codes set spin_id=p_attempt,assigned_at=now(),reserved_focus_id=null where id=code.id;
   update public.prizes set stock=stock where id=pr.id;
 elsif not is_held and pr.stock is not null then update public.prizes set stock=stock-1 where id=pr.id; end if;
 update public.fan_passes set spins_remaining=spins_remaining-1,next_server_seed=p_next_seed->>'seed',next_server_seed_hash=p_next_seed->>'hash',next_spin_nonce=next_spin_nonce+1,last_spin_at=now() where id=p.id returning spins_remaining into balance;
 update public.fans set pity_counter=next_pity,last_spin_at=now(),
   rl_count=case when rl_window_start is null or rl_window_start<=now()-interval '10 seconds' then 1 else rl_count+1 end,
   rl_window_start=case when rl_window_start is null or rl_window_start<=now()-interval '10 seconds' then now() else rl_window_start end where id=f.id;
 s.seed_commitment:=case when a.context->>'commitment'='fresh' then 'fresh' when p_context->>'publishedSeedHash'=p.next_server_seed_hash then 'published' else 'stored' end;
 insert into public.spins(id,fan_pass_id,creator_id,wheel_id,fan_id,prize_id,prize_label,prize_rarity,prize_image_url,campaign_id,server_seed,server_seed_hash,nonce,client_seed,seed_commitment,fair_version,pool_snapshot,pool_hash,fair_trace,game_kind,presentation)
 values(p_attempt,p.id,p.creator_id,s.wheel_id,f.id,pr.id,s.prize_label,s.prize_rarity,s.prize_image_url,p.campaign_id,s.server_seed,s.server_seed_hash,s.nonce,s.client_seed,s.seed_commitment,3,s.pool_snapshot,s.pool_hash,s.fair_trace,s.game_kind,s.presentation) returning * into s;
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at,cost_cents_at_award) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end,case when pr.cost_cents>=0 then pr.cost_cents end);
 if is_held then update public.chase_reservations set state='consumed',consumed_spin_id=s.id,ended_at=now() where id=r.id and state='held'; end if;
 if ff.id is not null then
   update public.fan_focus set spins_left=coalesce(next_focus,spins_left),chase_counter=coalesce(next_chase,chase_counter),version=version+1,
     status=case when chase_complete or next_focus=0 then 'done' else 'active' end,
     ended_at=case when chase_complete or next_focus=0 then now() else null end where id=ff.id;
 end if;
 if s.game_kind='bingo' then
  perform set_config('fanfunnel.bingo_write','on',true);
  after_state:=s.presentation->'after';
  if(s.presentation->>'newCard')::boolean then
   insert into public.bingo_cards(creator_id,fan_id,wheel_id,cells,marked_mask,awarded_lines_mask,version,status,completed_at)
   values(s.creator_id,s.fan_id,s.wheel_id,after_state->'cells',(after_state->>'markedMask')::integer,(after_state->>'awardedLinesMask')::integer,(after_state->>'version')::bigint,
    case when(after_state->>'markedMask')::integer=511 then 'complete' else 'active' end,case when(after_state->>'markedMask')::integer=511 then now() else null end) returning id into card_id;
  else
   update public.bingo_cards set marked_mask=(after_state->>'markedMask')::integer,awarded_lines_mask=(after_state->>'awardedLinesMask')::integer,version=(after_state->>'version')::bigint,
    status=case when(after_state->>'markedMask')::integer=511 then 'complete' else 'active' end,completed_at=case when(after_state->>'markedMask')::integer=511 then now() else null end where id=card.id and version=card.version returning id into card_id;
   if not found then raise exception using errcode='P0061',message='{"status":"retry_context"}';end if;
  end if;
  excluded_all:=coalesce(s.fair_trace->'excluded','[]'::jsonb);
  for bonus_index in 0..jsonb_array_length(expected_lines)-1 loop
   line_number:=(expected_lines->>bonus_index)::integer;bonus:=p_spin->'bonuses'->bonus_index;trace_bonus:=s.fair_trace->'bonuses'->bonus_index;
   if(trace_bonus->>'line')::integer is distinct from line_number or trace_bonus->>'won' is distinct from bonus->>'prize_id'
    or jsonb_typeof(trace_bonus->'excluded') is distinct from 'array' or(select count(*) from jsonb_object_keys(trace_bonus))<>3 then raise exception 'invalid bingo bonus trace' using errcode='22023';end if;
   for excluded_id in select jsonb_array_elements_text(trace_bonus->'excluded') loop
    if excluded_all ? excluded_id or not exists(select 1 from jsonb_array_elements((snapshot#>'{bingo,bonus,fallback}')||case when snapshot#>'{bingo,bonus,selected}'='null'::jsonb then '[]'::jsonb else jsonb_build_array(snapshot#>'{bingo,bonus,selected}') end) q where q->>'id'=excluded_id) then raise exception 'invalid bingo exclusion' using errcode='22023';end if;
    if exists(select 1 from public.prizes p2 where p2.id=excluded_id::uuid and p2.wheel_id=s.wheel_id and((p2.delivery<>'codes' and(p2.stock is null or p2.stock>0)) or(p2.delivery='codes' and exists(select 1 from public.prize_reward_codes where prize_id=p2.id and spin_id is null and reserved_focus_id is null)))) then raise exception 'available bingo candidate excluded' using errcode='22023';end if;
    excluded_all:=excluded_all||to_jsonb(excluded_id);
   end loop;
   selected_id:=snapshot#>>'{bingo,bonus,selected,id}';
   if excluded_all ? (bonus->>'prize_id') or(selected_id is not null and not(excluded_all ? selected_id) and bonus->>'prize_id'<>selected_id)
    or((selected_id is null or excluded_all ? selected_id) and not exists(select 1 from jsonb_array_elements(snapshot#>'{bingo,bonus,fallback}') q where q->>'id'=bonus->>'prize_id')) then raise exception 'invalid bingo bonus selection' using errcode='22023';end if;
   bonus_receipt:=public._commit_bingo_bonus(s.id,bonus,line_number);
   insert into public.bingo_line_awards(card_id,line_index,creator_id,fan_id,wheel_id,primary_spin_id,bonus_spin_id)
   values(card_id,line_number,s.creator_id,s.fan_id,s.wheel_id,s.id,(bonus_receipt#>>'{spin,id}')::uuid);
   bonuses:=bonuses||jsonb_build_array(bonus_receipt);
  end loop;
 end if;
 select stock into v_stock_after from public.prizes where id=pr.id;
 update public.spin_rewards set stock_after=v_stock_after where spin_id=s.id;
 update public.spin_attempts set state='committed',spin_id=s.id,finished_at=now(),result=jsonb_build_object(
   'id',s.id,'shareId',s.share_id,'spin',to_jsonb(s),'createdAt',s.created_at,'stockAfter',v_stock_after,
   'gameKind',s.game_kind,'presentation',s.presentation,'bonusWins',bonuses,
   'originalNextServerSeedHash',p_next_seed->>'hash','pityAwarded',pity_due,'chaseAwarded',chase_due,'chaseCompleted',chase_complete,
   'focusConsumed',focus_consumed,'chaseConsumed',eligible,
   'prize',p_spin->'response_prize','prizeIndex',(p_spin->>'response_prize_index')::int,'showStock',(p_spin->>'response_show_stock')::boolean) where id=p_attempt;
 return public._spin_attempt_receipt(p_attempt,false);
exception when sqlstate 'P0061' then return sqlerrm::jsonb;
end $$;
revoke execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;

-- (cancel_spin_attempt: 0059_focus_attempt_ledger.sql's definition, edited)
create or replace function public.cancel_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_error text default 'no_prizes')
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a public.spin_attempts%rowtype; p public.fan_passes%rowtype;
begin
 if p_attempt is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
   or p_error not in('no_prizes','reward_unavailable','cancelled') then raise exception 'invalid terminal attempt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 -- 0071 (F1): read without a lock; the attempt row is locked after the fan and the pass.
 select * into a from public.spin_attempts where id=p_attempt;
 if a.id is not null then
   if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 end if;
 select * into p from public.fan_passes where token=p_token;
 if p.id is null then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=p.fan_id for update;
 select * into p from public.fan_passes where id=p.id and token=p_token for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 select * into a from public.spin_attempts where id=p_attempt for update;
 if a.id is not null then
   if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
   if a.fan_pass_id is distinct from p.id then return jsonb_build_object('status','unavailable'); end if;
 end if;
 if not p.is_active or p.self_excluded_at is not null or not exists(select 1 from public.fans where id=p.fan_id and blocked_at is null)
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 insert into public.spin_attempts(id,creator_id,fan_id,fan_pass_id,token_hash,request_hash,state,error,finished_at)
 values(p_attempt,p.creator_id,p.fan_id,p.id,encode(digest(p_token,'sha256'),'hex'),p_request_hash,'declined',p_error,now())
 on conflict(id) do update set state='declined',error=p_error,finished_at=now() where public.spin_attempts.state='pending';
 return jsonb_build_object('status','declined','error',p_error);
end $$;
revoke execute on function public.cancel_spin_attempt(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.cancel_spin_attempt(uuid,text,text,text) to service_role;

-- ── (m) F2: a fan pauses its link fan -> pass ───────────────────────────────
-- POST /api/self-exclude (selfExclude). The UPDATE's triggers lock the fan
-- (spin aggregate, Focus release); taking it first keeps the play order.
-- Idempotent: an already paused link answers ok and keeps its first pause.
create or replace function public.self_exclude_pass(p_token text)
returns text language plpgsql security definer set search_path = public as $$
declare p public.fan_passes%rowtype;
begin
  if p_token is null or p_token = '' then return 'not_found'; end if;
  select * into p from public.fan_passes where token = p_token;
  if p.id is null then return 'not_found'; end if;
  perform 1 from public.fans where id = p.fan_id for update;
  select * into p from public.fan_passes where id = p.id and token = p_token for update;
  if p.id is null then return 'not_found'; end if;
  if p.self_excluded_at is not null then return 'ok'; end if;
  update public.fan_passes set self_excluded_at = now(), is_active = false where id = p.id;
  return 'ok';
end $$;
revoke execute on function public.self_exclude_pass(text) from public, anon, authenticated;
grant execute on function public.self_exclude_pass(text) to service_role;
comment on function public.self_exclude_pass(text) is 'A fan pauses its own link (self-exclusion), locking fan then pass (0071). Service role only.';

-- ── (n) F3: the prize writers lock fans before the game ─────────────────────
-- The game's live Focus/Chase fans (a prize change releases their promises,
-- which locks the fan and its links) and those links, in id order, then the
-- game. Built like _lock_wheel_lifecycle (0065): a promise granted while the
-- game lock was awaited is caught by the nowait re-check and the whole set is
-- taken again. False when the game is not the creator's.
create or replace function public._lock_wheel_focus_fans(p_wheel uuid, p_creator uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_try integer; v_found boolean;
begin
 for v_try in 1..20 loop
   begin
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where status in('active','paused')
       and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update;
     perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where status in('active','paused')
       and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update;
     perform 1 from public.wheels where id=p_wheel and creator_id=p_creator for update;
     v_found:=found;
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where status in('active','paused')
       and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update nowait;
     perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where status in('active','paused')
       and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update nowait;
     return v_found;
   exception when lock_not_available then null;
   end;
 end loop;
 perform 1 from public.fans where id in(select fan_id from public.fan_focus where status in('active','paused')
   and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update;
 perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where status in('active','paused')
   and (wheel_id=p_wheel or prize_id in(select id from public.prizes where wheel_id=p_wheel))) order by id for update;
 perform 1 from public.wheels where id=p_wheel and creator_id=p_creator for update;
 return found;
end $$;
revoke execute on function public._lock_wheel_focus_fans(uuid, uuid) from public, anon, authenticated, service_role;

-- (save_wheel_prizes: 0061_personal_bingo.sql's definition, edited)
create or replace function public.save_wheel_prizes(p_wheel uuid, p_creator uuid, p_prizes jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_order integer := 0;
  v_stock integer;
  v_current integer;
  v_expected integer;
begin
  -- 0071 (F3): the game's Focus/Chase fans and their links before the game.
  if not public._lock_wheel_focus_fans(p_wheel, p_creator) then raise exception 'wheel not found' using errcode = 'P0002'; end if;
  if exists(select 1 from public.wheels where id=p_wheel and game_kind='bingo') and current_setting('fanfunnel.game_configuration',true) is distinct from p_wheel::text then raise exception 'use actor-bound game saver' using errcode='42501';end if;
  if p_prizes is null or jsonb_typeof(p_prizes) <> 'array' or jsonb_array_length(p_prizes) not between 2 and 50 then
    raise exception 'invalid prize count' using errcode = '22023';
  end if;
  perform 1 from public.prizes where wheel_id = p_wheel order by id for update;
  for v_row in select * from jsonb_array_elements(p_prizes) loop
    v_id := null;
    v_stock := (v_row->>'stock')::integer;
    if (v_row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id, stock into v_id, v_current from public.prizes where id = (v_row->>'id')::uuid and wheel_id = p_wheel;
    end if;
    -- Stock is a compare-and-set against the value the editor loaded
    -- (expected_stock), so a save never "un-decrements" spins that landed
    -- while the creator was editing. A finite edit over moved stock is applied
    -- as the creator's delta; a limited/unlimited switch that no longer matches
    -- what they saw is a stock_changed conflict (reload and retry).
    if v_id is not null and (v_row ? 'expected_stock') then
      v_expected := (v_row->>'expected_stock')::integer;
      if v_current is distinct from v_expected and v_stock is not null then
        if v_current is null or v_expected is null then raise exception 'stock_changed' using errcode = '22023'; end if;
        v_stock := greatest(0, v_current + (v_stock - v_expected));
      end if;
    end if;
    if v_id is null and current_setting('fanfunnel.game_configuration',true)=p_wheel::text and(v_row->>'id') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
      if exists(select 1 from public.prizes where id=(v_row->>'id')::uuid) then raise exception 'invalid_game_config' using errcode='22023';end if;
      v_id:=(v_row->>'id')::uuid;
    end if;
    if v_id is null then v_id := gen_random_uuid(); end if;
    if v_id = any(v_ids) then raise exception 'duplicate prize id' using errcode = '22023'; end if;
    insert into public.prizes (id,wheel_id,label,description,rarity,weight,color,emoji,image_url,cost_cents,stock,sort_order,boostable)
    values(v_id,p_wheel,v_row->>'label',v_row->>'description',(v_row->>'rarity')::public.prize_rarity,
      (v_row->>'weight')::integer,v_row->>'color',v_row->>'emoji',v_row->>'image_url',
      (v_row->>'cost_cents')::integer,v_stock,v_order,coalesce((v_row->>'boostable')::boolean,false))
    on conflict(id) do update set label=excluded.label,description=excluded.description,rarity=excluded.rarity,
      weight=excluded.weight,color=excluded.color,emoji=excluded.emoji,image_url=excluded.image_url,
      cost_cents=excluded.cost_cents,stock=excluded.stock,sort_order=excluded.sort_order,boostable=excluded.boostable;
    v_ids := array_append(v_ids,v_id);
    v_order := v_order + 1;
  end loop;
  delete from public.prizes where wheel_id=p_wheel and not(id=any(v_ids));
end;
$$;
revoke execute on function public.save_wheel_prizes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_wheel_prizes(uuid, uuid, jsonb) to service_role;

-- (set_prize_delivery: 0061_personal_bingo.sql's definition, edited)
create or replace function public.set_prize_delivery(
  p_prize uuid,
  p_creator uuid,
  p_kind text,
  p_cipher text default null,
  p_iv text default null,
  p_key_version smallint default 1
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wheel uuid;
begin
  if p_kind is null or p_kind not in ('manual', 'link', 'text') then
    raise exception 'invalid delivery' using errcode = '22023';
  end if;
  select wheel_id into v_wheel from public.prizes where id = p_prize;
  -- 0071 (F3): the game's Focus/Chase fans and their links before the game.
  if v_wheel is null or not public._lock_wheel_focus_fans(v_wheel, p_creator) then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  perform 1 from public.prizes where id = p_prize and wheel_id = v_wheel for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_kind = 'manual' then
    delete from public.prize_rewards where prize_id = p_prize;
  else
    if p_cipher is null or p_iv is null then
      raise exception 'reward value required' using errcode = '22023';
    end if;
    insert into public.prize_rewards (prize_id, creator_id, kind, cipher, iv, key_version, updated_at)
    values (p_prize, p_creator, p_kind, p_cipher, p_iv, coalesce(p_key_version, 1), now())
    on conflict (prize_id) do update
      set creator_id = excluded.creator_id, kind = excluded.kind, cipher = excluded.cipher,
          iv = excluded.iv, key_version = excluded.key_version, updated_at = now();
  end if;
  update public.prizes set delivery = p_kind where id = p_prize;
  delete from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  return p_kind;
end;
$$;
revoke execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) from public, anon, authenticated;
grant execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) to service_role;

-- (add_reward_codes: 0061_personal_bingo.sql's definition, edited)
create or replace function public.add_reward_codes(p_prize uuid, p_creator uuid, p_codes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wheel uuid;
  v_left integer;
  v_new integer;
  v_added integer;
begin
  select wheel_id into v_wheel from public.prizes where id = p_prize;
  -- 0071 (F3): the game's Focus/Chase fans and their links before the game.
  if v_wheel is null or not public._lock_wheel_focus_fans(v_wheel, p_creator) then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  perform 1 from public.prizes where id = p_prize and wheel_id = v_wheel for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 then
    raise exception 'codes must be a non-empty array' using errcode = '22023';
  end if;
  select count(*) into v_left from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  select count(distinct e->>'fingerprint') into v_new from jsonb_array_elements(p_codes) e
   where not exists (select 1 from public.prize_reward_codes c where c.prize_id = p_prize and c.fingerprint = e->>'fingerprint');
  if v_left + v_new > 5000 then
    raise exception 'too many codes on one prize' using errcode = '22023';
  end if;
  with added as (
    insert into public.prize_reward_codes (prize_id, creator_id, cipher, iv, key_version, hint, fingerprint)
    select p_prize, p_creator, e->>'cipher', e->>'iv', coalesce((e->>'key_version')::smallint, 1), nullif(e->>'hint', ''), e->>'fingerprint'
      from jsonb_array_elements(p_codes) e
    on conflict (prize_id, fingerprint) do nothing
    returning 1
  ) select count(*) into v_added from added;
  delete from public.prize_rewards where prize_id = p_prize;
  update public.prizes set delivery = 'codes' where id = p_prize;
  select stock into v_left from public.prizes where id = p_prize;
  return v_added;
end;
$$;
revoke execute on function public.add_reward_codes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_reward_codes(uuid, uuid, jsonb) to service_role;

-- (save_game_wheel: 0062_account_security_lifecycle.sql's definition, edited)
create or replace function public.save_game_wheel(p_context uuid,p_wheel uuid,p_creator uuid,p_prizes jsonb,p_config jsonb,p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
declare w public.wheels%rowtype; error_code text;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'edit_wheel') then raise exception 'forbidden' using errcode='42501'; end if;
 -- 0071 (F3): fans before the game, as save_wheel_prizes below takes them.
 if not public._lock_wheel_focus_fans(p_wheel,p_creator) then raise exception 'game_not_found' using errcode='P0002'; end if;
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
revoke execute on function public.save_game_wheel(uuid, uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_game_wheel(uuid, uuid, uuid, jsonb, jsonb, uuid) to service_role;

-- ── (o) F4: suspension / deletion and the account writers ───────────────────
-- (_focus_lifecycle: 0059_focus_attempt_ledger.sql's definition, edited)
create or replace function public._focus_lifecycle()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_fan uuid;
begin
  if tg_table_name='fans' then
    if tg_op='DELETE' or (new.blocked_at is not null and old.blocked_at is null) then
      perform public._release_fan_focus(old.id);
      if tg_op='DELETE' then
        update public.spin_attempts set context=null,result=case when result is null then null else jsonb_set(jsonb_set(result,'{spin,fan_id}','null'::jsonb),'{spin,fan_pass_id}','null'::jsonb) end where fan_id=old.id;
      end if;
    elsif new.break_until is distinct from old.break_until then
      update public.fan_focus set status=case when new.break_until>now() then 'paused' else 'active' end,version=version+1
        where fan_id=new.id and status in('active','paused');
    end if;
  elsif tg_table_name='fan_passes' then
    if tg_op='DELETE' or not new.is_active or new.self_excluded_at is not null then
      for v_fan in select distinct fan_id from public.fan_focus where fan_pass_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  elsif tg_table_name='prizes' then
    -- Changing delivery while a chase is held also invalidates that promise.
    if tg_op='DELETE' or new.delivery is distinct from old.delivery then
      perform set_config('fanfunnel.focus_prize_lifecycle',old.id::text,true);
      if tg_op<>'DELETE' and new.stock is not null then
        new.stock:=new.stock+(select count(*) from public.chase_reservations where prize_id=old.id and kind in('stock','code') and state='held');
      end if;
      for v_fan in select distinct fan_id from public.fan_focus where prize_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
      perform set_config('fanfunnel.focus_prize_lifecycle','',true);
    end if;
  elsif tg_table_name='wheels' then
    if tg_op='DELETE' or new.archived_at is not null then
      for v_fan in select distinct fan_id from public.fan_focus where wheel_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  elsif tg_table_name='profiles' then
    if tg_op='DELETE' or not new.is_active then
      -- 0071 (F4): every affected fan and its links, in id order, before the
      -- first release takes a game: never a game first and a fan after it.
      perform 1 from public.fans where id in(select fan_id from public.fan_focus where creator_id=old.id and status in('active','paused')) order by id for update;
      perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where creator_id=old.id and status in('active','paused')) order by id for update;
      for v_fan in select fan_id from public.fan_focus where creator_id=old.id and status in('active','paused') order by fan_id loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke execute on function public._focus_lifecycle() from public, anon, authenticated, service_role;

-- (creator_storage_account: 0068_tenant_boundaries_privacy.sql's definition, edited)
create or replace function public.creator_storage_account(p_operation text, p_owner uuid, p_was_admin boolean default false, p_worker uuid default null, p_actor uuid default null, p_action text default 'account.self_close', p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.creator_storage_deletions%rowtype; v_profile public.profiles%rowtype; v_hashes jsonb; v_reserve text;
begin
  perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
  if p_error is not null and p_error not in ('storage_cleanup_failed', 'delete_failed', 'db_error', 'upload_unconfirmed') then raise exception 'invalid work error' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select * into v_profile from public.profiles where id = p_owner for no key update;
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
-- (creator_storage_complete_remove: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_storage_complete_remove(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype;
begin
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  perform id from public.profiles where id = v_owner for no key update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  if v_object.cleanup_kind = 'none' or v_object.upload_state not in ('stored', 'rejected') then return false; end if;
  if v_object.removed_at is not null then return true; end if;
  if v_object.media_id is not null then
    delete from public.creator_media where id = v_object.media_id and creator_id = v_object.owner_id and path = v_object.path;
  end if;
  update public.creator_storage_objects set removed_at = now(), updated_at = now(), last_error = null where id = p_id;
  if v_object.audit_actor is not null then
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_object.id, v_object.audit_actor, 'account.media_remove', 'profile', v_object.owner_id, jsonb_build_object('photosRemoved', 1))
      on conflict (id) do nothing;
  end if;
  return true;
end; $$;
-- (creator_storage_finish_upload: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_storage_finish_upload(p_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_ok boolean; v_object public.creator_storage_objects%rowtype;
begin
  if p_outcome not in ('stored', 'rejected', 'uncertain', 'cleanup', 'publish') then raise exception 'invalid upload outcome' using errcode = '22023'; end if;
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then raise exception 'upload intent missing' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = v_owner for no key update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  v_ok := coalesce(v_ok, false) and v_object.expires_at > now() and not exists (select 1 from public.creator_storage_deletions where owner_id = v_owner and state not in ('paused', 'complete'));
  update public.creator_storage_objects set
    upload_state = case when upload_state in ('stored', 'rejected') or p_outcome in ('cleanup', 'publish') then upload_state else p_outcome end,
    settled_at = case when p_outcome in ('stored', 'rejected') then coalesce(settled_at, now()) else settled_at end,
    cleanup_kind = case when cleanup_kind = 'none' and (not v_ok or p_outcome in ('rejected', 'uncertain', 'cleanup')) then 'orphan' else cleanup_kind end,
    media_id = case when p_outcome='cleanup' then coalesce(media_id,(select m.id from public.creator_media m where m.creator_id=creator_storage_objects.owner_id and m.path=creator_storage_objects.path)) else media_id end,
    updated_at = now()
    where id = p_id returning * into v_object;
  v_ok := v_ok and v_object.upload_state = 'stored' and v_object.cleanup_kind = 'none' and v_object.removed_at is null;
  if p_outcome = 'publish' and v_ok then update public.creator_storage_objects set published_at = coalesce(published_at, now()) where id = p_id; end if;
  return v_ok;
end; $$;
-- (creator_storage_publish_media: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_storage_publish_media(p_id uuid,p_caption text,p_width integer,p_height integer,p_sort_order integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype; v_media public.creator_media%rowtype; v_ok boolean;
begin
 select owner_id into v_owner from public.creator_storage_objects where id=p_id;
 if v_owner is null then raise exception 'upload missing' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||v_owner::text,0));
 select is_active and (approval_status='approved' or role='admin') into v_ok from public.profiles where id=v_owner for no key update;
 select * into v_object from public.creator_storage_objects where id=p_id for update;
 select * into v_media from public.creator_media where id=p_id and creator_id=v_owner and path=v_object.path;
 if v_media.id is not null and v_object.media_id=p_id and v_object.cleanup_kind='none' and v_object.removed_at is null then return to_jsonb(v_media); end if;
 if v_ok is distinct from true or v_object.bucket<>'creator-media' or v_object.upload_state<>'stored' or v_object.cleanup_kind<>'none' or v_object.removed_at is not null or v_object.expires_at<=now() or exists(select 1 from public.creator_storage_deletions where owner_id=v_owner and state not in ('paused','complete')) then raise exception 'media publication forbidden' using errcode='42501'; end if;
 insert into public.creator_media(id,creator_id,path,caption,width,height,sort_order,sfw_attested_at)
 values(p_id,v_owner,v_object.path,p_caption,p_width,p_height,p_sort_order,now()) returning * into v_media;
 update public.creator_storage_objects set media_id=p_id,published_at=now(),updated_at=now() where id=p_id;
 return to_jsonb(v_media);
end; $$;
-- (creator_storage_queue_remove: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_storage_queue_remove(p_owner uuid, p_objects jsonb, p_actor uuid default null, p_admin boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_ok boolean; v_count integer := 0;
begin
  if jsonb_typeof(p_objects) is distinct from 'array' or jsonb_array_length(p_objects) not between 1 and 12 then raise exception 'invalid removal batch' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = p_owner for no key update;
  if p_admin then
    if not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active) then raise exception 'admin required' using errcode = '42501'; end if;
  elsif v_ok is distinct from true or p_actor is distinct from p_owner then raise exception 'creator removal forbidden' using errcode = '42501'; end if;
  for v_item in select value from jsonb_array_elements(p_objects) loop
    if not exists (select 1 from public.creator_media where id = (v_item ->> 'id')::uuid and creator_id = p_owner and path = v_item ->> 'path') then raise exception 'media scope mismatch' using errcode = '42501'; end if;
    insert into public.creator_storage_objects (owner_id, bucket, path, upload_state, cleanup_kind, media_id, audit_actor, settled_at)
      values (p_owner, 'creator-media', v_item ->> 'path', 'stored', 'media', (v_item ->> 'id')::uuid, case when p_admin then p_actor else null end, now())
      on conflict (bucket, path) do update set
        cleanup_kind = 'media', media_id = excluded.media_id, removed_at = null,
        audit_actor = coalesce(public.creator_storage_objects.audit_actor, excluded.audit_actor),
        upload_state = 'stored', settled_at = coalesce(public.creator_storage_objects.settled_at, now()), updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;
-- (creator_storage_register_upload: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_storage_register_upload(p_id uuid, p_owner uuid, p_bucket text, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok
    from public.profiles where id = p_owner for no key update;
  if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](webp|png|jpg|jpeg|gif)$' or v_ok is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = p_owner and state not in ('paused', 'complete')) then
    raise exception 'creator upload forbidden' using errcode = '42501';
  end if;
  -- A duplicate registration never grants permission to launch another upload
  -- to the same immutable path. Retries create a fresh, separately tracked id.
  insert into public.creator_storage_objects (id, owner_id, bucket, path, upload_state,upload_registered)
    values (p_id, p_owner, p_bucket, p_path, 'inflight',true);
  return jsonb_build_object('id', p_id, 'registered', true);
end; $$;
-- (reserve_self_account_deletion: 0062_account_security_lifecycle.sql's definition, edited)
create or replace function public.reserve_self_account_deletion(p_user uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_profile public.profiles%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
 select * into v_profile from public.profiles where id=p_user for no key update;
 if v_profile.id is null then return 'not_found'; end if;
 if v_profile.role='admin' then
   if v_profile.is_active and not exists(select 1 from public.profiles where id<>p_user and role='admin' and is_active) then return 'last_admin'; end if;
   update public.profiles set role='creator' where id=p_user;
 end if;
 return 'ok';
end;
$$;
-- (creator_media_cap: 0058_creator_theme_media.sql's definition, edited)
create or replace function public.creator_media_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_active boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || new.creator_id::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_active
    from public.profiles where id = new.creator_id for no key update;
  if v_active is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = new.creator_id and state not in ('paused', 'complete')) then
    raise exception 'creator media forbidden' using errcode = '42501';
  end if;
  if (select count(*) from public.creator_media where creator_id = new.creator_id) >= 12 then
    raise exception 'creator media limit reached' using errcode = '23514';
  end if;
  return new;
end; $$;
-- Grants unchanged: the account and storage writers stay service-role only.
revoke execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) to service_role;
revoke execute on function public.creator_storage_complete_remove(uuid) from public, anon, authenticated;
grant execute on function public.creator_storage_complete_remove(uuid) to service_role;
revoke execute on function public.creator_storage_finish_upload(uuid, text) from public, anon, authenticated;
grant execute on function public.creator_storage_finish_upload(uuid, text) to service_role;
revoke execute on function public.creator_storage_publish_media(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.creator_storage_publish_media(uuid, text, integer, integer, integer) to service_role;
revoke execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) to service_role;
revoke execute on function public.creator_storage_register_upload(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_register_upload(uuid, uuid, text, text) to service_role;
revoke execute on function public.reserve_self_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.reserve_self_account_deletion(uuid) to service_role;
revoke execute on function public.creator_media_cap() from public, anon, authenticated;
grant execute on function public.creator_media_cap() to service_role;

-- ── (p) F5: a campaign is deleted fans -> links -> campaign ──────────────────
-- DELETE /api/campaigns/[id] (deleteCampaign), owner or a manage seat. The
-- delete's ON DELETE SET NULL rewrites every link and grant in the campaign;
-- a play holds its link and takes key share on the campaign last, so the
-- campaign's fans and links are taken first, then the campaign (with the
-- lifecycle-style nowait re-check for a link that joined meanwhile).
create or replace function public.delete_campaign(p_campaign uuid, p_creator uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_try integer;
begin
  if p_campaign is null or p_creator is null
     or not exists (select 1 from public.campaigns where id = p_campaign and creator_id = p_creator)
     or not (public.can_act_for(p_creator, 'manage') or public.is_admin()) then
    return 'not_found';
  end if;
  for v_try in 1..21 loop
    begin
      perform 1 from public.fans where id in(select fan_id from public.fan_passes where campaign_id=p_campaign
        union select fan_id from public.grants where campaign_id=p_campaign) order by id for update;
      perform 1 from public.fan_passes where campaign_id=p_campaign order by id for update;
      perform 1 from public.campaigns where id=p_campaign for update;
      exit when v_try = 21;
      perform 1 from public.fans where id in(select fan_id from public.fan_passes where campaign_id=p_campaign
        union select fan_id from public.grants where campaign_id=p_campaign) order by id for update nowait;
      perform 1 from public.fan_passes where campaign_id=p_campaign order by id for update nowait;
      exit;
    exception when lock_not_available then null;
    end;
  end loop;
  delete from public.campaigns where id = p_campaign and creator_id = p_creator;
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.delete_campaign(uuid, uuid) from public, anon;
grant execute on function public.delete_campaign(uuid, uuid) to authenticated, service_role;
comment on function public.delete_campaign(uuid, uuid) is 'Deletes a campaign (owner, manage seat or admin), locking its fans and links before it (0071). DELETE on campaigns is revoked from sessions.';

-- ── (r) the migration level this database was built to ─────────────────────
create or replace function public.schema_version()
returns integer language sql immutable as $$ select 71 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0071). Every migration redefines it with its own number; the app flags a database behind its expected level.';
