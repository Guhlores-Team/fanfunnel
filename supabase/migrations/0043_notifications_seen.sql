-- 0043 Notification bell: per-account "seen" marker (RD-7 / behavior spec #1).
--
-- The bell's feed is derived on read from existing tables (pending
-- redemptions, unread fan messages, low prize stock, fans out of spins), so no
-- notification rows are stored. Unread = happened after the creator last
-- opened the bell, which is this one timestamp per account (null = never).
--
-- profiles_update RLS is admin-only (a creator must never update their own
-- profiles row: role/features escalation), so — mirroring
-- set_onboarding_dismissed — a narrow SECURITY DEFINER helper stamps now() on
-- the caller's OWN row and touches nothing else. It takes no arguments, so a
-- client can't pick the timestamp.
alter table public.profiles
  add column if not exists notifications_seen_at timestamptz;

create or replace function public.set_notifications_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set notifications_seen_at = now() where id = auth.uid();
$$;

-- Signed-in creators only: anon has no row to mark (auth.uid() is null), and
-- Supabase's default privileges would otherwise grant it EXECUTE explicitly.
revoke execute on function public.set_notifications_seen() from public, anon;
grant execute on function public.set_notifications_seen() to authenticated;
