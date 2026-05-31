-- Phase 6 — gated creator signups (request + approve queue)
-- New self-signups land as 'pending' and can't use the dashboard until an admin
-- approves them. EXISTING accounts are grandfathered to 'approved' so nothing
-- already live is interrupted.

-- 1) Approval status on the profile.
do $$ begin
  create type creator_approval as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

alter table public.profiles
  add column if not exists approval_status creator_approval not null default 'pending';

-- Grandfather every PRE-EXISTING profile to approved (this runs once; new rows
-- created after this migration default to 'pending').
update public.profiles set approval_status = 'approved'
  where approval_status = 'pending';

-- Admins are always approved.
update public.profiles set approval_status = 'approved' where role = 'admin';

-- 2) The application a requester submits (creator details for vetting).
create table if not exists public.creator_applications (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade unique,
  display_name  text,
  email         text,
  socials       text,         -- links / handles (IG, X, OF, etc.)
  audience_size text,         -- free-form ("~5k subscribers")
  note          text,         -- anything else they want to tell us
  status        creator_approval not null default 'pending',
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists creator_applications_status_idx
  on public.creator_applications(status, created_at);

alter table public.creator_applications enable row level security;

-- A requester may insert + read THEIR OWN application; admins see all.
drop policy if exists creator_apps_insert on public.creator_applications;
create policy creator_apps_insert on public.creator_applications for insert
  with check (profile_id = auth.uid());

drop policy if exists creator_apps_select on public.creator_applications;
create policy creator_apps_select on public.creator_applications for select
  using (profile_id = auth.uid() or public.is_admin());

drop policy if exists creator_apps_admin_update on public.creator_applications;
create policy creator_apps_admin_update on public.creator_applications for update
  using (public.is_admin()) with check (public.is_admin());

-- 3) New signups must default to PENDING. Update the signup trigger so the
--    profile is created as pending (admins/grandfathered rows handled above).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, approval_status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 4) A fan/creator can read their OWN approval_status (profiles_select already
--    allows self-select). Admin approve/reject uses the existing admin-only
--    profiles_update policy via the data layer.
