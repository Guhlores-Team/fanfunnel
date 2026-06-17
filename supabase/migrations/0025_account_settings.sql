-- 0025 Account settings (Phase 9 #6 / #11)
--
-- Adds:
--   • wheels.label_color — creator-chosen color for the prize labels rendered on
--     the wheel (#11). Nullable: when unset, Wheel.tsx auto-picks a readable
--     per-segment label color. wheels already has a creator-scoped RW policy, so
--     no new policy is needed and saveWheel can write it via the auth client.
--   • profiles notification-preference columns (#6 Account → notifications),
--     persisted per account so they follow the creator across devices.
--   • Narrow SECURITY DEFINER self-update RPCs for the display name and the
--     notification prefs. profiles_update RLS is admin-only, so — mirroring
--     set_public_profile / set_creator_note / set_onboarding_dismissed — a
--     creator flips only these specific columns on their OWN row.

-- #11: per-wheel label color.
alter table public.wheels
  add column if not exists label_color text;

-- #6: per-account notification preferences (default on — least-surprise).
alter table public.profiles
  add column if not exists notify_new_spin boolean not null default true;
alter table public.profiles
  add column if not exists notify_low_balance boolean not null default true;
alter table public.profiles
  add column if not exists notify_messages boolean not null default true;

-- Safe self-update of just the display name (profiles_update is admin-only).
-- Trimmed; ignored when blank so a creator can't blank out their own name.
create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set display_name = coalesce(nullif(trim(p_name), ''), display_name)
   where id = auth.uid();
$$;

-- Safe self-update of just the notification preferences (profiles_update is
-- admin-only). All three flags are written together from the Settings form.
create or replace function public.set_notification_prefs(
  p_new_spin boolean, p_low_balance boolean, p_messages boolean
)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set notify_new_spin    = coalesce(p_new_spin, notify_new_spin),
         notify_low_balance = coalesce(p_low_balance, notify_low_balance),
         notify_messages    = coalesce(p_messages, notify_messages)
   where id = auth.uid();
$$;

-- Explicit grants — PostgREST can report a freshly (re)created function as missing
-- until its schema cache reloads, and some projects revoke default PUBLIC EXECUTE
-- (mirrors migration 0023). The `where id = auth.uid()` scoping keeps these
-- self-only even with execute granted.
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean) to authenticated;
