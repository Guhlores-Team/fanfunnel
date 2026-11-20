-- FanFunnel go-live pre-check. READ-ONLY: one SELECT, it changes nothing.
--
-- OWNER: paste this whole file into the Supabase SQL editor of the database
-- you are about to update (LIVE, and TEST before it) and press Run. One grid
-- comes back with three columns: check, rows_found, verdict.
--   * Every verdict starts with "ok": go ahead with the update.
--   * Any verdict starts with "STOP": do not update. Copy that line to the
--     developer. Nothing has been changed by running this.
-- "ok (not in this database yet)" means the table or column that check looks
-- at is only created by the update itself; it is fine.
--
-- What it covers (migrations 0039..0073): negative ledger values that the
-- 0052 / 0071 / 0073 CHECKs refuse (0052 drops its CHECK with a warning, then
-- 0073 stops, which would leave the database half-updated); accounts with two
-- agencies (0071) or two access requests (0073); report statuses 0064 cannot
-- convert; every free-text size limit of 0073 (rows over a limit leave that
-- limit switched off); and what the final check of 0073 refuses in the
-- catalog (tables without row security or a policy, wide-open policies,
-- objects of another role, rights granted to PUBLIC, unknown owner-rights
-- functions). It runs at every migration level from 0038 on: a check whose
-- table or column does not exist yet is skipped, not failed.
--
-- scripts/db/goLivePrecheckProbe.mjs (run by the schema drift check) proves
-- it against a database built to 0038 and one built to 0072, each once clean
-- (all ok) and once with one planted violation per check (all STOP), and
-- against the newest level. Keep the free-text rows equal to the DB-03 rule
-- list of 0073 and the function list equal to the SECURITY DEFINER functions
-- the migrations create; the probe fails when they drift.
with known(names) as (values (
    '_bingo_ready_error _commit_bingo_bonus _create_pass_grant_core _creator_actor_allowed ' ||
    '_creator_actor_context_valid _creator_actor_grant_allowed _creator_default_wheel _creator_request_finish ' ||
    '_creator_request_grant_erased _creator_request_open _creator_request_receipt _default_redemption_due ' ||
    '_drop_stale_seat_scopes _edit_grant_patch_core _fan_import_result _focus_lifecycle _game_actor_edit_allowed ' ||
    '_game_feature_allowed _game_has_min_prizes _game_is_chosen _grant_focus_pack_core _grant_pass_spins_core ' ||
    '_guard_award_cost_snapshot _guard_bingo_prize_change _guard_bingo_state_write _guard_bingo_wheel_lifecycle ' ||
    '_guard_campaign_game _guard_chosen_game_prizes _guard_creator_application_insert _guard_creator_immutable ' ||
    '_guard_game_history_delete _guard_game_schedule_prizes _guard_game_settings _guard_happy_hour_tenant ' ||
    '_guard_new_game_schedule _guard_org_name _guard_profile_public_fields _guard_redemption_stock_unit ' ||
    '_import_fans_durable_core _is_org_member _lock_wheel_focus_fans _lock_wheel_lifecycle _my_confirmed_email ' ||
    '_org_invite_throttled _org_owner_state _owns_org _owns_org_seat _preserve_active_admin _release_fan_focus ' ||
    '_resolve_unlock_requests _resolved_spin_wheel _reward_crypto_inventory _serialize_active_admins ' ||
    '_session_mfa_satisfied _spin_attempt_context _spin_attempt_receipt _stamp_actor_attribution _sync_org_brief ' ||
    'add_reward_codes admin_account_stats admin_reserve_account_deletion archive_wheel attach_spin_reward ' ||
    'award_fan_referral bootstrap_first_admin can_act_for cancel_fan_focus cancel_spin_attempt ' ||
    'claim_app_error_alert claim_spin commit_spin_attempt create_pass_grant creator_analytics_summary ' ||
    'creator_fan_summaries creator_link_pass creator_link_tokens creator_media_cap creator_media_unset_background ' ||
    'creator_obligations creator_redemption_queue creator_reports_review_stamp creator_reports_snapshot ' ||
    'creator_storage_account creator_storage_complete_remove creator_storage_dispatch creator_storage_finish_upload ' ||
    'creator_storage_manifest creator_storage_prune creator_storage_publish_media creator_storage_queue_remove ' ||
    'creator_storage_register_upload creator_storage_security_write creator_storage_work_claim credit_pass_spins ' ||
    'current_user_active delete_campaign delete_wheel edit_pass_grant ensure_pass_commitment ' ||
    'erase_fan_reward_values fan_take_break fence_reward_inventory_write finalize_reward_spin get_bingo_card_state ' ||
    'get_fan_focus_state get_spin_attempt_status grant_focus_pack grant_pass_spins guard_atomic_fan_economy ' ||
    'guard_atomic_pass_economy guard_atomic_spin_insert guard_delivered_redemption guard_fan_referrer ' ||
    'guard_grant_tenant guard_redemption_tenant guard_referral_tenant guard_wishlist_tenant handle_new_user ' ||
    'import_fans import_fans_durable initialize_reward_crypto_canary is_admin issue_creator_actor_context ' ||
    'my_seat_creators org_account_stats org_add_creator org_add_member org_create org_invite_creator ' ||
    'org_invite_respond org_invite_revoke org_leave org_remove_creator org_remove_member org_scope_creator ' ||
    'prepare_spin_attempt protect_reward_crypto_canary read_reward_crypto_canary reconcile_creator_request ' ||
    'record_app_error record_chase_stock_evidence record_fan_ack record_fan_reward_view record_fan_reward_views ' ||
    'record_reward_view record_system_health_check record_terms_acceptance release_app_error_alert ' ||
    'release_reward_code reserve_reward_code reserve_self_account_deletion reset_creator_content ' ||
    'reward_crypto_inventory_page rollback_claimed_spin run_retention_cleanup run_reward_ledger_invariants ' ||
    'save_game_wheel save_wheel_prizes scrub_fan_reward_values scrub_fan_traces self_exclude_pass set_chat_settings ' ||
    'set_creator_note set_creator_theme set_display_name set_fan_chat_mute set_fan_pass_game ' ||
    'set_leaderboard_enabled set_notification_prefs set_notifications_seen set_onboarding_dismissed ' ||
    'set_prize_delivery set_public_profile set_pwa_icon_mode set_redemption_state sync_code_prize_stock ' ||
    'sync_fan_spin_aggregate sync_profile_email webhooks_cap wipe_my_spin_attempts witness_chase_stock_debit ')),
