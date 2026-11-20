-- 0072: advisor hardening (Supabase security and performance advisors on TEST,
-- 2026-11-09, schema at 0071). Additive and idempotent: privileges, two
-- search_path pins, 31 foreign-key indexes and 32 policy rewrites, plus two
-- trust & safety fixes (f, g). No table or column changes.
--
--  (a) Function privileges. Who calls each SECURITY DEFINER function that a
--      browser role could execute (src/ call sites; every app call goes
--      through a server module, no "use client" module calls .rpc):
--
--      function                         caller (client)                 anon  authenticated
--      ------------------------------   ------------------------------  ----  -------------
--      is_admin()                       RLS policies (93); session      no    yes
--                                       client (auth/adminCheck.ts,
--                                       data/rewards.ts)
--      can_act_for(uuid,text)           RLS policies (47); session      no    yes
--                                       client (seatScope, fans, focus,
--                                       spins, wheels, webhooks, rewards,
--                                       creator-requests, fans/import)
--      current_user_active()            RLS policies (35); session      no    yes
--                                       client (account/avatar,
--                                       creatorTheme)
--      _owns_org(uuid)                  RLS policies (4)                no    yes
--      _owns_org_seat(uuid)             RLS policies (2)                no    yes
--      _is_org_member(uuid)             RLS policy orgs_read            no    yes
--      _my_confirmed_email()            RLS policy                      no    yes
--                                       org_invites_invitee_read
--      admin_account_stats, archive_wheel, creator_link_pass,
--      creator_link_tokens, creator_redemption_queue, delete_campaign,
--      delete_wheel, issue_creator_actor_context, my_seat_creators,
--      org_account_stats, org_add_member, org_create, org_invite_creator,
--      org_invite_respond, org_invite_revoke, org_leave, org_remove_creator,
--      org_remove_member, org_scope_creator, set_chat_settings,
--      set_creator_note, set_creator_theme, set_display_name,
--      set_leaderboard_enabled, set_notification_prefs,
--      set_notifications_seen, set_onboarding_dismissed, set_public_profile,
--      set_pwa_icon_mode, set_redemption_state, wipe_my_spin_attempts
--                                       the signed-in creator's own     no    yes
--                                       session client (createClient);
--                                       each checks auth.uid() itself
--                                       or through the helpers above
--      admin_reserve_account_deletion   nobody since the admin delete   no    no
--                                       moved to the service gateway    (service_role kept)
--                                       (api/admin/account/delete)
--      org_add_creator(uuid,text)       nobody (consent bypass, 0030;   no    no
--                                       TEST still granted it to anon   (service_role kept)
--                                       and authenticated: drift)
--      attach_spin_reward, erase_fan_reward_values,
--      guard_delivered_redemption, handle_new_user, sync_code_prize_stock,
--      sync_fan_spin_aggregate, guard_fan_break, admin_audit_log_immutable
--                                       triggers only (a trigger fires  no    no
--                                       without an EXECUTE check)
--
--      The RLS helpers were kept anon-callable (0044) so an anon read that
--      evaluated a policy would return no rows instead of an error. Since 0068
--      anon holds no privilege on any public table, view or sequence (re-stated
--      below), so anon never reaches a policy: its read stops at "permission
--      denied for table". Policies run as the querying role, so every helper a
--      policy calls keeps EXECUTE for authenticated. The service role bypasses
--      RLS and keeps every grant it had. A closing check refuses to finish if a
--      browser role can still execute a SECURITY DEFINER function outside this
--      table (catches hosted drift such as TEST's org_add_creator).
--  (b) search_path pinned (public, pg_temp) on schema_version() and
--      _org_invite_email(text), the two functions without one.
--  (c) Covering indexes for the 31 unindexed foreign keys, <table>_<col>_idx.
--      The 16 "unused" indexes stay: TEST traffic is no evidence.
--  (d) The 32 policies that called auth.uid()/auth.role() once per row now
--      call them once per statement: (select auth.uid()), (select
--      auth.role()). ALTER POLICY keeps each name, command, role list and
--      permissiveness; the expressions are the 0071 ones with only those calls
--      wrapped (scripts/db/advisorHardeningProbe.mjs compares them).
--      Not changed: the 51 multiple-permissive pairs (<table>_select +
--      <table>_write, org_invites_invitee_read + org_invites_owner). Merging
--      them changes which policy a role list and a command reach and is not
--      provably the same; they stay as they are.
--  (e) schema_version() reports 72.
--  Folded in from the trust & safety audit:
--  (f) T1  The accepted-Terms version lives in one SQL function,
--          legal_terms_version(), which commit_spin_attempt and
--          prepare_spin_attempt call instead of a literal (value unchanged).
--  (g) T10 Deleting a fan clears notes and due_at on its redemptions
--          (scrub_fan_traces); the redemption rows themselves stay.

-- ── (a) function privileges ──────────────────────────────────────────────────
-- anon reaches no table, view or sequence in public (0068), so no policy, and
-- so no RLS helper, is ever evaluated for it.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- RLS helpers: signed-in only. Policies run as the querying role, so
-- authenticated keeps EXECUTE (re-granted explicitly: the PUBLIC revoke must
-- not take it away where it was only inherited).
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_act_for(uuid, text) from public, anon;
revoke execute on function public.current_user_active() from public, anon;
revoke execute on function public._owns_org(uuid) from public, anon;
revoke execute on function public._owns_org_seat(uuid) from public, anon;
revoke execute on function public._is_org_member(uuid) from public, anon;
revoke execute on function public._my_confirmed_email() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.can_act_for(uuid, text) to authenticated, service_role;
grant execute on function public.current_user_active() to authenticated, service_role;
grant execute on function public._owns_org(uuid) to authenticated, service_role;
grant execute on function public._owns_org_seat(uuid) to authenticated, service_role;
grant execute on function public._is_org_member(uuid) to authenticated, service_role;
grant execute on function public._my_confirmed_email() to authenticated, service_role;

-- No app caller: service role only.
revoke execute on function public.admin_reserve_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.admin_reserve_account_deletion(uuid) to service_role;
revoke execute on function public.org_add_creator(uuid, text) from public, anon, authenticated;
grant execute on function public.org_add_creator(uuid, text) to service_role;

-- Trigger functions: no browser role needs EXECUTE. The named ones are the
-- ones the advisor and the local catalog show; the loop covers any other
-- trigger function a hosted database still grants.
revoke execute on function public.attach_spin_reward() from public, anon, authenticated;
revoke execute on function public.erase_fan_reward_values() from public, anon, authenticated;
revoke execute on function public.guard_delivered_redemption() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sync_code_prize_stock() from public, anon, authenticated;
revoke execute on function public.sync_fan_spin_aggregate() from public, anon, authenticated;
revoke execute on function public.guard_fan_break() from public, anon, authenticated;
revoke execute on function public.admin_audit_log_immutable() from public, anon, authenticated;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── (b) search_path ──────────────────────────────────────────────────────────
alter function public._org_invite_email(text) set search_path = public, pg_temp;

-- ── (c) covering indexes for foreign keys ───────────────────────────────────
create index if not exists bingo_cards_creator_id_idx on public.bingo_cards (creator_id);
create index if not exists bingo_cards_wheel_id_idx on public.bingo_cards (wheel_id);
create index if not exists bingo_line_awards_creator_id_idx on public.bingo_line_awards (creator_id);
create index if not exists bingo_line_awards_fan_id_idx on public.bingo_line_awards (fan_id);
create index if not exists bingo_line_awards_wheel_id_idx on public.bingo_line_awards (wheel_id);
create index if not exists chase_reservations_creator_id_idx on public.chase_reservations (creator_id);
create index if not exists chase_reservations_prize_id_idx on public.chase_reservations (prize_id);
create index if not exists chase_stock_evidence_creator_id_idx on public.chase_stock_evidence (creator_id);
create index if not exists creator_actor_contexts_creator_id_idx on public.creator_actor_contexts (creator_id);
create index if not exists creator_actor_contexts_session_id_idx on public.creator_actor_contexts (session_id);
create index if not exists creator_reports_creator_id_idx on public.creator_reports (creator_id);
create index if not exists creator_reports_fan_id_idx on public.creator_reports (fan_id);
create index if not exists creator_reports_resolved_by_idx on public.creator_reports (resolved_by);
create index if not exists creator_request_journal_batch_id_idx on public.creator_request_journal (batch_id);
create index if not exists creator_request_journal_grant_id_idx on public.creator_request_journal (grant_id);
create index if not exists fan_focus_creator_id_idx on public.fan_focus (creator_id);
create index if not exists fan_focus_fan_pass_id_idx on public.fan_focus (fan_pass_id);
create index if not exists fan_focus_grant_id_idx on public.fan_focus (grant_id);
create index if not exists fan_focus_prize_id_idx on public.fan_focus (prize_id);
create index if not exists fan_focus_wheel_id_idx on public.fan_focus (wheel_id);
create index if not exists fan_import_batches_creator_id_idx on public.fan_import_batches (creator_id);
create index if not exists fan_import_items_creator_id_idx on public.fan_import_items (creator_id);
create index if not exists fan_outreach_template_id_idx on public.fan_outreach (template_id);
create index if not exists fans_referred_by_fan_id_idx on public.fans (referred_by_fan_id);
create index if not exists grants_fan_pass_id_idx on public.grants (fan_pass_id);
create index if not exists org_member_creators_creator_id_idx on public.org_member_creators (creator_id);
create index if not exists profiles_org_id_idx on public.profiles (org_id);
create index if not exists redemptions_spin_id_idx on public.redemptions (spin_id);
create index if not exists spins_prize_id_idx on public.spins (prize_id);
create index if not exists spins_wheel_id_idx on public.spins (wheel_id);
create index if not exists wishlists_prize_id_idx on public.wishlists (prize_id);

-- ── (d) policies: auth.uid()/auth.role() once per statement ─────────────────
alter policy actor_request_cancellations_select on public.actor_request_cancellations
  using (((actor_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy autopilot_dismissals_rw on public.autopilot_dismissals
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy campaign_packs_rw on public.campaign_packs
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy chase_stock_evidence_service on public.chase_stock_evidence
  using ((select auth.role()) = 'service_role'::text);
alter policy creator_actor_contexts_own on public.creator_actor_contexts
  using (actor_id = (select auth.uid()));
alter policy creator_apps_insert on public.creator_applications
  with check (profile_id = (select auth.uid()));
alter policy creator_apps_select on public.creator_applications
  using (((profile_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy creator_media_delete on public.creator_media
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy creator_media_update on public.creator_media
  using ((creator_id = (select auth.uid())) and public.current_user_active())
  with check ((creator_id = (select auth.uid())) and public.current_user_active());
alter policy creator_request_journal_select on public.creator_request_journal
  using (((actor_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.can_act_for(creator_id, 'view'::text) or public.is_admin());
alter policy creator_storage_deletions_read on public.creator_storage_deletions
  using (((owner_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy creator_storage_dispatches_read on public.creator_storage_dispatches
  using (((owner_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy creator_storage_objects_read on public.creator_storage_objects
  using (((owner_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy dm_templates_rw on public.dm_templates
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy fan_checkins_select on public.fan_checkins
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.can_act_for(creator_id, 'view'::text) or public.is_admin());
alter policy happy_hours_rw on public.happy_hours
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check ((((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin()) and (exists (select 1 from public.wheels w where ((w.id = happy_hours.wheel_id) and (w.creator_id = happy_hours.creator_id)))));
alter policy org_members_read on public.org_members
  using (((profile_id = (select auth.uid())) and public.current_user_active()) or public._owns_org(org_id) or public.is_admin());
alter policy orgs_read on public.orgs
  using (((owner_id = (select auth.uid())) and public.current_user_active()) or public._is_org_member(id) or public.is_admin());
alter policy orgs_write on public.orgs
  using (((owner_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((owner_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy prize_templates_rw on public.prize_templates
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy profiles_select on public.profiles
  using ((id = (select auth.uid())) or public.is_admin());
alter policy push_log_select on public.push_log
  using (((user_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy push_subscriptions_delete on public.push_subscriptions
  using (((user_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy push_subscriptions_insert on public.push_subscriptions
  with check ((user_id = (select auth.uid())) and public.current_user_active());
alter policy push_subscriptions_select on public.push_subscriptions
  using (((user_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy push_subscriptions_update on public.push_subscriptions
  using ((user_id = (select auth.uid())) and public.current_user_active())
  with check ((user_id = (select auth.uid())) and public.current_user_active());
alter policy referrals_rw on public.referrals
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy reward_crypto_canary_service on public.reward_crypto_canary
  using ((select auth.role()) = 'service_role'::text);
alter policy spins_select on public.spins
  using (((creator_id = (select auth.uid())) and public.can_act_for((select auth.uid()), 'view'::text)) or public.is_admin());
alter policy webhooks_rw on public.webhooks
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy wheel_templates_rw on public.wheel_templates
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());
alter policy wishlists_rw on public.wishlists
  using (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin())
  with check (((creator_id = (select auth.uid())) and public.current_user_active()) or public.is_admin());

-- ── (f) T1: one source for the accepted-Terms version ────────────────────────
-- The spin functions compared a fan's accepted version with a literal, so a
-- LEGAL.version bump (src/lib/legal.ts) would store the new version on
-- acknowledgement while the database kept answering needs_ack: no fan could
-- spin. legal_terms_version() is the one SQL copy; src/lib/legalTermsVersion.test.ts
-- fails when it differs from LEGAL.version. It returns a public constant, so
-- every role may read it. The value is unchanged here; it is bumped together
-- with LEGAL.version and the published text.
create or replace function public.legal_terms_version()
returns text language sql stable security invoker set search_path = public, pg_temp as $$ select '2026-10-27'::text $$;
revoke execute on function public.legal_terms_version() from public;
grant execute on function public.legal_terms_version() to anon, authenticated, service_role;
comment on function public.legal_terms_version() is 'The Terms/Privacy version a fan must have accepted to play (0072). Equal to LEGAL.version in src/lib/legal.ts; bump both together.';

-- commit_spin_attempt and prepare_spin_attempt: 0071_ledger_guards_and_lock_order.sql's
-- definitions with only the version literal replaced by legal_terms_version()
-- (the 0071 lock order is unchanged).
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
 if not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then
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

-- ── (g) T10: a deleted fan's redemptions keep no creator notes or due date ──
-- scrub_fan_traces: 0068_tenant_boundaries_privacy.sql's definition plus the
-- redemption scrub. The two updates are separate so a delivered instant reward
-- (due_at already null) is never rewritten through the due_at guard.
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

-- ── closing check: browser roles reach only the reviewed functions ─────────
do $$
declare v_bad text;
begin
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception '0072: anon can still execute SECURITY DEFINER functions: %', v_bad;
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
  if v_bad is not null then
    raise exception '0072: authenticated can execute SECURITY DEFINER functions outside the reviewed list: %', v_bad;
  end if;
end $$;

-- ── (e) the migration level this database was built to ─────────────────────
create or replace function public.schema_version()
returns integer language sql immutable set search_path = public, pg_temp as $$ select 72 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0072). Every migration redefines it with its own number; the app flags a database behind its expected level.';
