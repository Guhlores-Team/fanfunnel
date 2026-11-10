-- 0073: batch-7 hardening (database audit DB-01..DB-20, concurrency CC-01..
-- CC-08, attacker ATK-05/06 + nits, server RS-01, agency walk WG-02/WG-07,
-- trust TS-01/03/05/06, ops OPS-06/OPS3-05/OPS3-10, perf PA-03, product PR-13).
-- Replayable: every statement is idempotent (create or replace, add column /
-- index if not exists, drop … if exists before create, constraints added only
-- when missing, backfills on conflict do nothing). Sections carry the finding
-- ids; the owner pre-check for DB-07 is the 7-row constraint query in the
-- batch-7 report (GO_LIVE §5).
--
-- Lock shape at go-live (DB-20): one transaction; the new indexes are small
-- btrees on near-empty tables (not CONCURRENTLY, they block writes on their
-- table only while they build); four DROP POLICY/CREATE POLICY pairs take an
-- AccessExclusive lock on messages, redemptions, grants and spin_attempts
-- until commit; NOT VALID CHECKs take a short lock and VALIDATE only a
-- SHARE UPDATE EXCLUSIVE one. Function redefinitions and the search_path
-- ALTERs lock nothing a play holds. Apply outside the nightly job window.

-- ── (1) DB-07: the 0052 ledger CHECKs are re-asserted and must validate ──
-- 0052 dropped a CHECK with a warning when a row violated it, so a LIVE
-- database may lack one. Here a missing CHECK is added NOT VALID and then
-- validated; a negative row stops the migration with an exception (never a
-- warning): fix the row by hand first.
do $$
declare r record; v_bad bigint; v_valid boolean;
begin
  for r in select * from (values
      ('fan_passes', 'fan_passes_spins_granted_total_check', 'spins_granted_total'),
      ('fan_passes', 'fan_passes_spins_remaining_check', 'spins_remaining'),
      ('fans', 'fans_spins_granted_total_check', 'spins_granted_total'),
      ('fans', 'fans_spins_remaining_check', 'spins_remaining'),
      ('fans', 'fans_rl_count_check', 'rl_count'),
      ('prizes', 'prizes_stock_check', 'stock'),
      ('prizes', 'prizes_cost_cents_check', 'cost_cents')) as t(tbl, con, col) loop
    if not exists (select 1 from pg_constraint where conname = r.con and conrelid = ('public.' || r.tbl)::regclass) then
      execute format('alter table public.%I add constraint %I check (%I >= 0) not valid', r.tbl, r.con, r.col);
    end if;
    select convalidated into v_valid from pg_constraint where conname = r.con and conrelid = ('public.' || r.tbl)::regclass;
    if not v_valid then
      execute format('select count(*) from public.%I where %I < 0', r.tbl, r.col) into v_bad;
      if v_bad > 0 then
        raise exception '0073 (DB-07): % row(s) in public.% have % < 0; repair them by hand, then re-run 0073', v_bad, r.tbl, r.col;
      end if;
      execute format('alter table public.%I validate constraint %I', r.tbl, r.con);
    end if;
  end loop;
end $$;

-- ── (2) DB-01: creator_id is immutable on every creator-owned table ──────
-- A manager seat passes can_act_for for two creators of its agency, so the
-- FOR ALL write policies let it move a fan or a campaign between them (the
-- fan's link then stops working). The trigger fires last (zz_) so tables with
-- their own guard (wheels, fan_passes, redemptions, grants) keep their error
-- text; the referential SET NULL of an account deletion (creator_reports)
-- still passes because the old creator's profile is gone by then.
create or replace function public._guard_creator_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.creator_id is distinct from old.creator_id
     and not (new.creator_id is null and not exists (select 1 from public.profiles p where p.id = old.creator_id)) then
    raise exception 'creator_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public._guard_creator_immutable() from public, anon, authenticated, service_role;
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'creator_id' and not a.attisdropped
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by c.relname loop
    execute format('drop trigger if exists zz_creator_immutable on public.%I', r.relname);
    execute format('create trigger zz_creator_immutable before update of creator_id on public.%I for each row execute function public._guard_creator_immutable()', r.relname);
  end loop;
end $$;

-- ── DB-05: prizes are edited only through the SECURITY DEFINER editors ────
-- A direct UPDATE/DELETE locks the prize before its triggers lock the game
-- (prize -> wheel), the reverse of every play (wheel -> prize): a 40P01 for
-- a fan mid-spin. The app only INSERTs prizes when a game is created; every
-- edit already goes through save_wheel_prizes, set_prize_delivery,
-- add_reward_codes and save_game_wheel.
revoke update, delete on public.prizes from authenticated;

-- ── DB-09: safety reports are resolved, never deleted, by a session ───────
revoke delete on public.creator_reports from authenticated;

-- ── DB-16: defence in depth on the two RPC-only ledgers ───────────────────
revoke insert, delete on public.profiles from authenticated;
revoke insert, update, delete on public.spins from authenticated;

-- ── ATK-05: the four read policies follow the seat's job, not 'view' ─────
-- 'view' is every seat's permission, so a fulfil-only seat could read every
-- chat and a chat-only seat every fulfilment note and grant amount through
-- PostgREST. The creator itself keeps reading its own rows (including the
-- read-only dashboard of a suspended account: can_act_for(self, 'view')).
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select
  using ((creator_id = (select auth.uid()) and public.can_act_for(creator_id, 'view'))
         or public.can_act_for(creator_id, 'chat') or public.is_admin());
drop policy if exists redemptions_select on public.redemptions;
create policy redemptions_select on public.redemptions for select
  using ((creator_id = (select auth.uid()) and public.can_act_for(creator_id, 'view'))
         or public.can_act_for(creator_id, 'fulfil') or public.is_admin());
drop policy if exists grants_select on public.grants;
create policy grants_select on public.grants for select
  using ((creator_id = (select auth.uid()) and public.can_act_for(creator_id, 'view'))
         or public.can_act_for(creator_id, 'grant') or public.is_admin());
drop policy if exists spin_attempts_select on public.spin_attempts;
create policy spin_attempts_select on public.spin_attempts for select to authenticated
  using ((creator_id = (select auth.uid()) and public.can_act_for(creator_id, 'view'))
         or public.can_act_for(creator_id, 'grant') or public.is_admin());

-- ── DB-02 / ATK N-C: an access request is pinned to its applicant ────────
-- The applicant's INSERT carried any e-mail, status and dates (and an
-- unbounded note). A session insert now takes the e-mail from auth.users,
-- status 'pending', created_at now() and no decision; the service role (and
-- the admin decision path) is unaffected. One request per account (the
-- unique constraint is added when a LIVE database lacks it), no session
-- DELETE, and decision_reason for the 90-day retention promise (DB-04).
alter table public.creator_applications add column if not exists decision_reason text;
create or replace function public._guard_creator_application_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    new.profile_id := auth.uid();
    new.email := (select u.email from auth.users u where u.id = new.profile_id);
    new.status := 'pending';
    new.created_at := now();
    new.decided_at := null;
    new.decision_reason := null;
  end if;
  return new;
end $$;
revoke execute on function public._guard_creator_application_insert() from public, anon, authenticated, service_role;
drop trigger if exists aa_creator_application_pin on public.creator_applications;
create trigger aa_creator_application_pin before insert on public.creator_applications
  for each row execute function public._guard_creator_application_insert();
revoke delete on public.creator_applications from authenticated;
do $$
declare v_dups bigint;
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.creator_applications'::regclass and contype = 'u'
                   and conkey = array[(select attnum from pg_attribute where attrelid = 'public.creator_applications'::regclass and attname = 'profile_id')]) then
    select count(*) into v_dups from (select profile_id from public.creator_applications group by profile_id having count(*) > 1) d;
    if v_dups > 0 then
      raise exception '0073 (ATK N-C): % applicant(s) hold more than one access request; keep one row each by hand, then re-run 0073', v_dups;
    end if;
    alter table public.creator_applications add constraint creator_applications_profile_id_key unique (profile_id);
  end if;
end $$;

-- ── DB-03 / ATK N-A: free text a session writes has a size limit ─────────
-- Each CHECK sits at or above the app's own limit (routes and data layer), is
-- added NOT VALID and validated only when every existing row passes; an
-- over-long LIVE row leaves that one CHECK NOT VALID with a warning instead
-- of blocking the migration (new writes are still checked).
create or replace function public._text_array_within(p_values text[], p_max_items integer, p_max_each integer)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_length(p_values, 1), 0) <= p_max_items
     and coalesce((select max(char_length(v)) from unnest(p_values) v), 0) <= p_max_each
$$;
-- A CHECK runs as the writing role, so the pure helper stays executable.
grant execute on function public._text_array_within(text[], integer, integer) to public;
do $$
declare r record; v_bad bigint; v_valid boolean;
begin
  for r in select * from (values
      ('fans', 'fans_notes_len_check', 'notes is null or char_length(notes) <= 2000'),
      ('fans', 'fans_tags_shape_check', 'public._text_array_within(tags, 50, 64)'),
      ('fans', 'fans_display_name_len_check', 'display_name is null or char_length(display_name) <= 80'),
      ('fans', 'fans_handle_len_check', 'handle is null or char_length(handle) <= 80'),
      ('prizes', 'prizes_label_len_check', 'char_length(label) <= 120'),
      ('prizes', 'prizes_description_len_check', 'description is null or char_length(description) <= 1000'),
      ('prizes', 'prizes_color_len_check', 'color is null or char_length(color) <= 32'),
      ('prizes', 'prizes_emoji_len_check', 'emoji is null or char_length(emoji) <= 32'),
      ('wheels', 'wheels_title_len_check', 'char_length(title) <= 120'),
      ('wheels', 'wheels_subtitle_len_check', 'subtitle is null or char_length(subtitle) <= 200'),
      ('wheel_templates', 'wheel_templates_name_len_check', 'char_length(name) <= 120'),
      ('wheel_templates', 'wheel_templates_title_len_check', 'char_length(title) <= 120'),
      ('wheel_templates', 'wheel_templates_subtitle_len_check', 'subtitle is null or char_length(subtitle) <= 200'),
      ('campaigns', 'campaigns_name_len_check', 'char_length(name) <= 120'),
      ('orgs', 'orgs_name_len_check', 'char_length(name) <= 120'),
      ('wishlists', 'wishlists_prize_label_len_check', 'char_length(prize_label) <= 120'),
      ('dm_templates', 'dm_templates_title_len_check', 'char_length(title) <= 120'),
      ('dm_templates', 'dm_templates_body_len_check', 'char_length(body) <= 2000'),
      ('prize_templates', 'prize_templates_label_len_check', 'char_length(label) <= 120'),
      ('prize_templates', 'prize_templates_description_len_check', 'description is null or char_length(description) <= 1000'),
      ('campaign_packs', 'campaign_packs_label_len_check', 'char_length(label) <= 120'),
      ('profiles', 'profiles_chat_intro_len_check', 'chat_intro is null or char_length(chat_intro) <= 2000'),
      ('profiles', 'profiles_chat_outro_len_check', 'chat_outro is null or char_length(chat_outro) <= 2000'),
      ('profiles', 'profiles_creator_note_len_check', 'creator_note is null or char_length(creator_note) <= 2000'),
      ('creator_applications', 'creator_applications_display_name_len_check', 'display_name is null or char_length(display_name) <= 120'),
      ('creator_applications', 'creator_applications_socials_len_check', 'socials is null or char_length(socials) <= 600'),
      ('creator_applications', 'creator_applications_audience_size_len_check', 'audience_size is null or char_length(audience_size) <= 120'),
      ('creator_applications', 'creator_applications_note_len_check', 'note is null or char_length(note) <= 1000'),
      ('creator_applications', 'creator_applications_email_len_check', 'email is null or char_length(email) <= 320'),
      ('creator_applications', 'creator_applications_decision_reason_len_check', 'decision_reason is null or char_length(decision_reason) <= 500')
    ) as t(tbl, con, expr) loop
    if not exists (select 1 from pg_constraint where conname = r.con and conrelid = ('public.' || r.tbl)::regclass) then
      execute format('alter table public.%I add constraint %I check (%s) not valid', r.tbl, r.con, r.expr);
    end if;
    select convalidated into v_valid from pg_constraint where conname = r.con and conrelid = ('public.' || r.tbl)::regclass;
    if not v_valid then
      execute format('select count(*) from public.%I where not (%s)', r.tbl, r.expr) into v_bad;
      if v_bad > 0 then
        raise warning '0073 (DB-03): % row(s) in public.% exceed %; the CHECK stays NOT VALID until they are shortened', v_bad, r.tbl, r.con;
      else
        execute format('alter table public.%I validate constraint %I', r.tbl, r.con);
      end if;
    end if;
  end loop;
