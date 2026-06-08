-- 0021 Onboarding checklist dismissal — persisted per account (not the browser).
-- A creator can hide the "Get started" checklist and bring it back later from
-- any device. profiles_update is admin-only, so expose a SECURITY DEFINER
-- helper that lets a creator flip just this one column on their own row.

alter table public.profiles
  add column if not exists onboarding_dismissed boolean not null default false;

-- Safe self-update of just onboarding_dismissed (profiles_update is admin-only).
create or replace function public.set_onboarding_dismissed(p_dismissed boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set onboarding_dismissed = p_dismissed where id = auth.uid();
$$;