checks(ord, name, needs, query, stop) as (values
  (10, 'Fans with a negative spin balance', array['fans.spins_remaining']::text[], 'select count(*) as n from public.fans where spins_remaining < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (11, 'Fans with a negative lifetime spin total', array['fans.spins_granted_total']::text[], 'select count(*) as n from public.fans where spins_granted_total < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (12, 'Fans with a negative rate-limit counter', array['fans.rl_count']::text[], 'select count(*) as n from public.fans where rl_count < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (13, 'Links with a negative spin balance', array['fan_passes.spins_remaining']::text[], 'select count(*) as n from public.fan_passes where spins_remaining < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (14, 'Links with a negative lifetime spin total', array['fan_passes.spins_granted_total']::text[], 'select count(*) as n from public.fan_passes where spins_granted_total < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (15, 'Prizes with negative stock', array['prizes.stock']::text[], 'select count(*) as n from public.prizes where stock < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (16, 'Prizes with a negative cost', array['prizes.cost_cents']::text[], 'select count(*) as n from public.prizes where cost_cents < 0',
      'STOP: these rows hold a negative number. The update refuses them or resets them without telling you. Do not go live; send this line to the developer.'),
  (20, 'Accounts that own more than one agency', array['orgs.owner_id']::text[], 'select count(*) as n from (select owner_id from public.orgs group by owner_id having count(*) > 1) d',
      'STOP: an account owns more than one agency and the update allows one per account. Do not go live; send this line to the developer.'),
  (21, 'Accounts with more than one access request', array['creator_applications.profile_id']::text[], 'select count(*) as n from (select profile_id from public.creator_applications where profile_id is not null group by profile_id having count(*) > 1) d',
      'STOP: an account holds more than one access request and the update allows one per account. Do not go live; send this line to the developer.'),
  (22, 'Safety reports with a status the update does not know', array['creator_reports.status']::text[], 'select count(*) as n from public.creator_reports where status not in (''open'', ''reviewed'', ''actioned'', ''resolved'', ''dismissed'')',
      'STOP: a safety report has a status the update cannot convert. Do not go live; send this line to the developer.'),
  (30, 'Text over the size limit: fans.notes (2000 characters)', array['fans.notes']::text[], 'select count(*) as n from public.fans where not (notes is null or char_length(notes) <= 2000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (31, 'Fans with more than 50 tags or a tag over 64 characters', array['fans.tags']::text[], 'select count(*) as n from public.fans where coalesce(array_length(tags, 1), 0) > 50 or exists (select 1 from unnest(tags) t where char_length(t) > 64)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (32, 'Text over the size limit: fans.display_name (80 characters)', array['fans.display_name']::text[], 'select count(*) as n from public.fans where not (display_name is null or char_length(display_name) <= 80)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (33, 'Text over the size limit: fans.handle (80 characters)', array['fans.handle']::text[], 'select count(*) as n from public.fans where not (handle is null or char_length(handle) <= 80)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (34, 'Text over the size limit: prizes.label (120 characters)', array['prizes.label']::text[], 'select count(*) as n from public.prizes where not (char_length(label) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (35, 'Text over the size limit: prizes.description (1000 characters)', array['prizes.description']::text[], 'select count(*) as n from public.prizes where not (description is null or char_length(description) <= 1000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (36, 'Text over the size limit: prizes.color (32 characters)', array['prizes.color']::text[], 'select count(*) as n from public.prizes where not (color is null or char_length(color) <= 32)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (37, 'Text over the size limit: prizes.emoji (32 characters)', array['prizes.emoji']::text[], 'select count(*) as n from public.prizes where not (emoji is null or char_length(emoji) <= 32)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (38, 'Text over the size limit: wheels.title (120 characters)', array['wheels.title']::text[], 'select count(*) as n from public.wheels where not (char_length(title) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (39, 'Text over the size limit: wheels.subtitle (200 characters)', array['wheels.subtitle']::text[], 'select count(*) as n from public.wheels where not (subtitle is null or char_length(subtitle) <= 200)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (40, 'Text over the size limit: wheel_templates.name (120 characters)', array['wheel_templates.name']::text[], 'select count(*) as n from public.wheel_templates where not (char_length(name) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (41, 'Text over the size limit: wheel_templates.title (120 characters)', array['wheel_templates.title']::text[], 'select count(*) as n from public.wheel_templates where not (char_length(title) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (42, 'Text over the size limit: wheel_templates.subtitle (200 characters)', array['wheel_templates.subtitle']::text[], 'select count(*) as n from public.wheel_templates where not (subtitle is null or char_length(subtitle) <= 200)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (43, 'Text over the size limit: campaigns.name (120 characters)', array['campaigns.name']::text[], 'select count(*) as n from public.campaigns where not (char_length(name) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (44, 'Text over the size limit: orgs.name (120 characters)', array['orgs.name']::text[], 'select count(*) as n from public.orgs where not (char_length(name) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (45, 'Text over the size limit: wishlists.prize_label (120 characters)', array['wishlists.prize_label']::text[], 'select count(*) as n from public.wishlists where not (char_length(prize_label) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (46, 'Text over the size limit: dm_templates.title (120 characters)', array['dm_templates.title']::text[], 'select count(*) as n from public.dm_templates where not (char_length(title) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (47, 'Text over the size limit: dm_templates.body (2000 characters)', array['dm_templates.body']::text[], 'select count(*) as n from public.dm_templates where not (char_length(body) <= 2000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (48, 'Text over the size limit: prize_templates.label (120 characters)', array['prize_templates.label']::text[], 'select count(*) as n from public.prize_templates where not (char_length(label) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (49, 'Text over the size limit: prize_templates.description (1000 characters)', array['prize_templates.description']::text[], 'select count(*) as n from public.prize_templates where not (description is null or char_length(description) <= 1000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (50, 'Text over the size limit: campaign_packs.label (120 characters)', array['campaign_packs.label']::text[], 'select count(*) as n from public.campaign_packs where not (char_length(label) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (51, 'Text over the size limit: profiles.chat_intro (2000 characters)', array['profiles.chat_intro']::text[], 'select count(*) as n from public.profiles where not (chat_intro is null or char_length(chat_intro) <= 2000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (52, 'Text over the size limit: profiles.chat_outro (2000 characters)', array['profiles.chat_outro']::text[], 'select count(*) as n from public.profiles where not (chat_outro is null or char_length(chat_outro) <= 2000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (53, 'Text over the size limit: profiles.creator_note (2000 characters)', array['profiles.creator_note']::text[], 'select count(*) as n from public.profiles where not (creator_note is null or char_length(creator_note) <= 2000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (54, 'Text over the size limit: creator_applications.display_name (120 characters)', array['creator_applications.display_name']::text[], 'select count(*) as n from public.creator_applications where not (display_name is null or char_length(display_name) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (55, 'Text over the size limit: creator_applications.socials (600 characters)', array['creator_applications.socials']::text[], 'select count(*) as n from public.creator_applications where not (socials is null or char_length(socials) <= 600)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (56, 'Text over the size limit: creator_applications.audience_size (120 characters)', array['creator_applications.audience_size']::text[], 'select count(*) as n from public.creator_applications where not (audience_size is null or char_length(audience_size) <= 120)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (57, 'Text over the size limit: creator_applications.note (1000 characters)', array['creator_applications.note']::text[], 'select count(*) as n from public.creator_applications where not (note is null or char_length(note) <= 1000)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (58, 'Text over the size limit: creator_applications.email (320 characters)', array['creator_applications.email']::text[], 'select count(*) as n from public.creator_applications where not (email is null or char_length(email) <= 320)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (59, 'Text over the size limit: creator_applications.decision_reason (500 characters)', array['creator_applications.decision_reason']::text[], 'select count(*) as n from public.creator_applications where not (decision_reason is null or char_length(decision_reason) <= 500)',
      'STOP: these rows are longer than the new size limit. The update would go through but leave this limit switched off. Shorten them, or send this line to the developer, before go-live.'),
  (70, 'Tables without row-level security or without a policy', array[]::text[], 'select count(*) as n from pg_class c where c.relnamespace = ''public''::regnamespace and c.relkind in (''r'', ''p'') and (not c.relrowsecurity or not exists (select 1 from pg_policy p where p.polrelid = c.oid))',
      'STOP: a table in the public schema has no row-level security or no policy, and the update refuses to finish. Do not go live; send this line to the developer.'),
  (71, 'Policies that let every caller through (USING true)', array[]::text[], 'select count(*) as n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = ''public''::regnamespace and (pg_get_expr(p.polqual, p.polrelid) = ''true'' or pg_get_expr(p.polwithcheck, p.polrelid) = ''true'')',
      'STOP: a policy in the public schema lets every caller through, and the update refuses to finish. Do not go live; send this line to the developer.'),
  (72, 'Tables or functions that belong to another database role', array[]::text[], 'select (select count(*) from pg_class c where c.relnamespace = ''public''::regnamespace and c.relkind in (''r'', ''p'') and not pg_has_role(c.relowner, ''USAGE'') and not exists (select 1 from pg_depend d where d.classid = ''pg_class''::regclass and d.objid = c.oid and d.deptype = ''e'')) + (select count(*) from pg_proc f where f.pronamespace = ''public''::regnamespace and not pg_has_role(f.proowner, ''USAGE'') and not exists (select 1 from pg_depend d where d.classid = ''pg_proc''::regclass and d.objid = f.oid and d.deptype = ''e'')) as n',
      'STOP: something in the public schema belongs to a different database role than the one running this check, so the update cannot change it. Do not go live; send this line to the developer.'),
  (73, 'Table rights given to PUBLIC', array[]::text[], 'select count(*) as n from information_schema.table_privileges where table_schema = ''public'' and grantee = ''PUBLIC''',
      'STOP: a table in the public schema grants rights to every database role (PUBLIC); the update''s final check may refuse it. Do not go live; send this line to the developer.'),
  (74, 'Owner-rights functions this release does not know', array[]::text[], 'select count(*) as n from pg_proc f where f.pronamespace = ''public''::regnamespace and f.prosecdef and not exists (select 1 from pg_depend d where d.classid = ''pg_proc''::regclass and d.objid = f.oid and d.deptype = ''e'') and f.proname <> all (string_to_array((select names from known), '' ''))',
      'STOP: a function that runs with owner rights is not part of this release, and the update''s final check may refuse it. Do not go live; send this line to the developer.')
),
ran as (
  select c.ord, c.name, c.stop,
         case when exists (
                select 1 from unnest(c.needs) need
                 where not exists (
                   select 1 from pg_attribute a
                    where a.attrelid = to_regclass('public.' || split_part(need, '.', 1))
                      and a.attname = split_part(need, '.', 2) and a.attnum > 0 and not a.attisdropped))
              then null
              else substring(query_to_xml(replace(c.query, '(select names from known)', quote_literal((select names from known))), false, true, '')::text from '<n>(-?[0-9]+)</n>')::bigint
         end as n
    from checks c
)
select name as "check", coalesce(n, 0) as rows_found,
       case when n is null then 'ok (not in this database yet)' when n = 0 then 'ok' else stop end as verdict
  from ran
 order by ord;