end $$;

-- set_chat_settings / set_creator_note validate what the routes validate
-- (2000 characters each; the greeting and sign-off are sent to every fan).
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if char_length(trim(coalesce(p_intro, ''))) > 2000 or char_length(trim(coalesce(p_outro, ''))) > 2000
     or coalesce(p_intro, '') ~ '[^[:print:][:space:]]' or coalesce(p_outro, '') ~ '[^[:print:][:space:]]' then
    raise exception 'invalid chat settings' using errcode = '22023';
  end if;
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true and public.current_user_active();
end $$;
revoke execute on function public.set_chat_settings(text, text) from public, anon;
grant execute on function public.set_chat_settings(text, text) to authenticated;
create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(trim(coalesce(p_avatar, '')), '') is not null
     and (length(trim(p_avatar)) > 2048
          or trim(p_avatar) !~ '^https://[^/[:space:]]+/storage/v1/object/public/avatars/[^[:space:]]+$') then
    raise exception 'invalid avatar url' using errcode = '22023';
  end if;
  if p_note is not null and (char_length(trim(p_note)) > 2000 or p_note ~ '[^[:print:][:space:]]') then
    raise exception 'invalid creator note' using errcode = '22023';
  end if;
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end $$;
revoke execute on function public.set_creator_note(text, text) from public, anon;
grant execute on function public.set_creator_note(text, text) to authenticated;

