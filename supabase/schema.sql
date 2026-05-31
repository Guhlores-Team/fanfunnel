-- ============================================================================
-- FanFunnel — database schema
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
--
-- Multi-tenant model with three effective roles:
--   * admin   — you / the agency. A SUPERSET of creator: owns its own wheels,
--               prizes and fans AND can see/manage every account.
--   * creator — your clients. Own their wheels, prizes, fans, passes.
--   * fan     — NOT a database user. Fans interact only through a secret
--               per-fan pass token; all fan writes happen server-side via the
--               service role, never directly from the browser.
-- ============================================================================

-- Extensions ----------------------------------------------------------------
create extension if not exists pgcrypto;

-- Enums ---------------------------------------------------------------------
do $$ begin
  create type app_role as enum ('admin', 'creator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type prize_rarity as enum ('common','uncommon','rare','epic','legendary');
exception when duplicate_object then null; end $$;

do $$ begin
  create type redemption_status as enum ('pending','fulfilled','cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user. Mirrors auth.users.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  role          app_role not null default 'creator',
  is_active     boolean not null default true,
  -- Feature flags the admin grants per account (e.g. {"bingo": true}).
  features      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- wheels: a configurable spin-the-wheel owned by a creator.
-- ---------------------------------------------------------------------------
create table if not exists public.wheels (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.profiles(id) on delete cascade,
  title        text not null default 'My Prize Wheel',
  subtitle     text,
  brand_color  text not null default '#ec4899',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wheels_creator_idx on public.wheels(creator_id);

-- ---------------------------------------------------------------------------
-- prizes: the segments on a wheel. weight drives probability; stock (when set)
-- makes a prize limited — when it hits 0 it stops appearing.
-- ---------------------------------------------------------------------------
create table if not exists public.prizes (
  id           uuid primary key default gen_random_uuid(),
  wheel_id     uuid not null references public.wheels(id) on delete cascade,
  label        text not null,
  description  text,
  rarity       prize_rarity not null default 'common',
  weight       integer not null default 10 check (weight >= 0),
  color        text,
  emoji        text,
  stock        integer,                       -- null = unlimited
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists prizes_wheel_idx on public.prizes(wheel_id);

-- ---------------------------------------------------------------------------
-- fans: a creator's audience member — the PERSISTENT account the creator
-- creates. The spin balance and (via the spins log) the win history live here,
-- NOT on individual links. So a creator can mint a fresh link weeks later and
-- the fan still sees their full history and any remaining balance.
-- ---------------------------------------------------------------------------
create table if not exists public.fans (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references public.profiles(id) on delete cascade,
  handle              text,
  display_name        text,
  notes               text,
  spins_remaining     integer not null default 0 check (spins_remaining >= 0),
  spins_granted_total integer not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists fans_creator_idx on public.fans(creator_id);

-- ---------------------------------------------------------------------------
-- fan_passes: a UNIQUE link (token) into a fan's account. A fan may have many
-- links over time (e.g. a fresh link each time they buy more spins); ALL of
-- them resolve to the same fan account, so balance + history are shared.
-- The token is the only secret a fan needs.
-- ---------------------------------------------------------------------------
create table if not exists public.fan_passes (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  wheel_id      uuid not null references public.wheels(id) on delete cascade,
  fan_id        uuid not null references public.fans(id) on delete cascade,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_spin_at  timestamptz
);
create index if not exists fan_passes_creator_idx on public.fan_passes(creator_id);
create index if not exists fan_passes_wheel_idx on public.fan_passes(wheel_id);
create index if not exists fan_passes_fan_idx on public.fan_passes(fan_id);

-- ---------------------------------------------------------------------------
-- campaigns: a named grouping a creator can attach to the links they mint, so
-- they can compare performance (spins, fans, fulfilment) across promotions.
-- A fan_pass optionally belongs to one campaign.
-- ---------------------------------------------------------------------------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists campaigns_creator_idx on public.campaigns(creator_id);
alter table public.fan_passes add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
create index if not exists fan_passes_campaign_idx on public.fan_passes(campaign_id);

-- ---------------------------------------------------------------------------
-- spins: immutable log of every spin (audit + metrics + anti-cheat).
-- Prize fields are snapshotted so history survives prize edits/deletes.
-- ---------------------------------------------------------------------------
create table if not exists public.spins (
  id            uuid primary key default gen_random_uuid(),
  fan_pass_id   uuid not null references public.fan_passes(id) on delete cascade,
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  wheel_id      uuid not null references public.wheels(id) on delete cascade,
  fan_id        uuid references public.fans(id) on delete set null,
  prize_id      uuid references public.prizes(id) on delete set null,
  prize_label   text not null,
  prize_rarity  prize_rarity not null default 'common',
  created_at    timestamptz not null default now()
);
create index if not exists spins_creator_idx on public.spins(creator_id);
create index if not exists spins_pass_idx on public.spins(fan_pass_id);

-- ---------------------------------------------------------------------------
-- redemptions: tracks fulfilment of a won prize by the creator.
-- ---------------------------------------------------------------------------
create table if not exists public.redemptions (
  id            uuid primary key default gen_random_uuid(),
  spin_id       uuid not null references public.spins(id) on delete cascade,
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  status        redemption_status not null default 'pending',
  notes         text,
  fulfilled_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists redemptions_creator_idx on public.redemptions(creator_id);

-- ============================================================================
-- Auth glue: auto-create a profile when a new auth user signs up.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Helper: is the current user an admin? (SECURITY DEFINER avoids RLS recursion)
-- ============================================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  );
$$;

-- ============================================================================
-- Atomic spin claim. Resolves the link's token to its fan account and
-- decrements one spin from the FAN (so balance is shared across all of a fan's
-- links). Returns the remaining spins, or NULL if it can't spin. Runs as the
-- service role from the server; logic-free so the TS engine stays the single
-- source of truth for prize selection.
-- ============================================================================
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  remaining integer;
begin
  select fan_id into v_fan
    from public.fan_passes
   where token = p_token and is_active = true;
  if v_fan is null then
    return null; -- bad/inactive token
  end if;

  update public.fans
     set spins_remaining = spins_remaining - 1
   where id = v_fan and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is not null then
    update public.fan_passes set last_spin_at = now() where token = p_token;
  end if;

  return remaining; -- NULL when the fan has no spins left
end;
$$;

-- ============================================================================
-- Admin: per-account stats across ALL creators. Returns rows only to admins
-- (the WHERE is_admin() gate makes it return nothing for everyone else).
-- ============================================================================
create or replace function public.admin_account_stats()
returns table (
  id uuid,
  email text,
  display_name text,
  role app_role,
  is_active boolean,
  features jsonb,
  wheels bigint,
  fans bigint,
  spins bigint,
  pending bigint
)
language sql
stable
security definer set search_path = public
as $$
  select
    p.id, p.email, p.display_name, p.role, p.is_active, p.features,
    (select count(*) from public.wheels w where w.creator_id = p.id and w.archived_at is null),
    (select count(*) from public.fans f where f.creator_id = p.id),
    (select count(*) from public.spins s where s.creator_id = p.id),
    (select count(*) from public.redemptions r
       where r.creator_id = p.id and r.status = 'pending')
  from public.profiles p
  where public.is_admin()
  order by p.created_at;
$$;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles    enable row level security;
alter table public.wheels      enable row level security;
alter table public.prizes      enable row level security;
alter table public.fans        enable row level security;
alter table public.fan_passes  enable row level security;
alter table public.campaigns   enable row level security;
alter table public.spins       enable row level security;
alter table public.redemptions enable row level security;

-- profiles -------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

-- Only admins may UPDATE profiles. This is deliberate: it stops a creator from
-- escalating their own role or granting themselves features. (No in-app
-- self-profile edit exists yet; add a SECURITY DEFINER function for safe
-- self-updates if that changes.)
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- Generic owner-or-admin policies for creator-owned tables.
-- (creator_id = auth.uid()) gives a creator their own rows; is_admin() gives
-- the admin everything — which is exactly the "dual admin+creator" behaviour.
drop policy if exists wheels_rw on public.wheels;
create policy wheels_rw on public.wheels for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

drop policy if exists prizes_rw on public.prizes;
create policy prizes_rw on public.prizes for all
  using (exists (select 1 from public.wheels w
                 where w.id = prizes.wheel_id
                   and (w.creator_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.wheels w
                 where w.id = prizes.wheel_id
                   and (w.creator_id = auth.uid() or public.is_admin())));

drop policy if exists fans_rw on public.fans;
create policy fans_rw on public.fans for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

drop policy if exists fan_passes_rw on public.fan_passes;
create policy fan_passes_rw on public.fan_passes for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

drop policy if exists campaigns_rw on public.campaigns;
create policy campaigns_rw on public.campaigns for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

drop policy if exists spins_select on public.spins;
create policy spins_select on public.spins for select
  using (creator_id = auth.uid() or public.is_admin());

drop policy if exists redemptions_rw on public.redemptions;
create policy redemptions_rw on public.redemptions for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- NOTE: there are intentionally NO insert policies for `spins` and no fan-side
-- policies anywhere. Fan reads/writes go through the server using the service
-- role (which bypasses RLS), keeping the secret token server-side.

-- ============================================================================
-- Revenue + many-to-many campaign attribution (migration 0002)
-- A fan has one permanent link but can buy into many campaigns. Each grant
-- (new fan or top-up) tags spins + money to a campaign; each spin is attributed
-- to a campaign FIFO so per-campaign spins/prizes are exact.
-- ============================================================================
create table if not exists public.grants (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.profiles(id) on delete cascade,
  fan_id       uuid not null references public.fans(id) on delete cascade,
  campaign_id  uuid references public.campaigns(id) on delete set null,
  spins        integer not null default 0 check (spins >= 0),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  created_at   timestamptz not null default now()
);
create index if not exists grants_creator_idx   on public.grants(creator_id);
create index if not exists grants_fan_idx        on public.grants(fan_id);
create index if not exists grants_campaign_idx   on public.grants(campaign_id);
create index if not exists grants_created_at_idx on public.grants(created_at);

alter table public.grants enable row level security;
drop policy if exists grants_rw on public.grants;
create policy grants_rw on public.grants for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

alter table public.spins
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
create index if not exists spins_campaign_idx on public.spins(campaign_id);

-- ============================================================================
-- Phase 1: per-fan notes/tags + saved DM templates (migration 0003)
-- ============================================================================
alter table public.fans add column if not exists notes text;
alter table public.fans add column if not exists tags text[] not null default '{}';
create index if not exists fans_tags_idx on public.fans using gin(tags);

create table if not exists public.dm_templates (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists dm_templates_creator_idx on public.dm_templates(creator_id);

alter table public.dm_templates enable row level security;
drop policy if exists dm_templates_rw on public.dm_templates;
create policy dm_templates_rw on public.dm_templates for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- ============================================================================
-- Phase 2 (migration 0004)
-- ============================================================================
alter table public.wheels add column if not exists archived_at  timestamptz;
alter table public.wheels add column if not exists active_from  timestamptz;
alter table public.wheels add column if not exists active_until timestamptz;
create index if not exists wheels_creator_live_idx on public.wheels(creator_id) where archived_at is null;

alter table public.campaigns add column if not exists pinned_wheel_id uuid references public.wheels(id) on delete set null;
create index if not exists campaigns_pinned_wheel_idx on public.campaigns(pinned_wheel_id);

create table if not exists public.campaign_packs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  label text not null,
  spins integer not null default 0 check (spins >= 0),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  bonus_spins integer not null default 0 check (bonus_spins >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists campaign_packs_creator_idx on public.campaign_packs(creator_id);
create index if not exists campaign_packs_campaign_idx on public.campaign_packs(campaign_id);
alter table public.campaign_packs enable row level security;
drop policy if exists campaign_packs_rw on public.campaign_packs;
create policy campaign_packs_rw on public.campaign_packs for all
  using (creator_id = auth.uid() or public.is_admin()) with check (creator_id = auth.uid() or public.is_admin());

create table if not exists public.prize_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  label text not null, description text,
  rarity prize_rarity not null default 'common',
  weight integer not null default 10 check (weight >= 0),
  color text, emoji text,
  created_at timestamptz not null default now()
);
create index if not exists prize_templates_creator_idx on public.prize_templates(creator_id);
alter table public.prize_templates enable row level security;
drop policy if exists prize_templates_rw on public.prize_templates;
create policy prize_templates_rw on public.prize_templates for all
  using (creator_id = auth.uid() or public.is_admin()) with check (creator_id = auth.uid() or public.is_admin());

create table if not exists public.wheel_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  name text not null, title text not null default 'My Prize Wheel', subtitle text,
  brand_color text not null default '#ec4899',
  prizes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wheel_templates_creator_idx on public.wheel_templates(creator_id);
alter table public.wheel_templates enable row level security;
drop policy if exists wheel_templates_rw on public.wheel_templates;
create policy wheel_templates_rw on public.wheel_templates for all
  using (creator_id = auth.uid() or public.is_admin()) with check (creator_id = auth.uid() or public.is_admin());

alter table public.fans add column if not exists pity_counter integer not null default 0 check (pity_counter >= 0);
alter table public.grants add column if not exists bonus_spins integer not null default 0 check (bonus_spins >= 0);

-- ============================================================================
-- Phase 3 (migration 0005)
-- ============================================================================
-- #22 Prize photos -----------------------------------------------------------
alter table public.prizes add column if not exists image_url text;
alter table public.spins  add column if not exists prize_image_url text;

-- #3 Share-card: a non-secret public id per spin (NEVER the pass token) -------
alter table public.spins add column if not exists share_id text unique
  default encode(gen_random_bytes(9), 'hex');
update public.spins set share_id = encode(gen_random_bytes(9),'hex') where share_id is null;
create index if not exists spins_share_id_idx on public.spins(share_id);

-- #6 Leaderboard opt-in -------------------------------------------------------
alter table public.profiles add column if not exists leaderboard_enabled boolean not null default false;
alter table public.fans     add column if not exists leaderboard_opt_in  boolean not null default false;

-- Safe self-update of just leaderboard_enabled (profiles_update is admin-only).
create or replace function public.set_leaderboard_enabled(p_enabled boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set leaderboard_enabled = p_enabled where id = auth.uid();
$$;

-- #7 Happy hour: rare-odds multiplier window, per wheel -----------------------
create table if not exists public.happy_hours (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.profiles(id) on delete cascade,
  wheel_id     uuid not null references public.wheels(id) on delete cascade,
  multiplier   numeric not null default 2 check (multiplier >= 1 and multiplier <= 10),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists happy_hours_creator_idx on public.happy_hours(creator_id);
create index if not exists happy_hours_wheel_window_idx on public.happy_hours(wheel_id, starts_at, ends_at);
alter table public.happy_hours enable row level security;
drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- #5 Wishlist -----------------------------------------------------------------
create table if not exists public.wishlists (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.profiles(id) on delete cascade,
  fan_id       uuid not null references public.fans(id) on delete cascade,
  prize_id     uuid references public.prizes(id) on delete set null,
  prize_label  text not null,
  prize_rarity prize_rarity not null default 'common',
  created_at   timestamptz not null default now(),
  unique (fan_id, prize_label)
);
create index if not exists wishlists_creator_idx on public.wishlists(creator_id);
create index if not exists wishlists_fan_idx on public.wishlists(fan_id);
alter table public.wishlists enable row level security;
drop policy if exists wishlists_rw on public.wishlists;
create policy wishlists_rw on public.wishlists for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- #20 Referral spins ----------------------------------------------------------
alter table public.fans add column if not exists referral_code text unique
  default encode(gen_random_bytes(6),'hex');
update public.fans set referral_code = encode(gen_random_bytes(6),'hex') where referral_code is null;
alter table public.fans add column if not exists referred_by_fan_id uuid references public.fans(id) on delete set null;
alter table public.fans add column if not exists referral_credited boolean not null default false;

create table if not exists public.referrals (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles(id) on delete cascade,
  referrer_fan_id uuid not null references public.fans(id) on delete cascade,
  referred_fan_id uuid not null references public.fans(id) on delete cascade,
  bonus_spins     integer not null default 0 check (bonus_spins >= 0),
  credited_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (referred_fan_id)
);
create index if not exists referrals_creator_idx on public.referrals(creator_id);
create index if not exists referrals_referrer_idx on public.referrals(referrer_fan_id);
alter table public.referrals enable row level security;
drop policy if exists referrals_rw on public.referrals;
create policy referrals_rw on public.referrals for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- 💬 Spin-gated chat ----------------------------------------------------------
do $$ begin
  create type message_sender as enum ('fan','creator');
exception when duplicate_object then null; end $$;

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  fan_id      uuid not null references public.fans(id) on delete cascade,
  sender      message_sender not null,
  body        text not null check (char_length(body) between 1 and 2000),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists messages_creator_idx on public.messages(creator_id);
create index if not exists messages_fan_idx on public.messages(fan_id, created_at);
alter table public.messages enable row level security;
drop policy if exists messages_rw on public.messages;
create policy messages_rw on public.messages for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- #22 Prize photos: a PUBLIC storage bucket (world-readable; namespaced writes)
insert into storage.buckets (id, name, public)
values ('prize-photos','prize-photos', true)
on conflict (id) do nothing;

drop policy if exists prize_photos_read on storage.objects;
create policy prize_photos_read on storage.objects for select
  using (bucket_id = 'prize-photos');
drop policy if exists prize_photos_write on storage.objects;
create policy prize_photos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'prize-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists prize_photos_update on storage.objects;
create policy prize_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'prize-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists prize_photos_delete on storage.objects;
create policy prize_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'prize-photos' and (storage.foldername(name))[1] = auth.uid()::text);
