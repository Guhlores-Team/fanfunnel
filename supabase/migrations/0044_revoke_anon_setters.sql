-- 0044 Revoke anon EXECUTE on the self-service RPCs (RD-8).
--
-- Every function below is called by the app only through the signed-in
-- creator's session client (role `authenticated`). Earlier migrations granted
-- `authenticated` but never revoked the default EXECUTE, so `anon` (and, on
-- Supabase, its explicit default-privilege grant) could still call them. Each
-- body keys off auth.uid(), which is null for anon, so no row changes today;
-- this closes the door instead of relying on that (AGENTS.md rule 5), the same
-- shape 0043 used for set_notifications_seen().
--
-- Not touched, on purpose:
--   * is_admin / can_act_for / current_user_active / _owns_org: RLS policies
--     call them, and anon queries must still be able to evaluate those policies.
--   * Trigger functions (handle_new_user, sync_fan_spin_aggregate) and pgcrypto.
--   * Server-only RPCs (claim_spin, credit_pass_spins, rollback_claimed_spin,
--     org_add_creator): already revoked from anon/authenticated (0027/0030/0038).
--
-- Order matters: revoke from public + anon first, then grant authenticated, so
-- authenticated keeps EXECUTE even where it only had it through PUBLIC.

-- Self-service setters (each writes only the caller's own profiles row).
revoke execute on function public.set_onboarding_dismissed(boolean) from public, anon;
grant execute on function public.set_onboarding_dismissed(boolean) to authenticated;
revoke execute on function public.set_leaderboard_enabled(boolean) from public, anon;
grant execute on function public.set_leaderboard_enabled(boolean) to authenticated;
revoke execute on function public.set_chat_settings(text, text) from public, anon;
grant execute on function public.set_chat_settings(text, text) to authenticated;
revoke execute on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated;
revoke execute on function public.set_notification_prefs(boolean, boolean, boolean) from public, anon;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean) to authenticated;
revoke execute on function public.set_public_profile(text, text, text) from public, anon;
grant execute on function public.set_public_profile(text, text, text) to authenticated;
revoke execute on function public.set_creator_note(text, text) from public, anon;
grant execute on function public.set_creator_note(text, text) to authenticated;

-- Other signed-in-only RPCs (fan import, admin, agency). Each checks the
-- caller itself (auth.uid() ownership or is_admin()).
revoke execute on function public.import_fans(jsonb) from public, anon;
grant execute on function public.import_fans(jsonb) to authenticated;
revoke execute on function public.admin_account_stats() from public, anon;
grant execute on function public.admin_account_stats() to authenticated;
revoke execute on function public.admin_reserve_account_deletion(uuid) from public, anon;
grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;
revoke execute on function public.org_account_stats(uuid) from public, anon;
grant execute on function public.org_account_stats(uuid) to authenticated;
revoke execute on function public.org_create(text) from public, anon;
grant execute on function public.org_create(text) to authenticated;
revoke execute on function public.org_invite_creator(uuid, text) from public, anon;
grant execute on function public.org_invite_creator(uuid, text) to authenticated;
revoke execute on function public.org_invite_respond(uuid, boolean) from public, anon;
grant execute on function public.org_invite_respond(uuid, boolean) to authenticated;
revoke execute on function public.org_invite_revoke(uuid) from public, anon;
grant execute on function public.org_invite_revoke(uuid) to authenticated;
revoke execute on function public.org_remove_creator(uuid, uuid) from public, anon;
grant execute on function public.org_remove_creator(uuid, uuid) to authenticated;
revoke execute on function public.org_add_member(uuid, text, public.org_role) from public, anon;
grant execute on function public.org_add_member(uuid, text, public.org_role) to authenticated;
revoke execute on function public.org_remove_member(uuid) from public, anon;
grant execute on function public.org_remove_member(uuid) to authenticated;
revoke execute on function public.org_scope_creator(uuid, uuid, boolean) from public, anon;
grant execute on function public.org_scope_creator(uuid, uuid, boolean) to authenticated;