-- ── TS-03 / ATK N-B: nobody is "FanFunnel", "Support" or "admin" ─────────
-- One reserved list (mirrored by src/lib/reservedNames.ts): a name whose
-- normalized form (lower-case, spaces and _ . - removed, a leading @ dropped)
-- equals an entry, whose words include a staff/operator word, or which
-- contains the product name is refused by set_display_name, set_public_profile
-- (slug) and the public-fields trigger (direct writes).
create or replace function public._reserved_name(p text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  with n as (
    select lower(regexp_replace(regexp_replace(coalesce(p, ''), '^\s*@', ''), '[\s._-]+', '', 'g')) as whole,
           regexp_split_to_array(lower(regexp_replace(coalesce(p, ''), '[^[:alnum:]]+', ' ', 'g')), '\s+') as words
  )
  select coalesce(p, '') <> '' and (
       n.whole in ('fanfunnel', 'easysimplesites', 'support', 'admin', 'administrator', 'staff', 'official', 'moderator', 'mod',
                   'help', 'security', 'billing', 'verify', 'team', 'system', 'root', 'api', 'www', 'mail', 'abuse', 'legal',
                   'privacy', 'terms')
    or n.whole like '%fanfunnel%' or n.whole like '%easysimplesites%'
    or n.words && array['admin', 'administrator', 'support', 'staff', 'official', 'moderator', 'mod', 'security', 'billing', 'abuse', 'system', 'root'])
  from n
$$;
revoke execute on function public._reserved_name(text) from public, anon, authenticated, service_role;
create or replace function public.set_display_name(p_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
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
  -- 0073 (TS-03): never the operator, staff or another reserved identity.
  if public._reserved_name(v) then
    raise exception 'reserved display name' using errcode = '22023';
  end if;
  update public.profiles set display_name = v where id = auth.uid() and public._session_mfa_satisfied();
end $$;
revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated, service_role;
create or replace function public.set_public_profile(p_slug text, p_tip_url text, p_tagline text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
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
  -- 0073 (TS-03, ATK N-B): /c/admin, /c/support, /c/fanfunnel are nobody's.
  if nullif(trim(coalesce(p_slug, '')), '') is not null and public._reserved_name(trim(p_slug)) then
    raise exception 'reserved slug' using errcode = '22023';
  end if;
  if p_tagline is not null and char_length(trim(p_tagline)) > 200 then
    raise exception 'invalid tagline' using errcode = '22023';
  end if;
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end $$;
revoke execute on function public.set_public_profile(text, text, text) from public, anon;
grant execute on function public.set_public_profile(text, text, text) to authenticated, service_role;
create or replace function public._guard_profile_public_fields()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.display_name is distinct from old.display_name or new.email is distinct from old.email then
    new.display_name := public._safe_display_name(new.display_name, new.email);
  end if;
  if new.public_slug is not null and (tg_op = 'INSERT' or new.public_slug is distinct from old.public_slug)
     and not public._valid_public_slug(new.public_slug) then
    raise exception 'invalid slug' using errcode = '22023';
  end if;
  if new.public_slug is not null and (tg_op = 'INSERT' or new.public_slug is distinct from old.public_slug)
     and public._reserved_name(new.public_slug) then
    raise exception 'reserved slug' using errcode = '22023';
  end if;
  if new.public_tagline is not null and (tg_op = 'INSERT' or new.public_tagline is distinct from old.public_tagline)
     and char_length(new.public_tagline) > 200 then
    raise exception 'invalid tagline' using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function public._guard_profile_public_fields() from public, anon, authenticated, service_role;

-- ── (3) DB-06: a creator-side fan deletion leaves link tombstones ─────────
create or replace function public.scrub_fan_traces()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 0073 (DB-06): the fan's links get a tombstone whoever deletes the fan
  -- (creator, seat, account reset), so a saved link answers "your data was
  -- deleted" instead of a bare 404. An account closure writes its own
  -- creator_closed tombstones, so the cascade of a deleted creator skips this.
  if exists (select 1 from public.profiles p where p.id = old.creator_id) then
    insert into public.link_tombstones (token_hash, reason)
    select encode(sha256(convert_to(p.token, 'UTF8')), 'hex'), 'fan_deleted'
      from public.fan_passes p where p.fan_id = old.id
    on conflict (token_hash) do nothing;
  end if;
  -- Rows whose creator is being deleted in this same statement are cascaded
  -- away right after this; touching them would re-check the creator FK.
  update public.creator_reports set token = null
   where token is not null
     and (fan_id = old.id or token in (select p.token from public.fan_passes p where p.fan_id = old.id))
     and (creator_id is null or exists (select 1 from public.profiles p where p.id = creator_reports.creator_id));
  delete from public.spin_attempts where fan_id = old.id and state = 'declined';
  update public.spin_attempts set token_hash = '', context = null
   where fan_id = old.id and exists (select 1 from public.profiles p where p.id = spin_attempts.creator_id);
  update public.redemptions r set notes = null
   where r.notes is not null and r.spin_id in (select s.id from public.spins s where s.fan_id = old.id)
     and exists (select 1 from public.profiles p where p.id = r.creator_id);
  update public.redemptions r set due_at = null
   where r.due_at is not null and r.spin_id in (select s.id from public.spins s where s.fan_id = old.id)
     and exists (select 1 from public.profiles p where p.id = r.creator_id);
  return old;
end;
$$;
revoke execute on function public.scrub_fan_traces() from public, anon, authenticated, service_role;

-- ── DB-04/OPS-06, DB-08/OPS3-10, CC-08: the nightly cleanup ───────────────
create or replace function public.run_retention_cleanup(
  p_audit_days integer,
  p_notice_days integer,
  p_tombstone_days integer,
  p_app_error_days integer,
  p_closed_invite_days integer
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
  -- 0073 (DB-04 / OPS-06): matches DECLINED_ACCESS_REQUEST_DAYS; a declined
  -- access request is deleted 90 days after the decision (the applicant's
  -- Auth user is the service gateway's job: the ids are returned for it).
  v_declined_application_days constant integer := 90;
  -- 0073 (CC-08): a pending attempt older than this moved no credit, stock or
  -- seed (commit re-checks everything); it is finished as declined/stale so its
  -- prepared context and link hash do not live for good.
  v_pending_attempt_days constant integer := 1;
  v_declined_applications integer := 0;
  v_declined_applicants jsonb := '[]'::jsonb;
  v_stale_attempts integer := 0;
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
  -- 0073 (DB-08 / OPS3-10): one cleanup at a time; an overlapping cron hit or
  -- a manual run queues behind the running one instead of racing its deletes.
  perform pg_advisory_xact_lock(hashtextextended('fanfunnel-retention', 0));

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
  -- 0073 (CC-08): age out attempts left pending by a refused commit, a crash
  -- between prepare and commit, or a fan who never retried.
  update public.spin_attempts set state = 'declined', error = 'stale', finished_at = now(), context = null, token_hash = ''
   where state = 'pending' and created_at < now() - make_interval(days => v_pending_attempt_days);
  get diagnostics v_stale_attempts = row_count;
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

  -- 0073 (DB-04 / OPS-06): declined access requests after their period.
  with gone as (
    delete from public.creator_applications
     where status = 'rejected' and decided_at is not null
       and decided_at < now() - make_interval(days => v_declined_application_days)
    returning profile_id)
  select count(*), coalesce(jsonb_agg(profile_id), '[]'::jsonb) into v_declined_applications, v_declined_applicants from gone;

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
    'stale_spin_attempts', v_stale_attempts,
    'declined_applications', v_declined_applications,
    'declined_applicant_ids', v_declined_applicants,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;
revoke execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) to service_role;

create or replace function public.creator_storage_prune(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  -- 0073 (DB-08 / OPS3-10): serialised with the retention cleanup.
  perform pg_advisory_xact_lock(hashtextextended('fanfunnel-retention', 0));
  -- Uncertain/inflight work is never expired: absence is not completion proof.
  delete from public.creator_storage_objects where removed_at < now() - make_interval(days => greatest(p_days, 1)) and upload_state in ('stored', 'rejected') and not exists(select 1 from public.creator_storage_dispatches d where d.object_id=creator_storage_objects.id and d.state in ('pending','uncertain'));
  get diagnostics v_count = row_count;
  delete from public.creator_storage_deletions where state = 'complete' and completed_at < now() - make_interval(days => greatest(p_days, 1));
  delete from public.creator_storage_dispatches d where state in ('acknowledged','rejected') and settled_at<now()-make_interval(days=>greatest(p_days,1)) and (kind<>'manifest' or not exists(select 1 from public.creator_storage_deletions j where j.owner_id=d.owner_id and j.attempt_id=d.attempt_id and j.state not in ('complete','paused')));
  return v_count;
end; $$;
revoke execute on function public.creator_storage_prune(integer) from public, anon, authenticated;
grant execute on function public.creator_storage_prune(integer) to service_role;

-- ── OPS3-05: the canary failure flag clears on the next successful check ──
create or replace function public.record_system_health_check(p_source text,p_canary_status text,p_invariants jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text; v_counts jsonb:='{}'; v_row public.system_health_checks%rowtype;
begin
 if p_source is null or p_canary_status is null or p_source not in('startup','manual','maintenance') or p_canary_status not in('healthy','missing','configuration_missing','configuration_invalid','mismatch','unavailable') then raise exception 'invalid health result' using errcode='22023'; end if;
 if p_invariants is not null then
   v_status:=p_invariants->>'status'; v_counts:=p_invariants->'counts';
   if jsonb_typeof(p_invariants)<>'object' or v_status is null or v_status not in('healthy','violations','incomplete','unavailable') or v_counts is null or jsonb_typeof(v_counts)<>'object' or octet_length(v_counts::text)>4096 or
      exists(select 1 from jsonb_each_text(v_counts) e where e.key not in('codeStockMismatch','heldReservationMismatch','liveChaseMissingReservation','heldCodeMismatch','orphanReservedCode','unwitnessedStockReservation','fanCreditMismatch') or e.value!~'^[0-9]{1,10}$')
   then raise exception 'invalid invariant result' using errcode='22023'; end if;
   if v_status in('healthy','violations') and (
     (select count(*) from jsonb_object_keys(v_counts))<>7 or
     (v_status='healthy' and exists(select 1 from jsonb_each_text(v_counts) where value::numeric<>0)) or
     (v_status='violations' and not exists(select 1 from jsonb_each_text(v_counts) where value::numeric>0))
   ) then raise exception 'incomplete or inconsistent invariant result' using errcode='22023'; end if;
 end if;
 insert into public.system_health_checks(singleton,canary_status,canary_checked_at,canary_failure_at,invariants_status,invariant_counts,invariants_checked_at,last_maintenance_at,last_source)
 values(true,p_canary_status,now(),case when p_canary_status<>'healthy' then now() end,coalesce(v_status,'not_run'),v_counts,case when p_invariants is not null then now() end,case when p_source='maintenance' then now() end,p_source)
 on conflict(singleton) do update set
   canary_status=excluded.canary_status,canary_checked_at=excluded.canary_checked_at,
   -- 0073 (OPS3-05): a healthy manual run, or a healthy maintenance run whose
   -- ledger check is healthy too, clears the sticky failure; a startup blip
   -- never clears it (nothing was verified) and never re-latches a clean row.
   canary_failure_at=case when p_canary_status<>'healthy' then now() when p_source='manual' then null
     when p_source='maintenance' and coalesce(v_status,'healthy')='healthy' then null else system_health_checks.canary_failure_at end,
   invariants_status=case when p_invariants is not null then excluded.invariants_status else system_health_checks.invariants_status end,
   invariant_counts=case when p_invariants is not null then excluded.invariant_counts else system_health_checks.invariant_counts end,
   invariants_checked_at=coalesce(excluded.invariants_checked_at,system_health_checks.invariants_checked_at),
   last_maintenance_at=coalesce(excluded.last_maintenance_at,system_health_checks.last_maintenance_at),last_source=excluded.last_source
 where p_source<>'startup' or system_health_checks.canary_status is distinct from excluded.canary_status or system_health_checks.canary_checked_at<now()-interval '5 minutes'
 returning * into v_row;
 if v_row.singleton is null then select * into v_row from public.system_health_checks where singleton; end if;
 return jsonb_build_object('canaryStatus',v_row.canary_status,'canaryCheckedAt',v_row.canary_checked_at,'canaryFailureAt',v_row.canary_failure_at,'invariantsStatus',v_row.invariants_status,'invariantCounts',v_row.invariant_counts,'invariantsCheckedAt',v_row.invariants_checked_at,'lastMaintenanceAt',v_row.last_maintenance_at);
end $$;
revoke execute on function public.record_system_health_check(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_system_health_check(text,text,jsonb) to service_role;

-- ── (4) CC-01: the owner's reset deletes its fans under the pre-locks ──────
create or replace function public.reset_creator_content(p_context uuid, p_creator uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_creator is null or p_actor is distinct from p_creator
     or not public._creator_actor_allowed(p_context, p_actor, p_creator, 'edit_wheel', 'edit_wheel') then
    return 'forbidden';
  end if;
  -- fan -> pass -> campaign/wheel -> prize, as every play takes them.
  perform 1 from public.fans where creator_id = p_creator order by id for update;
  perform 1 from public.fan_passes where creator_id = p_creator order by id for update;
  -- 0073 (CC-01): the fans go here, after every fan and link is held, so the
  -- per-row release of a Chase reservation (wheel -> prize) never runs while
  -- a later fan of the same statement is still unlocked; the route's own
  -- session DELETE of fans deadlocked against a committing play.
  delete from public.fans where creator_id = p_creator;
  -- Every link goes with its game (wheel_id cascades). Deleted here first, so
  -- a link set to another game is never rewritten by that pin's SET NULL after
  -- its own game is gone (its tenant guard would refuse the missing game).
  delete from public.fan_passes where creator_id = p_creator;
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

-- ── CC-07: archive/delete pre-lock the fans' links too (fan -> pass -> game) ──
-- A direct fan_passes.is_active write by a creator session holds the pass and
-- its trigger then wants the fan; the lifecycle helper held the fan and
-- wanted the pass through _release_fan_focus. Same set as _lock_wheel_focus_fans.
create or replace function public._lock_wheel_lifecycle(p_wheel uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_try integer;
begin
 for v_try in 1..20 loop
   begin
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
     perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
     perform 1 from public.wheels where id=p_wheel for update;
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update nowait;
     perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update nowait;
     return;
   exception when lock_not_available then null;
   end;
 end loop;
 perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
   union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
 perform 1 from public.fan_passes where fan_id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
   union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
 perform 1 from public.wheels where id=p_wheel for update;
end $$;
revoke execute on function public._lock_wheel_lifecycle(uuid) from public,anon,authenticated,service_role;

-- ── CC-04: the seat row is held while a seat's actor-context write runs ────
create or replace function public._creator_actor_allowed(p_context uuid,p_actor uuid,p_creator uuid,p_scope text,p_permission text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
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
 -- 0073 (CC-04): a seat's authority is held (key share on its seat row) for
 -- the rest of the write, so org_remove_member waits for an in-flight grant
 -- instead of a removed seat's queued write landing after the removal.
 if coalesce(allowed,false) and p_scope<>'system_health' and c.actor_id is distinct from p_creator then
   perform 1 from public.org_members m join public.orgs o on o.id=m.org_id join public.profiles p on p.org_id=o.id
    where m.profile_id=c.actor_id and p.id=p_creator for key share of m;
   if not found then allowed:=false; end if;
 end if;
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

-- ── CC-05, DB-11: the service prize editors re-check the creator after the
-- locks, and save_wheel_prizes takes the editor's game version ───────────────
drop function if exists public.save_wheel_prizes(uuid, uuid, jsonb);
create or replace function public.save_wheel_prizes(p_wheel uuid, p_creator uuid, p_prizes jsonb, p_expected_updated_at timestamptz default null)
returns void
language plpgsql
security definer set search_path = public, pg_temp
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
  -- 0073 (CC-05): the creator must still be active once the locks are held
  -- (the route checked the session before the service call).
  if not exists (select 1 from public.profiles where id = p_creator and is_active and (approval_status = 'approved' or role = 'admin')) then
    raise exception 'creator_unavailable' using errcode = '42501';
  end if;
  -- 0073 (DB-11): a game-version compare-and-set. The editor passes the
  -- updated_at it loaded; a save over a newer version is game_changed, and a
  -- successful save stamps updated_at itself (the caller must not pre-stamp).
  if p_expected_updated_at is not null
     and (select date_trunc('milliseconds', updated_at) from public.wheels where id = p_wheel) is distinct from date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'game_changed' using errcode = '22023';
  end if;
  perform set_config('fanfunnel.prize_set', coalesce((select jsonb_agg(to_jsonb(pr) - 'stock' order by pr.id)::text from public.prizes pr where pr.wheel_id = p_wheel), '[]'), true);
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
  if coalesce((select jsonb_agg(to_jsonb(pr) - 'stock' order by pr.id)::text from public.prizes pr where pr.wheel_id = p_wheel), '[]')
     is distinct from current_setting('fanfunnel.prize_set', true) then
    update public.wheels set updated_at = now() where id = p_wheel;
  end if;
end;
$$;
revoke execute on function public.save_wheel_prizes(uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.save_wheel_prizes(uuid, uuid, jsonb, timestamptz) to service_role;

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
set search_path = public, pg_temp
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
  -- 0073 (CC-05): the creator must still be active once the locks are held
  -- (the route checked the session before the service call).
  if not exists (select 1 from public.profiles where id = p_creator and is_active and (approval_status = 'approved' or role = 'admin')) then
    raise exception 'creator_unavailable' using errcode = '42501';
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

create or replace function public.add_reward_codes(p_prize uuid, p_creator uuid, p_codes jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
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
  -- 0073 (CC-05): the creator must still be active once the locks are held
  -- (the route checked the session before the service call).
  if not exists (select 1 from public.profiles where id = p_creator and is_active and (approval_status = 'approved' or role = 'admin')) then
    raise exception 'creator_unavailable' using errcode = '42501';
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

-- ── CC-03: can_act_for is repeated after the last lock in the session RPCs ──
create or replace function public.set_redemption_state(p_redemption uuid, p_creator uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.redemptions%rowtype; s public.spins%rowtype; pr public.prizes%rowtype;
  v_status public.redemption_status; v_due timestamptz; v_unit text; v_stock text := 'none';
begin
  if auth.uid() is null then raise exception 'authenticated session required' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('status', 'notes', 'due_at'))
     or (p_patch ? 'status' and jsonb_typeof(p_patch->'status') <> 'string')
     or (p_patch ? 'notes' and jsonb_typeof(p_patch->'notes') not in ('string', 'null'))
     or (p_patch ? 'due_at' and jsonb_typeof(p_patch->'due_at') not in ('string', 'null'))
     or char_length(coalesce(p_patch->>'notes', '')) > 2000 then
    raise exception 'invalid redemption patch' using errcode = '22023';
  end if;
  v_status := (p_patch->>'status')::public.redemption_status;
  v_due := (p_patch->>'due_at')::timestamptz;
  -- The redemptions RLS predicate, on the caller, before any row is read.
  if p_creator is null or not (public.can_act_for(p_creator, 'fulfil') or public.is_admin()) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select s0.* into s from public.redemptions r0 join public.spins s0 on s0.id = r0.spin_id
   where r0.id = p_redemption and r0.creator_id = p_creator and s0.creator_id = p_creator;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  -- Wheel -> prize -> redemption: the suffix of every award's lock order.
  perform 1 from public.wheels where id = s.wheel_id and creator_id = p_creator for update;
  select p.* into pr from public.prizes p join public.spins s1 on s1.prize_id = p.id
   where s1.id = s.id and p.wheel_id = s.wheel_id for update of p;
  select * into r from public.redemptions where id = p_redemption and creator_id = p_creator for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  -- 0073 (CC-03): the caller's authority is evaluated again once every lock is
  -- held, so a seat removed while this call waited cannot complete the write.
  if not (public.can_act_for(p_creator, 'fulfil') or public.is_admin()) then return jsonb_build_object('status', 'forbidden'); end if;
  v_unit := r.stock_unit;
  if v_status is not null and (v_status = 'cancelled') <> (r.status = 'cancelled') then
    if v_status = 'cancelled' and r.stock_unit = 'held' then
      if pr.id is not null and pr.stock is not null and pr.delivery <> 'codes' then
        update public.prizes set stock = stock + 1 where id = pr.id;
        v_unit := 'returned'; v_stock := 'returned';
      else
        v_unit := null;
      end if;
    elsif v_status <> 'cancelled' and r.stock_unit = 'returned' then
      if pr.id is not null and pr.stock is not null and pr.delivery <> 'codes' then
        if pr.stock <= 0 then return jsonb_build_object('status', 'sold_out'); end if;
        update public.prizes set stock = stock - 1 where id = pr.id;
        v_unit := 'held'; v_stock := 'taken';
      else
        v_unit := null;
      end if;
    end if;
  end if;
  perform set_config('fanfunnel.redemption_write', r.id::text, true);
  update public.redemptions set
    status = coalesce(v_status, status),
    fulfilled_at = case when v_status is null then fulfilled_at when v_status = 'fulfilled' then now() else null end,
    notes = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    due_at = case when p_patch ? 'due_at' then v_due else due_at end,
    stock_unit = v_unit
   where id = r.id;
  perform set_config('fanfunnel.redemption_write', '', true);
  return jsonb_build_object('status', 'ok', 'stock', v_stock);
end $$;
revoke execute on function public.set_redemption_state(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_redemption_state(uuid, uuid, jsonb) to authenticated;
comment on function public.set_redemption_state(uuid, uuid, jsonb) is 'Patch a won prize (status, notes, due_at) and move its stock unit exactly once on cancel/reopen (0067). Checks can_act_for(creator, fulfil) or is_admin() on the caller.';

create or replace function public.archive_wheel(p_wheel uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_creator uuid;
begin
 select creator_id into v_creator from public.wheels where id=p_wheel;
 if v_creator is null or not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 perform public._lock_wheel_lifecycle(p_wheel);
  -- 0073 (CC-03): the caller's authority is evaluated again once every lock is
  -- held, so a seat removed while this call waited cannot complete the write.
  if not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 update public.wheels set archived_at=coalesce(archived_at,now()),is_active=false where id=p_wheel;
 return 'ok';
end $$;
revoke execute on function public.archive_wheel(uuid) from public,anon;
grant execute on function public.archive_wheel(uuid) to authenticated,service_role;

create or replace function public.delete_wheel(p_wheel uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_creator uuid;
begin
 select creator_id into v_creator from public.wheels where id=p_wheel;
 if v_creator is null or not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 perform public._lock_wheel_lifecycle(p_wheel);
  -- 0073 (CC-03): the caller's authority is evaluated again once every lock is
  -- held, so a seat removed while this call waited cannot complete the write.
  if not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 -- A game with play history is archived, never deleted (spins and
 -- redemptions are revenue and analytics records), and so is a game any fan
 -- link is stored on: fan_passes.wheel_id cascades, so the delete would erase
 -- the link and its balance even when the link now plays another game. Under
 -- the wheel lock no new link can reference it (its foreign-key check waits).
 if exists(select 1 from public.spins where wheel_id=p_wheel)
   or exists(select 1 from public.fan_passes where wheel_id=p_wheel) then return 'has_history'; end if;
 delete from public.wheels where id=p_wheel;
 return 'ok';
end $$;
revoke execute on function public.delete_wheel(uuid) from public,anon;
grant execute on function public.delete_wheel(uuid) to authenticated,service_role;

create or replace function public.delete_campaign(p_campaign uuid, p_creator uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
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
  -- 0073 (CC-03): the caller's authority is evaluated again once every lock is
  -- held, so a seat removed while this call waited cannot complete the write.
  if not (public.can_act_for(p_creator, 'manage') or public.is_admin()) then return 'not_found'; end if;
  delete from public.campaigns where id = p_campaign and creator_id = p_creator;
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.delete_campaign(uuid, uuid) from public, anon;
grant execute on function public.delete_campaign(uuid, uuid) to authenticated, service_role;
comment on function public.delete_campaign(uuid, uuid) is 'Deletes a campaign (owner, manage seat or admin), locking its fans and links before it (0071). DELETE on campaigns is revoked from sessions.';

-- ── PR-13: a link can expire ───────────────────────────────────────────────
-- fan_passes.expires_at (null = never). An expired link answers like a paused
-- one on every spin path below; the creator sets it at mint time (app side).
alter table public.fan_passes add column if not exists expires_at timestamptz;

-- ── RS-01, CC-02: get_spin_attempt_status answers not_found / declined ──────
create or replace function public.get_spin_attempt_status(p_attempt uuid,p_token text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a public.spin_attempts%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt;
 if not found then
   -- 0073 (RS-01): no attempt and no link behind the token at all: not_found,
   -- so the route answers 404 and the fan-miss budget counts the call. A
   -- link that exists but is paused, expired, blocked or suspended stays
   -- unavailable (a real fan with a saved spin, not a probe).
   if not exists(select 1 from public.fan_passes p where p.token=p_token) then
     return jsonb_build_object('status','not_found');
   end if;
   if not exists(select 1 from public.fan_passes p join public.fans f on f.id=p.fan_id join public.profiles c on c.id=p.creator_id
     where p.token=p_token and p.is_active and p.self_excluded_at is null and (p.expires_at is null or p.expires_at>now()) and f.blocked_at is null and f.creator_id=p.creator_id and c.is_active) then
     return jsonb_build_object('status','unavailable');
   end if;
   return jsonb_build_object('status','absent');
 end if;
 if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
 -- 0073 (CC-02): a declined attempt is answered as declined whatever the
 -- link's state now (it reveals nothing but its own refusal reason).
 if a.state='declined' then return jsonb_build_object('status','declined','error',a.error); end if;
 if not exists(select 1 from public.fan_passes p join public.fans f on f.id=p.fan_id join public.profiles c on c.id=p.creator_id
   where p.id=a.fan_pass_id and p.token=p_token and p.fan_id=a.fan_id and p.is_active and p.self_excluded_at is null and (p.expires_at is null or p.expires_at>now()) and f.blocked_at is null and f.creator_id=p.creator_id and c.is_active) then
   return jsonb_build_object('status','unavailable');
 end if;
 if a.state='committed' then return public._spin_attempt_receipt(p_attempt,true); end if;
 if a.state='declined' then return jsonb_build_object('status','declined','error',a.error); end if;
 return jsonb_build_object('status','pending');
end $$;
revoke execute on function public.get_spin_attempt_status(uuid,text,text) from public,anon,authenticated;
grant execute on function public.get_spin_attempt_status(uuid,text,text) to service_role;

-- ── CC-02, PR-13: prepare / commit / cancel finish a refused attempt ────────
create or replace function public.prepare_spin_attempt(p_attempt uuid,p_token text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; a public.spin_attempts%rowtype; c jsonb; fresh boolean:=false; v_wheel uuid;
begin
 if p_attempt is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid attempt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt;
 if found then
   if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 end if;
 select * into p from public.fan_passes where token=p_token;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 -- 0071 (F6): the creator's profile (key share, which the spin_attempts
 -- insert below takes anyway) before the fan, so an account closure that
 -- holds the profile waits here instead of waiting for this fan.
 perform 1 from public.profiles where id=p.creator_id for key share;
 select * into f from public.fans where id=p.fan_id and creator_id=p.creator_id for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 select * into p from public.fan_passes where id=p.id for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 if not p.is_active or (p.expires_at is not null and p.expires_at<=now()) or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then
   -- 0073 (CC-02): the link, fan or creator stopped being playable: the
   -- attempt is finished as declined/blocked instead of staying pending for
   -- good (the fan sees "this link isn't active", not "still being checked").
   if a.id is not null then
     update public.spin_attempts set state='declined',error='blocked',finished_at=now() where id=p_attempt and state='pending';
     return jsonb_build_object('status','declined','error','blocked');
   end if;
   return jsonb_build_object('status','unavailable');
 end if;
 if a.id is null then
   insert into public.spin_attempts(id,creator_id,fan_id,fan_pass_id,token_hash,request_hash)
   values(p_attempt,p.creator_id,p.fan_id,p.id,encode(digest(p_token,'sha256'),'hex'),p_request_hash);
 end if;
 if f.break_until>now() or f.acked_at is null or f.acked_terms_version is distinct from public.legal_terms_version() or p.spins_remaining<=0 then
   update public.spin_attempts set state='declined',error=case when f.break_until>now() then 'on_break' when f.acked_at is null or f.acked_terms_version is distinct from public.legal_terms_version() then 'needs_ack' else 'no_spins' end,finished_at=now() where id=p_attempt;
   return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash);
 end if;
 v_wheel:=public._resolved_spin_wheel(p.id);
 if v_wheel is null then
   update public.spin_attempts set state='declined',error='no_wheel',finished_at=now() where id=p_attempt;
   return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash);
 end if;
 perform set_config('fanfunnel.economic_write','on',true);
 if p.next_server_seed is null or p.next_server_seed_hash is null then
   p.next_server_seed:=encode(gen_random_bytes(32),'hex');
   update public.fan_passes set next_server_seed=p.next_server_seed,next_server_seed_hash=encode(digest(p.next_server_seed,'sha256'),'hex') where id=p.id;
   fresh:=true;
 end if;
 perform 1 from public.fan_focus where fan_id=p.fan_id and status in('active','paused') for update;
 c:=public._spin_attempt_context(p.id,v_wheel);
 c:=c||jsonb_build_object('commitment',case when fresh or (a.context->>'serverSeed'=c->>'serverSeed' and a.context->>'commitment'='fresh') then 'fresh' else 'stored' end);
 update public.spin_attempts set context=c where id=p_attempt;
 return jsonb_build_object('status','ready','context',c,'balance',p.spins_remaining);
end $$;
revoke execute on function public.prepare_spin_attempt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.prepare_spin_attempt(uuid,text,text) to service_role;

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
 if p.id is null or f.id is null or f.creator_id is distinct from p.creator_id or p.fan_id<>f.id or not p.is_active or (p.expires_at is not null and p.expires_at<=now()) or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=a.creator_id and is_active and (approval_status='approved' or role='admin')) then
   -- 0073 (CC-02): the link, fan or creator stopped being playable: the
   -- attempt is finished as declined/blocked instead of staying pending for
   -- good (the fan sees "this link isn't active", not "still being checked").
   if a.id is not null then
     update public.spin_attempts set state='declined',error='blocked',finished_at=now() where id=p_attempt and state='pending';
     return jsonb_build_object('status','declined','error','blocked');
   end if;
   return jsonb_build_object('status','unavailable');
 end if;
 -- The game is resolved exactly once per call, under the fan and pass locks
 -- (0070): every lock and the context below use v_wheel, so a campaign pin,
 -- flag, schedule or archive change mid-call can no longer split the wheel
 -- lock and the prize lock across two games (40P01); a change is caught by
 -- the context hash (retry_context) as before.
 v_wheel:=public._resolved_spin_wheel(p.id);
 if f.break_until>now() then v_error:='on_break';
 elsif f.acked_at is null or f.acked_terms_version is distinct from public.legal_terms_version() then v_error:='needs_ack';
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
 if not p.is_active or p.self_excluded_at is not null or (p.expires_at is not null and p.expires_at<=now()) or not exists(select 1 from public.fans where id=p.fan_id and blocked_at is null)
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then
   -- 0073 (CC-02): the link, fan or creator stopped being playable: the
   -- attempt is finished as declined/blocked instead of staying pending for
   -- good (the fan sees "this link isn't active", not "still being checked").
   if a.id is not null then
     update public.spin_attempts set state='declined',error='blocked',finished_at=now() where id=p_attempt and state='pending';
     return jsonb_build_object('status','declined','error','blocked');
   end if;
   return jsonb_build_object('status','unavailable');
 end if;
 insert into public.spin_attempts(id,creator_id,fan_id,fan_pass_id,token_hash,request_hash,state,error,finished_at)
 values(p_attempt,p.creator_id,p.fan_id,p.id,encode(digest(p_token,'sha256'),'hex'),p_request_hash,'declined',p_error,now())
 on conflict(id) do update set state='declined',error=p_error,finished_at=now() where public.spin_attempts.state='pending';
 return jsonb_build_object('status','declined','error',p_error);
end $$;
revoke execute on function public.cancel_spin_attempt(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.cancel_spin_attempt(uuid,text,text,text) to service_role;

-- ── (5) WG-02: the agency owner's seat, created with the org and backfilled ──
create or replace function public.org_create(p_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.current_user_active() then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  -- 0071: one agency per owner (orgs_owner_id_key); a concurrent second call
  -- answers the same org instead of a unique violation.
  insert into public.orgs (name, owner_id)
    values (coalesce(nullif(left(trim(p_name), 120), ''), 'My agency'), auth.uid())
    on conflict (owner_id) do nothing
    returning id into v_id;
  if v_id is null then select id into v_id from public.orgs where owner_id = auth.uid(); end if;
  -- 0073 (WG-02): the owner holds the owner seat of its own agency from the
  -- start (every scope through can_act_for), so it can open its creators'
  -- inboxes, fulfil their prizes and run their campaigns without "adding
  -- itself as staff".
  insert into public.org_members (org_id, profile_id, role) values (v_id, auth.uid(), 'owner')
    on conflict (org_id, profile_id) do nothing;
  return v_id;
end;
$$;
revoke execute on function public.org_create(text) from public, anon;
grant execute on function public.org_create(text) to authenticated, service_role;
-- Backfill: every existing agency's owner gets its owner seat.
insert into public.org_members (org_id, profile_id, role)
select o.id, o.owner_id, 'owner' from public.orgs o
on conflict (org_id, profile_id) do nothing;

create or replace function public.org_remove_member(p_member uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public._owns_org_seat(p_member) then
    return 'not_owner';
  end if;
  -- 0073 (WG-02): the owner's own seat is the agency itself; it is not removed.
  if exists (select 1 from public.org_members m join public.orgs o on o.id = m.org_id where m.id = p_member and m.profile_id = o.owner_id) then
    return 'owner_seat';
  end if;
  delete from public.org_members where id = p_member;
  return 'ok';
end;
$$;
revoke execute on function public.org_remove_member(uuid) from public, anon;
grant execute on function public.org_remove_member(uuid) to authenticated;

create or replace function public.org_leave(p_org uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_seats integer := 0; v_creator integer := 0;
begin
  if auth.uid() is null or p_org is null or not public._session_mfa_satisfied() then return 'not_member'; end if;
  -- 0073 (WG-02): an owner does not leave its own agency (its seat stays).
  if exists (select 1 from public.orgs o where o.id = p_org and o.owner_id = auth.uid()) then return 'owner_seat'; end if;
  delete from public.org_members where org_id = p_org and profile_id = auth.uid();
  get diagnostics v_seats = row_count;
  update public.profiles set org_id = null where id = auth.uid() and org_id = p_org;
  get diagnostics v_creator = row_count;
  return case when v_seats + v_creator > 0 then 'ok' else 'not_member' end;
end $$;
revoke execute on function public.org_leave(uuid) from public, anon;
grant execute on function public.org_leave(uuid) to authenticated, service_role;
comment on function public.org_leave(uuid) is 'The caller leaves an agency: its own seat and, as a member creator, the org (0071).';

-- ── ATK-06: org_invite_creator (0068/0071 text, unchanged) answers only
-- ok / not_owner / invalid_email / rate_limited: the throttle runs before any
-- account lookup and an unknown address is 'ok' (no mail, no row that says
-- "no such user"); 0073 adds the probe that keeps it so.

-- ── WG-07: who replied, who fulfilled (actor attribution) ────────────────
-- messages.actor_id is the signed-in account that inserted a creator message
-- (a seat's reply reads "via <name>" in the creator's Inbox); redemptions
-- .actor_id is the account that last changed the status. Both are stamped
-- from the session (never from the request) and null for service writes.
alter table public.messages add column if not exists actor_id uuid references public.profiles(id) on delete set null;
create index if not exists messages_actor_id_idx on public.messages(actor_id);
alter table public.redemptions add column if not exists actor_id uuid references public.profiles(id) on delete set null;
create index if not exists redemptions_actor_id_idx on public.redemptions(actor_id);
create or replace function public._stamp_actor_attribution()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'messages' then
    if tg_op = 'INSERT' then
      if auth.uid() is not null then new.actor_id := auth.uid(); end if;
    else
      new.actor_id := old.actor_id;
    end if;
  elsif tg_table_name = 'redemptions' then
    if tg_op = 'INSERT' then
      if auth.uid() is not null then new.actor_id := auth.uid(); end if;
    elsif new.status is distinct from old.status or new.fulfilled_at is distinct from old.fulfilled_at then
      new.actor_id := coalesce(auth.uid(), old.actor_id);
    else
      new.actor_id := old.actor_id;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._stamp_actor_attribution() from public, anon, authenticated, service_role;
drop trigger if exists ab_actor_attribution on public.messages;
create trigger ab_actor_attribution before insert or update on public.messages
  for each row execute function public._stamp_actor_attribution();
drop trigger if exists ab_actor_attribution on public.redemptions;
create trigger ab_actor_attribution before insert or update on public.redemptions
  for each row execute function public._stamp_actor_attribution();

-- ── (6) TS-01: the accepted Terms version is 2026-11-11 (LEGAL.version) ───
create or replace function public.legal_terms_version()
returns text language sql stable security invoker set search_path = public, pg_temp as $$ select '2026-11-11'::text $$;
revoke execute on function public.legal_terms_version() from public;
grant execute on function public.legal_terms_version() to anon, authenticated, service_role;
comment on function public.legal_terms_version() is 'The Terms/Privacy version a fan must have accepted to play (0072; 0073 bumped it to 2026-11-11). Equal to LEGAL.version in src/lib/legal.ts; bump both together.';

-- ── TS-06: the terms-change notice (30 days before a material change) ──────
-- One settings row an admin (aal2) fills with the upcoming version and its
-- effective date; the spin page and the dashboard read legal_terms_upcoming()
-- and the app mails creators (app side). Clearing it takes a null version.
create table if not exists public.legal_terms_notice (
  singleton boolean primary key default true check (singleton),
  upcoming_version text check (upcoming_version ~ '^\d{4}-\d{2}-\d{2}$'),
  effective_at date,
  announced_at timestamptz,
  announced_by uuid references public.profiles(id) on delete set null,
  check ((upcoming_version is null) = (effective_at is null))
);
create index if not exists legal_terms_notice_announced_by_idx on public.legal_terms_notice(announced_by);
alter table public.legal_terms_notice enable row level security;
revoke all on public.legal_terms_notice from public, anon, authenticated;
grant select on public.legal_terms_notice to authenticated, service_role;
-- The notice RPCs run as the caller (SECURITY INVOKER): reads through the
-- policy below, the admin's write through the is_admin() update policy.
grant update on public.legal_terms_notice to authenticated;
drop policy if exists legal_terms_notice_admin_write on public.legal_terms_notice;
create policy legal_terms_notice_admin_write on public.legal_terms_notice for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists legal_terms_notice_read on public.legal_terms_notice;
create policy legal_terms_notice_read on public.legal_terms_notice for select
  using (public.current_user_active() or public.is_admin());
insert into public.legal_terms_notice (singleton) values (true) on conflict (singleton) do nothing;
create or replace function public.legal_terms_upcoming()
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select case when n.upcoming_version is null then null
              else jsonb_build_object('version', n.upcoming_version, 'effectiveAt', n.effective_at, 'announcedAt', n.announced_at) end
    from public.legal_terms_notice n where n.singleton
$$;
revoke execute on function public.legal_terms_upcoming() from public, anon;
grant execute on function public.legal_terms_upcoming() to authenticated, service_role;
comment on function public.legal_terms_upcoming() is 'The announced upcoming Terms/Privacy version and its effective date, or null (0073, TS-06).';
create or replace function public.set_legal_terms_notice(p_version text, p_effective_at date)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'admin required' using errcode = '42501'; end if;
  if (p_version is null) <> (p_effective_at is null) or (p_version is not null and (p_version !~ '^\d{4}-\d{2}-\d{2}$' or p_effective_at < current_date)) then
    raise exception 'invalid terms notice' using errcode = '22023';
  end if;
  update public.legal_terms_notice
     set upcoming_version = p_version, effective_at = p_effective_at,
         announced_at = case when p_version is null then null else now() end,
         -- the caller's id read as Supabase's auth.uid() does (this function runs as the caller, who has no USAGE on schema auth locally)
         announced_by = case when p_version is null then null else coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid end
   where singleton;
  return public.legal_terms_upcoming();
end $$;
revoke execute on function public.set_legal_terms_notice(text, date) from public, anon;
grant execute on function public.set_legal_terms_notice(text, date) to authenticated, service_role;

-- ── TS-05: consent evidence with the fan's acknowledgement ─────────────────
-- record_fan_ack stamps the acknowledgement from the server (version from
-- legal_terms_version(), never the request) and keeps salted hashes of the
-- IP and user agent the gate was answered from, in a table no creator or
-- seat can read (admins, aal2, for a dispute). Both arguments are optional.
create table if not exists public.fan_consent_evidence (
  fan_id uuid primary key references public.fans(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  terms_version text not null,
  acked_at timestamptz not null default now(),
  ip_hash text check (ip_hash ~ '^[a-f0-9]{64}$'),
  ua_hash text check (ua_hash ~ '^[a-f0-9]{64}$'),
  ack_count integer not null default 1 check (ack_count >= 1)
);
create index if not exists fan_consent_evidence_creator_id_idx on public.fan_consent_evidence(creator_id);
alter table public.fan_consent_evidence enable row level security;
revoke all on public.fan_consent_evidence from public, anon, authenticated;
grant select on public.fan_consent_evidence to authenticated, service_role;
drop policy if exists fan_consent_evidence_admin on public.fan_consent_evidence;
create policy fan_consent_evidence_admin on public.fan_consent_evidence for select
  using (public.is_admin());
drop trigger if exists zz_creator_immutable on public.fan_consent_evidence;
create trigger zz_creator_immutable before update of creator_id on public.fan_consent_evidence
  for each row execute function public._guard_creator_immutable();
create or replace function public.record_fan_ack(p_token text, p_ip_hash text default null, p_ua_hash text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.fan_passes%rowtype; v_version text := public.legal_terms_version();
begin
  if p_token is null or (p_ip_hash is not null and p_ip_hash !~ '^[a-f0-9]{64}$') or (p_ua_hash is not null and p_ua_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'invalid acknowledgement' using errcode = '22023';
  end if;
  select * into p from public.fan_passes where token = p_token;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform 1 from public.fans where id = p.fan_id and creator_id = p.creator_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  update public.fans set acked_at = now(), acked_terms_version = v_version where id = p.fan_id;
  insert into public.fan_consent_evidence (fan_id, creator_id, terms_version, acked_at, ip_hash, ua_hash)
  values (p.fan_id, p.creator_id, v_version, now(), p_ip_hash, p_ua_hash)
  on conflict (fan_id) do update set terms_version = excluded.terms_version, acked_at = excluded.acked_at,
    ip_hash = excluded.ip_hash, ua_hash = excluded.ua_hash, ack_count = public.fan_consent_evidence.ack_count + 1;
  return jsonb_build_object('status', 'ok', 'version', v_version);
end $$;
revoke execute on function public.record_fan_ack(text, text, text) from public, anon, authenticated;
grant execute on function public.record_fan_ack(text, text, text) to service_role;
comment on function public.record_fan_ack(text, text, text) is 'Stamps the age/terms acknowledgement on the fan behind a link with the current legal_terms_version() and optional consent evidence hashes (0073, TS-05). Service role only.';

-- ── (7) DB-10: the fulfilment queue names the fan (null once deleted) ──────
-- A changed row type needs a new signature so the snapshots stay replayable:
-- the queue gains p_fan (the one fan's open prizes) as its last argument.
drop function if exists public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid);
create or replace function public.creator_redemption_queue(
  p_status text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50,
  p_creator uuid default null,
  p_fan uuid default null
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
  fan_id uuid,
  pool_snapshot jsonb,
  fair_trace jsonb,
  reward_kind text,
  reward_views integer,
  reward_last_viewed_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
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
         f.id as fan_id,
         s.pool_snapshot, s.fair_trace,
         sr.kind, sr.views, sr.last_viewed_at
    from public.redemptions r
    join target t on r.creator_id = t.id
    join public.spins s on s.id = r.spin_id and s.creator_id = r.creator_id
    left join public.fans f on f.id = s.fan_id and f.creator_id = r.creator_id
    left join public.spin_rewards sr on sr.spin_id = s.id
    cross join pattern
   where (p_status is null or r.status::text = p_status)
     and (p_fan is null or s.fan_id = p_fan)
     and (pattern.p is null
          or s.prize_label ilike pattern.p
          or f.display_name ilike pattern.p
          or f.handle ilike pattern.p)
     and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid) from public, anon;
grant execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid) to authenticated, service_role;

-- ── DB-11, DB-12: save_game_wheel takes the game version and a draft flag ──
drop function if exists public.save_game_wheel(uuid, uuid, uuid, jsonb, jsonb, uuid);
create or replace function public.save_game_wheel(p_context uuid,p_wheel uuid,p_creator uuid,p_prizes jsonb,p_config jsonb,p_actor uuid,p_ready boolean default true,p_expected_updated_at timestamptz default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.wheels%rowtype; error_code text;
begin
 if not public._creator_actor_context_valid(p_context,p_actor,p_creator,'edit_wheel') then raise exception 'forbidden' using errcode='42501'; end if;
 -- 0071 (F3): fans before the game, as save_wheel_prizes below takes them.
 if not public._lock_wheel_focus_fans(p_wheel,p_creator) then raise exception 'game_not_found' using errcode='P0002'; end if;
 select * into w from public.wheels where id=p_wheel and creator_id=p_creator for update;
 if not found then raise exception 'game_not_found' using errcode='P0002'; end if;
 if not public._game_actor_edit_allowed(p_actor,p_creator,p_context) then raise exception 'forbidden' using errcode='42501'; end if;
 -- 0073 (DB-11): the editor's game version, compared under the wheel lock.
 if p_expected_updated_at is not null and date_trunc('milliseconds',w.updated_at) is distinct from date_trunc('milliseconds',p_expected_updated_at) then raise exception 'game_changed' using errcode='22023'; end if;
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
 -- 0073 (DB-12): a draft (p_ready=false) is stored unready and inactive, no
 -- readiness check; publishing (p_ready=true) validates as before.
 if coalesce(p_ready,true) then
  error_code:=public._bingo_ready_error(w.id);if error_code is not null then raise exception '%',error_code using errcode='22023'; end if;
  update public.wheels set game_ready=true where id=w.id;
 else
  update public.wheels set game_ready=false,is_active=false,active_from=null,active_until=null where id=w.id;
 end if;
 -- 0073 (DB-11): the game version advances when this save changed the game.
 if (select to_jsonb(w2)-'updated_at' from public.wheels w2 where w2.id=w.id) is distinct from (to_jsonb(w)-'updated_at') then update public.wheels set updated_at=now() where id=w.id; end if;
 perform set_config('fanfunnel.game_configuration','',true);
end $$;
revoke execute on function public.save_game_wheel(uuid, uuid, uuid, jsonb, jsonb, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.save_game_wheel(uuid, uuid, uuid, jsonb, jsonb, uuid, boolean, timestamptz) to service_role;

-- ── DB-13: what a creator owes its fans, exactly, over every row ───────────
create or replace function public.creator_obligations(p_creator uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_creator uuid := coalesce(p_creator, auth.uid());
begin
  if v_creator is null then return null; end if;
  if auth.uid() is not null and not (public.can_act_for(v_creator, 'view') or public.is_admin()) then return null; end if;
  return jsonb_build_object(
    'openPrizes', (select count(*) from public.redemptions r where r.creator_id = v_creator and r.status in ('pending', 'in_progress')),
    'fansOwed', (select count(distinct s.fan_id) from public.redemptions r join public.spins s on s.id = r.spin_id
                  where r.creator_id = v_creator and r.status in ('pending', 'in_progress') and s.fan_id is not null),
    'unplayedPaidSpins', (select coalesce(sum(p.spins_remaining), 0) from public.fan_passes p
                           where p.creator_id = v_creator and p.is_active and p.self_excluded_at is null
                             and exists (select 1 from public.grants g where g.fan_id = p.fan_id and g.creator_id = v_creator and g.amount_cents > 0)),
    'unplayedSpins', (select coalesce(sum(p.spins_remaining), 0) from public.fan_passes p where p.creator_id = v_creator and p.is_active and p.self_excluded_at is null),
    'fansWithCredit', (select count(*) from public.fans f where f.creator_id = v_creator and f.spins_remaining > 0),
    'liveFocus', (select count(*) from public.fan_focus ff where ff.creator_id = v_creator and ff.status in ('active', 'paused')),
    'heldChase', (select count(*) from public.chase_reservations c where c.creator_id = v_creator and c.state = 'held'),
    'activeLinks', (select count(*) from public.fan_passes p where p.creator_id = v_creator and p.is_active and p.self_excluded_at is null));
end $$;
revoke execute on function public.creator_obligations(uuid) from public, anon, authenticated;
grant execute on function public.creator_obligations(uuid) to service_role;
comment on function public.creator_obligations(uuid) is 'Open prizes, fans owed, unplayed (paid) spins and live promises of a creator, over every row (0073, DB-13). Caller needs can_act_for(creator, view). Service role only: the server route checks can_act_for on the session and passes p_creator (a replayed 0072 closing check admits no new signed-in SECURITY DEFINER function).';

-- ── DB-17: my_seat_creators says whether the seat may run campaigns too ───
-- (new signature, p_limit, so the historic definitions still replay).
drop function if exists public.my_seat_creators();
create or replace function public.my_seat_creators(p_limit integer default 200)
returns table (creator_id uuid, display_name text, can_chat boolean, can_fulfil boolean, can_manage boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.display_name, c.can_chat, c.can_fulfil, c.can_manage
    from (
      -- 0071 (M1): a chat/fulfil seat is not entitled to the creator's e-mail.
      select distinct p.id, coalesce(public._safe_display_name(p.display_name, p.email), 'Creator') as display_name,
             public.can_act_for(p.id, 'chat') as can_chat,
             public.can_act_for(p.id, 'fulfil') as can_fulfil,
             public.can_act_for(p.id, 'manage') as can_manage
        from public.org_members m
        join public.profiles p on p.org_id = m.org_id
       where m.profile_id = auth.uid() and p.id <> auth.uid()
    ) c
   where c.can_chat or c.can_fulfil
   order by c.display_name, c.id
   limit least(greatest(coalesce(p_limit, 200), 1), 200);
$$;
revoke execute on function public.my_seat_creators(integer) from public, anon;
grant execute on function public.my_seat_creators(integer) to authenticated, service_role;

-- ── PA-03: the fans list and the analytics are summarised in SQL ──────────
-- listFans read every fan, link, spin and grant of the creator into Node and
-- refused at 50 000 rows; the analytics did the same per report. These two
-- functions page and aggregate in the database (the app keeps the 50k guard
-- for exports only). Composite indexes serve the per-creator cursors.
create index if not exists spins_creator_id_id_idx on public.spins(creator_id, id);
create index if not exists grants_creator_id_id_idx on public.grants(creator_id, id);
create index if not exists fan_passes_creator_id_id_idx on public.fan_passes(creator_id, id);
create index if not exists fans_creator_created_idx on public.fans(creator_id, created_at desc, id desc);
create index if not exists spins_creator_created_idx on public.spins(creator_id, created_at desc);
create index if not exists grants_creator_created_idx on public.grants(creator_id, created_at desc);
drop function if exists public.creator_fan_summaries(uuid, text, timestamptz, uuid, integer);
create or replace function public.creator_fan_summaries(
  p_creator uuid default null,
  p_query text default null,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  fan_id uuid,
  display_name text,
  handle text,
  spins_remaining integer,
  spins_granted_total integer,
  tags text[],
  created_at timestamptz,
  blocked_at timestamptz,
  break_until timestamptz,
  total_spent_cents bigint,
  grant_count bigint,
  campaign_names text[],
  last_win_label text,
  last_win_rarity public.prize_rarity,
  last_win_at timestamptz,
  wins bigint,
  links bigint,
  active_links bigint,
  self_excluded boolean,
  last_visit_day date,
  total_fans bigint
)
language sql stable security definer set search_path = public, pg_temp as $$
  with target as (
    select coalesce(p_creator, auth.uid()) as id
     where auth.uid() is null or public.can_act_for(coalesce(p_creator, auth.uid()), 'view') or public.is_admin()
  ), q as (
    select nullif(btrim(coalesce(p_query, '')), '') as raw
  ), pattern as (
    select case when raw is null then null
      else '%' || replace(replace(replace(left(raw, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' end as p
    from q
  ), matching as (
    select f.* from public.fans f join target t on f.creator_id = t.id cross join pattern
     where pattern.p is null or f.display_name ilike pattern.p or f.handle ilike pattern.p
        or exists (select 1 from unnest(f.tags) tg where tg ilike pattern.p)
  ), total as (
    select count(*) as n from matching
  ), page as (
    select * from matching
     where p_before_created is null or (created_at, id) < (p_before_created, p_before_id)
     order by created_at desc, id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
  )
  select f.id, f.display_name, f.handle, f.spins_remaining, f.spins_granted_total, f.tags, f.created_at, f.blocked_at, f.break_until,
         coalesce(g.total_cents, 0)::bigint, coalesce(g.n, 0)::bigint, coalesce(g.campaign_names, '{}'::text[]),
         w.prize_label, w.prize_rarity, w.created_at, coalesce(wc.n, 0)::bigint,
         coalesce(l.n, 0)::bigint, coalesce(l.active, 0)::bigint, coalesce(l.self_excluded, false), v.last_day, total.n
    from page f cross join total
    left join lateral (
      select sum(gr.amount_cents) as total_cents, count(*) as n,
             array_remove(array_agg(distinct c.name order by c.name), null) as campaign_names
        from public.grants gr left join public.campaigns c on c.id = gr.campaign_id
       where gr.fan_id = f.id and gr.creator_id = f.creator_id) g on true
    left join lateral (
      select s.prize_label, s.prize_rarity, s.created_at from public.spins s
       where s.fan_id = f.id and s.creator_id = f.creator_id order by s.created_at desc, s.id desc limit 1) w on true
    left join lateral (select count(*) as n from public.spins s where s.fan_id = f.id and s.creator_id = f.creator_id) wc on true
    left join lateral (
      select count(*) as n, count(*) filter (where p.is_active and p.self_excluded_at is null) as active,
             bool_or(p.self_excluded_at is not null) as self_excluded
        from public.fan_passes p where p.fan_id = f.id and p.creator_id = f.creator_id) l on true
    left join lateral (select max(ck.day) as last_day from public.fan_checkins ck where ck.fan_id = f.id and ck.creator_id = f.creator_id) v on true
   order by f.created_at desc, f.id desc;
$$;
revoke execute on function public.creator_fan_summaries(uuid, text, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.creator_fan_summaries(uuid, text, timestamptz, uuid, integer) to service_role;
comment on function public.creator_fan_summaries(uuid, text, timestamptz, uuid, integer) is 'One page of the creator''s fans (newest first, keyset cursor on created_at/id, optional name/handle/tag search) with per-fan totals computed in SQL (0073, PA-03). Caller needs can_act_for(creator, view). Service role only: the server route checks can_act_for on the session and passes p_creator (a replayed 0072 closing check admits no new signed-in SECURITY DEFINER function).';
create or replace function public.creator_analytics_summary(p_creator uuid default null, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_creator uuid := coalesce(p_creator, auth.uid());
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  if v_creator is null then return null; end if;
  if auth.uid() is not null and not (public.can_act_for(v_creator, 'view') or public.is_admin()) then return null; end if;
  return jsonb_build_object(
    'days', v_days,
    'since', v_since,
    'spinsByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', n) order by d), '[]'::jsonb)
                     from (select (s.created_at at time zone 'UTC')::date as d, count(*) as n from public.spins s
                            where s.creator_id = v_creator and s.kind = 'play' and s.created_at >= v_since group by 1) x),
    'revenueByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'cents', c) order by d), '[]'::jsonb)
                       from (select (g.created_at at time zone 'UTC')::date as d, sum(g.amount_cents) as c from public.grants g
                              where g.creator_id = v_creator and g.created_at >= v_since group by 1) x),
    'funnel', jsonb_build_object(
      'fans', (select count(*) from public.fans f where f.creator_id = v_creator),
      'spun', (select count(distinct s.fan_id) from public.spins s where s.creator_id = v_creator and s.kind = 'play' and s.fan_id is not null),
      'fulfilled', (select count(distinct s.fan_id) from public.redemptions r join public.spins s on s.id = r.spin_id
                     where r.creator_id = v_creator and r.status = 'fulfilled' and s.fan_id is not null)),
    'activeFans', jsonb_build_object(
      'thisWeek', (select count(distinct s.fan_id) from public.spins s where s.creator_id = v_creator and s.kind = 'play' and s.fan_id is not null and s.created_at >= now() - interval '7 days'),
      'lastWeek', (select count(distinct s.fan_id) from public.spins s where s.creator_id = v_creator and s.kind = 'play' and s.fan_id is not null
                    and s.created_at >= now() - interval '14 days' and s.created_at < now() - interval '7 days')),
    'heatmap', (select coalesce(jsonb_agg(jsonb_build_object('weekday', wd, 'hour', hr, 'count', n) order by wd, hr), '[]'::jsonb)
                  from (select extract(dow from s.created_at at time zone 'UTC')::integer as wd, extract(hour from s.created_at at time zone 'UTC')::integer as hr, count(*) as n
                          from public.spins s where s.creator_id = v_creator and s.kind = 'play' and s.created_at >= v_since group by 1, 2) h),
    'profit', (select jsonb_build_object(
                 'revenueCents', coalesce((select sum(g.amount_cents) from public.grants g where g.creator_id = v_creator and g.created_at >= v_since), 0),
                 'costCents', coalesce(sum(coalesce(r.cost_cents_at_award, p.cost_cents)), 0),
                 'snapshotted', count(r.cost_cents_at_award),
                 'estimated', count(*) filter (where r.cost_cents_at_award is null and p.cost_cents is not null),
                 'unknown', count(*) filter (where r.cost_cents_at_award is null and p.cost_cents is null))
                 from public.spins s left join public.redemptions r on r.spin_id = s.id left join public.prizes p on p.id = s.prize_id
                where s.creator_id = v_creator and s.created_at >= v_since),
    'prizeRoi', (select coalesce(jsonb_agg(jsonb_build_object('prizeId', prize_id, 'label', label, 'rarity', rarity, 'timesWon', n, 'costCents', cost, 'costsKnown', known) order by n desc, label), '[]'::jsonb)
                   from (select s.prize_id, coalesce(p.label, s.prize_label) as label, coalesce(p.rarity, s.prize_rarity) as rarity, count(*) as n,
                                sum(coalesce(r.cost_cents_at_award, p.cost_cents, 0)) as cost,
                                bool_and(coalesce(r.cost_cents_at_award, p.cost_cents) is not null) as known
                           from public.spins s left join public.redemptions r on r.spin_id = s.id left join public.prizes p on p.id = s.prize_id
                          where s.creator_id = v_creator and s.created_at >= v_since
                          group by s.prize_id, coalesce(p.label, s.prize_label), coalesce(p.rarity, s.prize_rarity)) x),
    'cohorts', (select coalesce(jsonb_agg(jsonb_build_object('campaignId', campaign_id, 'campaignName', name, 'fans', fans, 'returningFans', returning_fans) order by fans desc), '[]'::jsonb)
                  from (select fg.campaign_id, c.name, count(*) as fans,
                               count(*) filter (where (select count(*) from public.grants g2 where g2.fan_id = fg.fan_id and g2.creator_id = v_creator) > 1) as returning_fans
                          from (select distinct on (g.fan_id) g.fan_id, g.campaign_id from public.grants g
                                 where g.creator_id = v_creator and g.fan_id is not null order by g.fan_id, g.created_at, g.id) fg
                          left join public.campaigns c on c.id = fg.campaign_id
                         group by fg.campaign_id, c.name) y));
end $$;
revoke execute on function public.creator_analytics_summary(uuid, integer) from public, anon, authenticated;
grant execute on function public.creator_analytics_summary(uuid, integer) to service_role;
comment on function public.creator_analytics_summary(uuid, integer) is 'The dashboard analytics (daily spins and revenue, funnel, weekly-active fans, hour-of-week heatmap, profit, prize ROI, cohorts) aggregated in SQL for one creator and window (0073, PA-03). Caller needs can_act_for(creator, view). Service role only: the server route checks can_act_for on the session and passes p_creator (a replayed 0072 closing check admits no new signed-in SECURITY DEFINER function).';

-- ── (8) DB-15: every function pins search_path = public, pg_temp ────────────
-- Functions created above already do; the ~180 older SECURITY DEFINER
-- functions pinned 'public' only (not exploitable: API roles cannot CREATE
-- in public, cryptoNamespaceProbe proves it) and get pg_temp here. The 23
-- crypto functions (public, extensions, pg_temp) are left as they are.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proconfig = array['search_path=public'] loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;

-- ── DB-14: the legacy entry points kept only as revoked shells go ───────────
-- Each was revoked from every API role by an earlier migration and has no
-- caller in the app. Kept: finalize_reward_spin(jsonb,jsonb), reserve_reward_
-- code(uuid,uuid) and release_reward_code(uuid) (the drift probe exercises the
-- code-reservation semantics through them as postgres), _spin_attempt_context
-- (uuid) (the interplay probe's pre-0070 context reader) and the 13-argument
-- create_pass_grant (the crypto-namespace fixture's causal check). Also kept
-- because a live function still calls them: _creator_default_wheel(uuid,uuid)
-- (_create_pass_grant_core and the 3-argument wrapper), the 9-argument
-- edit_pass_grant (_edit_grant_patch_core), _creator_actor_grant_allowed
-- (uuid,uuid) (the revoked 9-argument grant_pass_spins / 13-argument
-- create_pass_grant) and _game_actor_edit_allowed(uuid,uuid) (the revoked
-- 5-argument save_game_wheel) and cancel_fan_focus(uuid,uuid,uuid) (the
-- implementation the 5-argument actor gateway delegates to); the actor-context
-- probe asserts the two helpers fail closed.
drop function if exists public.import_fans(jsonb);
drop function if exists public.credit_pass_spins(uuid, integer);
drop function if exists public.claim_spin(text);
drop function if exists public.rollback_claimed_spin(text, uuid);
drop function if exists public.cancel_fan_focus(uuid, uuid, uuid, uuid);
drop function if exists public.reconcile_creator_request(uuid, uuid, uuid, text, boolean, boolean);
drop function if exists public.edit_pass_grant(uuid, uuid, uuid, jsonb, uuid);
drop function if exists public.grant_focus_pack(uuid, uuid, uuid, uuid, uuid, uuid, uuid);
drop function if exists public.import_fans_durable(uuid, uuid, text, jsonb, uuid);

-- ── (8b) dashboard follow-ups: delivery promise, link expiry read, queue
-- actor, agency notices, seat-scope cleanup, owner state, empty-game delete,
-- one-statement "set active" ───────────────────────────────────────────────
-- Still no new signed-in SECURITY DEFINER name: the two changed signed-in
-- functions keep their names (creator_redemption_queue, delete_wheel) under a
-- new signature, set_active_wheel runs as the caller, and everything else is a
-- column, a grant, a policy or a trigger.

-- PR-10: the creator's delivery promise, 1..60 days (null = none). Read by the
-- creator on its own row (profiles_select; profiles is granted per table, so
-- the column needs no grant of its own), written only by the server: the
-- route checks can_act_for(self, 'manage') on the session, then updates this
-- one column with the service role (profiles_update stays admin-only, so no
-- creator session can write its own profile row).
alter table public.profiles add column if not exists delivery_days smallint check (delivery_days between 1 and 60);
comment on column public.profiles.delivery_days is 'The creator''s delivery promise in days, 1..60 (0073, PR-10). Null = no promise. Server-written only.';

-- A prize that waits for the creator gets its due date from that promise when
-- it is won. A plain read of the creator's profile: no row lock is taken, so
-- the play's lock order (fan → link → game → prize) is unchanged.
create or replace function public._default_redemption_due()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_days smallint;
begin
  if new.due_at is null and new.status = 'pending' and new.fulfilled_at is null then
    select p.delivery_days into v_days from public.profiles p where p.id = new.creator_id;
    if v_days is not null then
      new.due_at := coalesce(new.created_at, now()) + make_interval(days => v_days);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._default_redemption_due() from public, anon, authenticated, service_role;
drop trigger if exists ac_delivery_due on public.redemptions;
create trigger ac_delivery_due before insert on public.redemptions
  for each row execute function public._default_redemption_due();

-- PR-13: the creator reads when a link runs out (the token stays unreadable).
grant select (expires_at) on public.fan_passes to authenticated;

-- WG-07: the fulfilment queue says who last moved each prize (actor_id, the
-- last column) and can be narrowed to one account (p_actor, the last
-- argument). A changed row type needs a new signature; this replaces the
-- seven-argument queue defined in (7).
drop function if exists public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid);
create or replace function public.creator_redemption_queue(
  p_status text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50,
  p_creator uuid default null,
  p_fan uuid default null,
  p_actor uuid default null
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
  fan_id uuid,
  pool_snapshot jsonb,
  fair_trace jsonb,
  reward_kind text,
  reward_views integer,
  reward_last_viewed_at timestamptz,
  actor_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
         f.id as fan_id,
         s.pool_snapshot, s.fair_trace,
         sr.kind, sr.views, sr.last_viewed_at,
         r.actor_id
    from public.redemptions r
    join target t on r.creator_id = t.id
    join public.spins s on s.id = r.spin_id and s.creator_id = r.creator_id
    left join public.fans f on f.id = s.fan_id and f.creator_id = r.creator_id
    left join public.spin_rewards sr on sr.spin_id = s.id
    cross join pattern
   where (p_status is null or r.status::text = p_status)
     and (p_fan is null or s.fan_id = p_fan)
     and (p_actor is null or r.actor_id = p_actor)
     and (pattern.p is null
          or s.prize_label ilike pattern.p
          or f.display_name ilike pattern.p
          or f.handle ilike pattern.p)
     and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid, uuid) from public, anon;
grant execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid, uuid) to authenticated, service_role;
comment on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid, uuid, uuid) is 'One page of a creator''s won prizes, newest first, with the fan (fan_id, null once deleted) and the account that last moved each one (actor_id); optional status, search, one fan (p_fan) and one actor (p_actor) (0064; 0073). The caller''s own queue needs can_act_for(self, view), another creator''s needs can_act_for(creator, fulfil).';

-- WG-04 / WG-13 / PR-04: the bell also carries "your agency was dissolved",
-- "your agency's owner was suspended" and a creator's request to unlock a
-- game. Rows are still written by the server or by a trigger only
-- (authenticated holds SELECT alone). A replay of the older snapshot text
-- re-adds the two-kind check first, which validates only while no notice of a
-- newer kind is stored; replays are for empty or freshly built databases.
alter table public.creator_notices drop constraint if exists creator_notices_kind_check;
alter table public.creator_notices add constraint creator_notices_kind_check
  check (kind in ('fan_deleted_data', 'creator_approved', 'agency_dissolved', 'agency_owner_suspended', 'game_unlock_request'));

-- WG-13: whether the agency's owner can still act (active and approved; the
-- same test can_act_for applies before it lets any seat through). Stored on
-- the org so a seat and a managed creator can read it without reading the
-- owner's profile: the value is recomputed by trigger on every org write and
-- whenever the owner's account state changes, never taken from the request.
alter table public.orgs add column if not exists owner_active boolean not null default true;
comment on column public.orgs.owner_active is 'False while the owner''s account is suspended or unapproved, when every seat is frozen (0073, WG-13). Trigger-maintained.';

create or replace function public._org_owner_state()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_live boolean;
begin
  if tg_table_name = 'orgs' then
    new.owner_active := coalesce((select p.is_active and (p.approval_status = 'approved' or p.role = 'admin')
                                    from public.profiles p where p.id = new.owner_id), false);
    return new;
  end if;
  -- profiles: the owner's account state changed.
  v_live := new.is_active and (new.approval_status = 'approved' or new.role = 'admin');
  update public.orgs set owner_active = v_live where owner_id = new.id and owner_active is distinct from v_live;
  if old.is_active and not new.is_active then
    -- One notice for every seat and every managed creator of the agency this
    -- account owns (never the owner itself), in id order. Only creator_notices
    -- is written: no profile is updated, so this trigger cannot fire again.
    insert into public.creator_notices (creator_id, kind, details)
    select t.id, 'agency_owner_suspended', jsonb_build_object('org_name', left(o.name, 80))
      from public.orgs o
      cross join lateral (
        select p.id from public.profiles p where p.org_id = o.id
        union
        select m.profile_id from public.org_members m where m.org_id = o.id
      ) t
     where o.owner_id = new.id and t.id <> new.id
     order by t.id;
  end if;
  return null;
end $$;
revoke execute on function public._org_owner_state() from public, anon, authenticated, service_role;
drop trigger if exists aa_owner_active on public.orgs;
create trigger aa_owner_active before insert or update on public.orgs
  for each row execute function public._org_owner_state();
drop trigger if exists ae_org_owner_state on public.profiles;
create trigger ae_org_owner_state after update of is_active, approval_status, role on public.profiles
  for each row execute function public._org_owner_state();
update public.orgs o set owner_active = o.owner_active
 where o.owner_active is distinct from coalesce((select p.is_active and (p.approval_status = 'approved' or p.role = 'admin')
                                                    from public.profiles p where p.id = o.owner_id), false);

-- A managed creator, and a seat even while the owner is suspended, read their
-- own agency's row (name, owner_active). orgs_read still hides the row from a
-- seat once the owner is suspended; this policy only adds the two ties, each
-- through the caller's own rows: profiles_select shows a session its own
-- profile (org_id) and org_members_read its own seats (active accounts only).
drop policy if exists orgs_tie_read on public.orgs;
create policy orgs_tie_read on public.orgs for select to authenticated
  using (
    (select public.can_act_for((select auth.uid()), 'view'))
    and (
      id = (select p.org_id from public.profiles p where p.id = (select auth.uid()))
      or exists (select 1 from public.org_members m where m.org_id = orgs.id and m.profile_id = (select auth.uid()))
    )
  );

-- WG-14: a creator that leaves an agency (or is removed from it) takes its
-- seat scopes with it. Before, the org_member_creators rows stayed: they gave
-- nothing while the creator was outside the agency (can_act_for joins on
-- profiles.org_id), but a chatter or fulfiller got its old access back, with
-- no new grant by the owner, the moment the creator joined that agency again.
create or replace function public.org_remove_creator(p_org uuid, p_creator uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  update public.profiles set org_id = null where id = p_creator and org_id = p_org;
  delete from public.org_member_creators mc using public.org_members m
   where mc.member_id = m.id and m.org_id = p_org and mc.creator_id = p_creator;
  return 'ok';
end;
$$;
revoke execute on function public.org_remove_creator(uuid, uuid) from public, anon;
grant execute on function public.org_remove_creator(uuid, uuid) to authenticated;

create or replace function public.org_leave(p_org uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_seats integer := 0; v_creator integer := 0;
begin
  if auth.uid() is null or p_org is null or not public._session_mfa_satisfied() then return 'not_member'; end if;
  -- 0073 (WG-02): an owner does not leave its own agency (its seat stays).
  if exists (select 1 from public.orgs o where o.id = p_org and o.owner_id = auth.uid()) then return 'owner_seat'; end if;
  -- Leaving a seat removes its scopes with it (org_member_creators cascades).
  delete from public.org_members where org_id = p_org and profile_id = auth.uid();
  get diagnostics v_seats = row_count;
  update public.profiles set org_id = null where id = auth.uid() and org_id = p_org;
  get diagnostics v_creator = row_count;
  -- Leaving as a managed creator removes every seat's scope on this creator.
  delete from public.org_member_creators mc using public.org_members m
   where mc.member_id = m.id and m.org_id = p_org and mc.creator_id = auth.uid();
  return case when v_seats + v_creator > 0 then 'ok' else 'not_member' end;
end $$;
revoke execute on function public.org_leave(uuid) from public, anon;
grant execute on function public.org_leave(uuid) to authenticated, service_role;
comment on function public.org_leave(uuid) is 'The caller leaves an agency: its own seat and, as a member creator, the org and every seat scope on it (0071; 0073).';

-- The same rule for every other writer of profiles.org_id (a server update,
-- the SET NULL of a deleted org): scopes never outlive the membership.
create or replace function public._drop_stale_seat_scopes()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.org_id is distinct from old.org_id then
    delete from public.org_member_creators mc
     where mc.creator_id = new.id
       and not exists (select 1 from public.org_members m where m.id = mc.member_id and m.org_id = new.org_id);
  end if;
  return null;
end $$;
revoke execute on function public._drop_stale_seat_scopes() from public, anon, authenticated, service_role;
drop trigger if exists af_seat_scope_cleanup on public.profiles;
create trigger af_seat_scope_cleanup after update of org_id on public.profiles
  for each row execute function public._drop_stale_seat_scopes();
delete from public.org_member_creators mc
 where not exists (select 1 from public.org_members m join public.profiles p on p.org_id = m.org_id
                    where m.id = mc.member_id and p.id = mc.creator_id);

-- WC-09: removing an abandoned, still empty game is one atomic call. With
-- p_only_if_empty the delete is refused with 'not_empty' as soon as the game
-- holds a prize or any play, decided under the same locks as the delete. The
-- one-argument function defined above is replaced by this signature.
drop function if exists public.delete_wheel(uuid);
create or replace function public.delete_wheel(p_wheel uuid, p_only_if_empty boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_creator uuid;
begin
 select creator_id into v_creator from public.wheels where id=p_wheel;
 if v_creator is null or not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 perform public._lock_wheel_lifecycle(p_wheel);
  -- 0073 (CC-03): the caller's authority is evaluated again once every lock is
  -- held, so a seat removed while this call waited cannot complete the write.
  if not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 if coalesce(p_only_if_empty,false) and (exists(select 1 from public.prizes where wheel_id=p_wheel)
   or exists(select 1 from public.spins where wheel_id=p_wheel)
   or exists(select 1 from public.bingo_cards where wheel_id=p_wheel)) then return 'not_empty'; end if;
 -- A game with play history is archived, never deleted (spins and
 -- redemptions are revenue and analytics records), and so is a game any fan
 -- link is stored on: fan_passes.wheel_id cascades, so the delete would erase
 -- the link and its balance even when the link now plays another game. Under
 -- the wheel lock no new link can reference it (its foreign-key check waits).
 if exists(select 1 from public.spins where wheel_id=p_wheel)
   or exists(select 1 from public.fan_passes where wheel_id=p_wheel) then return 'has_history'; end if;
 delete from public.wheels where id=p_wheel;
 return 'ok';
end $$;
revoke execute on function public.delete_wheel(uuid, boolean) from public,anon;
grant execute on function public.delete_wheel(uuid, boolean) to authenticated,service_role;
comment on function public.delete_wheel(uuid, boolean) is 'Deletes a game that has no play history and no fan link stored on it (else has_history); with p_only_if_empty also refuses (not_empty) a game that holds a prize or any play (0065; 0073). Checks can_act_for(creator, edit_wheel) or is_admin() on the caller, again once the locks are held.';

-- CC-06: "Set active" is one statement. The dashboard used to flag the chosen
-- game and then clear the others in a second request, so two games were live
-- in between, and for good when the second request failed. This function runs
-- as the caller (wheels_select / wheels_write decide every row): it takes the
-- creator's games in id order, so two switches queue instead of crossing, and
-- flips them in a single UPDATE. A creator has one live game across all kinds,
-- which is what _creator_default_wheel resolves.
create or replace function public.set_active_wheel(p_wheel uuid)
returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_creator uuid; v_hit integer; v_ready boolean; v_archived timestamptz;
begin
  select w.creator_id into v_creator from public.wheels w where w.id = p_wheel;
  if v_creator is null then return 'not_found'; end if;
  -- FOR NO KEY UPDATE passes only rows the caller may also update: a caller
  -- that can see the game but not edit it (a chat seat, a suspended creator)
  -- locks nothing and is refused.
  select count(*) filter (where l.id = p_wheel) into v_hit
    from (select w.id from public.wheels w where w.creator_id = v_creator order by w.id for no key update) l;
  if v_hit = 0 then return 'forbidden'; end if;
  select w.game_ready, w.archived_at into v_ready, v_archived from public.wheels w where w.id = p_wheel;
  if v_archived is not null then return 'not_found'; end if;
  if not v_ready then return 'game_not_ready'; end if;
  update public.wheels w set is_active = (w.id = p_wheel)
   where w.creator_id = v_creator and w.is_active is distinct from (w.id = p_wheel);
  return 'ok';
end $$;
revoke execute on function public.set_active_wheel(uuid) from public, anon;
grant execute on function public.set_active_wheel(uuid) to authenticated, service_role;
comment on function public.set_active_wheel(uuid) is 'Makes one game the creator''s live game and clears the flag on its others in a single UPDATE (0073, CC-06). Runs as the caller under the wheels policies (can_act_for(creator, edit_wheel) or is_admin()). Answers ok, not_found (unknown or archived), forbidden (visible, not editable) or game_not_ready.';

-- ── (9) closing check: browser roles reach only the reviewed functions, and
-- every creator-owned table carries the immutability trigger ────────────────
do $$
declare v_bad text;
begin
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception '0073: anon can still execute SECURITY DEFINER functions: %', v_bad;
  end if;
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.proname not in (
       'is_admin', 'can_act_for', 'current_user_active', '_owns_org', '_owns_org_seat', '_is_org_member',
       '_my_confirmed_email', 'admin_account_stats', 'archive_wheel', 'creator_link_pass', 'creator_link_tokens',
       'creator_redemption_queue', 'delete_campaign', 'delete_wheel', 'issue_creator_actor_context',
       'my_seat_creators', 'org_account_stats', 'org_add_member', 'org_create', 'org_invite_creator',
       'org_invite_respond', 'org_invite_revoke', 'org_leave', 'org_remove_creator', 'org_remove_member',
       'org_scope_creator', 'set_chat_settings', 'set_creator_note', 'set_creator_theme', 'set_display_name',
       'set_leaderboard_enabled', 'set_notification_prefs', 'set_notifications_seen', 'set_onboarding_dismissed',
       'set_public_profile', 'set_pwa_icon_mode', 'set_redemption_state', 'wipe_my_spin_attempts');
       -- 0073 adds no signed-in SECURITY DEFINER function name: the 0072 list
       -- above must still hold when the snapshots are replayed over this schema.
  if v_bad is not null then
    raise exception '0073: authenticated can execute SECURITY DEFINER functions outside the reviewed list: %', v_bad;
  end if;
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'creator_id' and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zz_creator_immutable');
  if v_bad is not null then
    raise exception '0073: creator-owned tables without the immutability trigger: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proconfig = array['search_path=public'];
  if v_bad is not null then
    raise exception '0073: functions still pinning search_path=public only: %', v_bad;
  end if;
end $$;

-- ── the migration level this database was built to ─────────────────────────
create or replace function public.schema_version()
returns integer language sql immutable set search_path = public, pg_temp as $$ select 73 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0073). Every migration redefines it with its own number; the app flags a database behind its expected level.';
