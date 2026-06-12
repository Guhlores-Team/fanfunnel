-- 0023: Chat-settings self-update RPC + explicit grants.
--
-- BUG FIX: setChatSettings wrote profiles directly, but profiles_update RLS is
-- admin-only — so saving the chat intro/outro silently did nothing in
-- production (0 rows updated, no error). Mirror the other narrow SECURITY
-- DEFINER self-update functions.
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid();
$$;

-- Belt-and-braces: PostgREST occasionally reports freshly (re)created functions
-- as missing until its schema cache reloads; explicit grants also guard against
-- projects where default EXECUTE was revoked from PUBLIC.
grant execute on function public.set_chat_settings(text, text) to authenticated;
grant execute on function public.set_leaderboard_enabled(boolean) to authenticated;
grant execute on function public.set_onboarding_dismissed(boolean) to authenticated;
