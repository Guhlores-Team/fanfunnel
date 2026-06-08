-- FanFunnel — combined migrations, in order. Idempotent; safe to re-run.
-- Paste into Supabase → SQL Editor → Run. (Run schema.sql first on a brand-new project.)

-- ============================================================
-- 0001_campaigns.sql
-- ============================================================
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
alter table public.campaigns enable row level security;
drop policy if exists campaigns_rw on public.campaigns;
create policy campaigns_rw on public.campaigns for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- ============================================================
-- 0002_revenue_campaigns.sql
-- ============================================================
-- 0002_revenue_campaigns.sql
-- Revenue (grants ledger) + many-to-many campaign attribution. Idempotent:
-- safe to run on top of the 0001 campaigns migration.
--
-- Model: a fan has ONE permanent link and one shared spin balance, but can buy
-- into MANY campaigns over time. Each purchase (new fan or top-up) is a grant
-- tagged to a campaign with its spins + money. Each spin is attributed to a
-- campaign FIFO (oldest unused campaign spins first) so per-campaign
-- "spins played / prizes won" is exact.

-- Grants ledger -------------------------------------------------------------
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

-- Per-spin campaign attribution (set FIFO at spin time) ---------------------
alter table public.spins
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
create index if not exists spins_campaign_idx on public.spins(campaign_id);

-- ============================================================
-- 0003_phase1.sql
-- ============================================================
-- 0003_phase1.sql — Phase 1: per-fan notes/tags + saved DM templates.
-- Idempotent; safe to re-run.

-- Per-fan notes + tags (VIP / whale / new ...) for the Fans tab.
alter table public.fans add column if not exists notes text;
alter table public.fans add column if not exists tags text[] not null default '{}';
create index if not exists fans_tags_idx on public.fans using gin(tags);

-- Saved DM templates with a {link} placeholder, for one-tap "Copy DM".
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

-- ============================================================
-- 0004_phase2.sql
-- ============================================================
-- 0004_phase2.sql — Phase 2: multi-wheel, scheduling, packs, templates, bonuses. Idempotent.
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

-- #4 bulk bonus: record the comped (bonus) portion of a grant for display.
alter table public.grants add column if not exists bonus_spins integer not null default 0 check (bonus_spins >= 0);

-- Update admin_account_stats() so the wheels count excludes archived wheels.
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

-- ============================================================
-- 0005_phase3.sql
-- ============================================================
-- ============================================================================
-- 0005_phase3.sql — Phase 3: photos, share cards, wishlist, leaderboard,
-- happy hour, referrals, spin-gated chat. Idempotent; safe to re-run.
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

-- ============================================================
-- 0006_phase4.sql
-- ============================================================
-- Phase 4 (deeper analytics)
-- #18 Prize ROI: track the creator's cost to fulfil each prize, in cents.
alter table public.prizes add column if not exists cost_cents integer;

-- ============================================================
-- 0007_phase5_fulfilment.sql
-- ============================================================
-- Phase 5a (fulfilment workflow)
-- #13 A richer fulfilment queue: an "in progress" status plus a due date.
-- (redemptions.notes already exists from an earlier migration.)
alter type public.redemption_status add value if not exists 'in_progress';
alter table public.redemptions add column if not exists due_at timestamptz;

-- ============================================================
-- 0008_phase5_fairness.sql
-- ============================================================
-- Phase 5b (#23 Provably-fair spins)
-- The server commits to a random seed at spin time (storing its SHA-256 hash),
-- derives the spin's RNG from the seed, and reveals the seed afterward so the
-- commitment can be verified.
alter table public.spins add column if not exists server_seed text;
alter table public.spins add column if not exists server_seed_hash text;
alter table public.spins add column if not exists nonce bigint;

-- ============================================================
-- 0009_phase5_webhooks.sql
-- ============================================================
-- Phase 5b (#24 Webhooks + age-gate/ToS)

-- Outbound webhooks a creator registers to be notified of events (e.g. a prize
-- pending fulfilment). Creator-scoped via RLS.
create table if not exists public.webhooks (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  url text not null,
  event text not null default 'prize_pending',
  created_at timestamptz not null default now()
);
create index if not exists webhooks_creator_idx on public.webhooks(creator_id);
alter table public.webhooks enable row level security;

create policy webhooks_rw on public.webhooks for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- Age-gate / ToS: when a fan acknowledges the age + terms gate we stamp this.
alter table public.fans add column if not exists acked_at timestamptz;

-- ============================================================
-- 0010_phase5_chat_auto.sql
-- ============================================================
-- Phase 5 (Wave 3): editable auto intro/outro chat messages.
-- Idempotent: guarded so re-running is safe.

begin;

-- The creator's editable greeting (auto-sent when a fan opens chat) and
-- out-of-spins nudge (auto-sent when a fan runs dry). Null/empty = disabled.
alter table public.profiles add column if not exists chat_intro text;
alter table public.profiles add column if not exists chat_outro text;

commit;

-- ============================================================
-- 0011_gated_signups.sql
-- ============================================================
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

-- ============================================================
-- 0012_hardening_growth.sql
-- ============================================================
-- Phase 7 — hardening + growth
-- Risk 1 (durable spin rate limit), Risk 3 (fan self-exclusion), block/report,
-- and the SFW link-in-bio public slug. Idempotent; safe to re-run.

-- ── Risk 1: server-side spin rate limit ────────────────────────────────────
-- A durable, cross-instance counter. claim_spin enforces "<= N spins per
-- rolling window per fan" inside the same atomic transaction that decrements
-- the balance, so serverless instances can't race past it.
alter table public.fans add column if not exists last_spin_at timestamptz;

-- ── block / report ─────────────────────────────────────────────────────────
-- A creator can block a fan (their links stop working); a fan can report a
-- creator for predatory / rule-breaking behaviour (lands in the admin queue).
alter table public.fans add column if not exists blocked_at timestamptz;

create table if not exists public.creator_reports (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  fan_id      uuid references public.fans(id) on delete set null,
  token       text,                 -- the spin link the report came from
  reason      text not null,
  detail      text,
  status      text not null default 'open',  -- open | reviewed | actioned
  created_at  timestamptz not null default now()
);
create index if not exists creator_reports_status_idx
  on public.creator_reports(status, created_at);
alter table public.creator_reports enable row level security;
-- Only admins read/act on reports (cross-account safety queue). Inserts happen
-- via the service-role client (fans aren't authed), so no public insert policy.
drop policy if exists creator_reports_admin on public.creator_reports;
create policy creator_reports_admin on public.creator_reports for all
  using (public.is_admin()) with check (public.is_admin());

-- ── Risk 3: fan self-exclusion (NOT a spend limit — we don't gamble) ────────
-- A fan can pause their own link from the spin page; flips is_active off.
alter table public.fan_passes add column if not exists self_excluded_at timestamptz;

-- ── SFW link-in-bio: a public, shareable slug per creator ───────────────────
alter table public.profiles add column if not exists public_slug text unique;
alter table public.profiles add column if not exists tip_url text;     -- where fans go to tip/buy spins
alter table public.profiles add column if not exists public_tagline text;

-- Backfill a slug for existing creators from their display name (best-effort).
update public.profiles
  set public_slug = lower(regexp_replace(coalesce(display_name, 'creator'), '[^a-zA-Z0-9]+', '-', 'g'))
                    || '-' || substr(id::text, 1, 4)
  where public_slug is null;

-- Self-update RPC for the SFW page fields (profiles_update is admin-only).
create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug     = nullif(trim(p_slug), ''),
         tip_url         = nullif(trim(p_tip_url), ''),
         public_tagline  = nullif(trim(p_tagline), '')
   where id = auth.uid();
end;
$$;

-- ── Durable spin rate limit, enforced inside claim_spin ─────────────────────
-- Rebuild claim_spin to (a) reject blocked fans / self-excluded passes and
-- (b) cap to <= p_max spins within the last p_window_secs, atomically.
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_recent integer;
  remaining integer;
  p_max integer := 8;        -- max spins per window
  p_window interval := interval '10 seconds';
begin
  select fp.fan_id into v_fan
    from public.fan_passes fp
    join public.fans f on f.id = fp.fan_id
   where fp.token = p_token
     and fp.is_active = true
     and fp.self_excluded_at is null
     and f.blocked_at is null;
  if v_fan is null then
    return null; -- bad/inactive/blocked/self-excluded token
  end if;

  -- Rolling-window rate limit across ALL instances (counts this fan's recent
  -- spins straight from the spins table — the single source of truth).
  select count(*) into v_recent
    from public.spins
   where fan_id = v_fan and created_at > now() - p_window;
  if v_recent >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  end if;

  update public.fans
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where id = v_fan and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is not null then
    update public.fan_passes set last_spin_at = now() where token = p_token;
  end if;

  return remaining; -- NULL when the fan has no spins left
end;
$$;

-- ============================================================
-- 0013_fix_active_wheel.sql
-- ============================================================
-- Phase 7.1 — fixes
-- #2 Multiple wheels showing "Active": wheels.is_active defaulted to TRUE, so
-- every newly-created/saved wheel was born active. Flip the default to FALSE
-- and repair existing data so exactly ONE wheel per creator is active.

alter table public.wheels alter column is_active set default false;

-- Repair: for each creator, keep the most-recently-updated active wheel active
-- and deactivate the rest. If a creator has NO active wheel after that, promote
-- their oldest non-archived wheel.
with ranked as (
  select id, creator_id,
         row_number() over (
           partition by creator_id
           order by is_active desc, updated_at desc, created_at desc
         ) as rn
    from public.wheels
   where archived_at is null
)
update public.wheels w
   set is_active = (r.rn = 1)
  from ranked r
 where w.id = r.id;

-- Safety: any creator left with zero active (e.g. all archived edge cases) —
-- promote their oldest non-archived wheel.
update public.wheels w
   set is_active = true
 where w.archived_at is null
   and w.id = (
     select id from public.wheels w2
      where w2.creator_id = w.creator_id and w2.archived_at is null
      order by created_at asc limit 1
   )
   and not exists (
     select 1 from public.wheels w3
      where w3.creator_id = w.creator_id and w3.archived_at is null and w3.is_active
   );

-- #5 Compliance: we are NOT hosting prize media or auto-delivering prizes.
-- Lock down the (now unused) prize-photos bucket so it can't serve content, and
-- drop its public-read policy. The image_url columns stay in the schema as inert
-- (nullable, never written by the app) to avoid a destructive migration.
update storage.buckets set public = false where id = 'prize-photos';
drop policy if exists prize_photos_read on storage.objects;
drop policy if exists prize_photos_write on storage.objects;
drop policy if exists prize_photos_update on storage.objects;
drop policy if exists prize_photos_delete on storage.objects;

-- ============================================================
-- 0014_agency.sql
-- ============================================================
-- Phase 8A — Agency console: orgs own creators; seats get scoped powers.
-- Layers BESIDE the existing single-creator model (everything stays keyed to
-- creator_id = profiles.id). Backwards-compatible: a creator with no org keeps
-- working exactly as before.

-- ── Roles & tables ──────────────────────────────────────────────────────────
do $$ begin
  create type org_role as enum ('owner','manager','chatter','fulfiller','analyst');
exception when duplicate_object then null; end $$;

create table if not exists public.orgs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  billing_model text not null default 'per_seat',  -- 'per_seat' | 'rev_share'
  created_at    timestamptz not null default now()
);

-- A person (profile) holding a seat in an org, with a role.
create table if not exists public.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role       org_role not null default 'analyst',
  created_at timestamptz not null default now(),
  unique (org_id, profile_id)
);
create index if not exists org_members_profile_idx on public.org_members(profile_id);

-- Which creator accounts a seat may act for. A row here grants scope; absence
-- means no access. (owners/managers may be granted all via a wildcard app-side.)
create table if not exists public.org_member_creators (
  member_id  uuid not null references public.org_members(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  primary key (member_id, creator_id)
);

-- Which org a creator account belongs to (null = independent creator).
alter table public.profiles add column if not exists org_id uuid references public.orgs(id) on delete set null;

-- ── Permission predicate (SECURITY DEFINER avoids RLS recursion) ─────────────
-- Returns true if the current auth user may perform `perm` on `target_creator`.
-- Perms: 'view','chat','fulfil','grant','edit_wheel','manage'.
create or replace function public.can_act_for(target_creator uuid, perm text)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_role org_role;
  v_member uuid;
  v_scoped boolean;
begin
  -- The creator themselves always has full power over their own account.
  if target_creator = auth.uid() then
    return true;
  end if;

  -- Find the caller's org membership that covers the target creator's org.
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid()
     and p.org_id = o.id
   limit 1;
  if v_member is null then
    return false;
  end if;

  -- Owners and managers act for every creator in their org.
  -- Other roles must be explicitly scoped to this creator.
  if v_role in ('owner','manager') then
    v_scoped := true;
  else
    select exists(
      select 1 from public.org_member_creators mc
       where mc.member_id = v_member and mc.creator_id = target_creator
    ) into v_scoped;
  end if;
  if not v_scoped then
    return false;
  end if;

  -- Role → permission matrix.
  return case perm
    when 'view'       then true
    when 'chat'       then v_role in ('owner','manager','chatter')
    when 'fulfil'     then v_role in ('owner','manager','fulfiller')
    when 'grant'      then v_role in ('owner','manager')
    when 'edit_wheel' then v_role in ('owner','manager')
    when 'manage'     then v_role in ('owner','manager')
    else false
  end case;
end;
$$;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_member_creators enable row level security;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select
  using (owner_id = auth.uid()
         or exists(select 1 from public.org_members m where m.org_id = id and m.profile_id = auth.uid())
         or public.is_admin());
drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs for all
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select
  using (profile_id = auth.uid()
         or exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid())
         or public.is_admin());
drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for all
  using (exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid()) or public.is_admin())
  with check (exists(select 1 from public.orgs o where o.id = org_id and o.owner_id = auth.uid()) or public.is_admin());

drop policy if exists omc_rw on public.org_member_creators;
create policy omc_rw on public.org_member_creators for all
  using (exists(
           select 1 from public.org_members m join public.orgs o on o.id = m.org_id
            where m.id = member_id and o.owner_id = auth.uid())
         or public.is_admin())
  with check (exists(
           select 1 from public.org_members m join public.orgs o on o.id = m.org_id
            where m.id = member_id and o.owner_id = auth.uid())
         or public.is_admin());

-- ── Split owner `for all` policies → per-command, OR-ing in can_act_for ──────
-- Pattern per table: SELECT uses 'view'; INSERT/UPDATE/DELETE use the matching
-- write perm. Independent creators (target = auth.uid()) are unaffected because
-- can_act_for short-circuits true for self.

-- wheels (edit_wheel)
drop policy if exists wheels_rw on public.wheels;
drop policy if exists wheels_select on public.wheels;
drop policy if exists wheels_write on public.wheels;
create policy wheels_select on public.wheels for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy wheels_write on public.wheels for all
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin())
  with check (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

-- prizes inherit via their wheel's creator; keep simple: tie to wheel ownership.
drop policy if exists prizes_rw on public.prizes;
drop policy if exists prizes_select on public.prizes;
drop policy if exists prizes_write on public.prizes;
create policy prizes_select on public.prizes for select
  using (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'view') or public.is_admin())));
create policy prizes_write on public.prizes for all
  using (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'edit_wheel') or public.is_admin())))
  with check (exists(select 1 from public.wheels w where w.id = wheel_id
                 and (public.can_act_for(w.creator_id,'edit_wheel') or public.is_admin())));

-- fans (view; edits via manage)
drop policy if exists fans_rw on public.fans;
create policy fans_select on public.fans for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy fans_write on public.fans for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- fan_passes (view; create/edit via grant — minting a link is part of granting)
drop policy if exists fan_passes_rw on public.fan_passes;
create policy fan_passes_select on public.fan_passes for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy fan_passes_write on public.fan_passes for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- campaigns (edit_wheel-level config)
drop policy if exists campaigns_rw on public.campaigns;
create policy campaigns_select on public.campaigns for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy campaigns_write on public.campaigns for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- redemptions (fulfil)
drop policy if exists redemptions_rw on public.redemptions;
create policy redemptions_select on public.redemptions for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy redemptions_write on public.redemptions for all
  using (public.can_act_for(creator_id, 'fulfil') or public.is_admin())
  with check (public.can_act_for(creator_id, 'fulfil') or public.is_admin());

-- grants (grant — money in)
drop policy if exists grants_rw on public.grants;
create policy grants_select on public.grants for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy grants_write on public.grants for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- messages (chat)
drop policy if exists messages_rw on public.messages;
create policy messages_select on public.messages for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
create policy messages_write on public.messages for all
  using (public.can_act_for(creator_id, 'chat') or public.is_admin())
  with check (public.can_act_for(creator_id, 'chat') or public.is_admin());

-- ── Org roll-up stats (generalized admin_account_stats, scoped to an org) ────
create or replace function public.org_account_stats(p_org uuid)
returns table (
  id uuid, email text, display_name text, role app_role, is_active boolean,
  features jsonb, wheels bigint, fans bigint, spins bigint, pending bigint,
  revenue bigint
)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.role, p.is_active, p.features,
         (select count(*) from public.wheels w where w.creator_id = p.id),
         (select count(*) from public.fans f where f.creator_id = p.id),
         (select count(*) from public.spins s where s.creator_id = p.id),
         (select count(*) from public.redemptions r where r.creator_id = p.id and r.status = 'pending'),
         (select coalesce(sum(g.amount_cents),0) from public.grants g where g.creator_id = p.id)
    from public.profiles p
   where p.org_id = p_org
     and (
       exists(select 1 from public.orgs o where o.id = p_org and o.owner_id = auth.uid())
       or exists(select 1 from public.org_members m where m.org_id = p_org and m.profile_id = auth.uid())
       or public.is_admin()
     );
$$;

-- ============================================================
-- 0015_autopilot.sql
-- ============================================================
-- Phase 8B — Autopilot: remember which action cards a creator dismissed/snoozed
-- so the daily feed doesn't nag. Keyed by a stable dedupe_key per card.
create table if not exists public.autopilot_dismissals (
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  dedupe_key  text not null,
  snooze_until timestamptz,         -- null = dismissed for good
  created_at  timestamptz not null default now(),
  primary key (creator_id, dedupe_key)
);
alter table public.autopilot_dismissals enable row level security;
drop policy if exists autopilot_dismissals_rw on public.autopilot_dismissals;
create policy autopilot_dismissals_rw on public.autopilot_dismissals for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());

-- ============================================================
-- 0016_fan_view.sql
-- ============================================================
-- Phase 8C — fan-view delight
-- A personal creator note + avatar shown atop the fan's spin page (parasocial
-- warmth converts). Plus a self-update RPC (profiles_update is admin-only).
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists creator_note text;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = nullif(trim(p_note), ''),
         avatar_url    = nullif(trim(p_avatar), '')
   where id = auth.uid();
end;
$$;

-- ============================================================
-- 0017_agency_manage.sql
-- ============================================================
-- Phase 8A (cont.) — agency seat management RPCs. All owner-guarded and
-- SECURITY DEFINER so they can resolve emails + write profiles.org_id (which is
-- otherwise admin-only) without loosening table RLS. Every write checks the
-- caller owns the target org.

-- Create an org owned by the caller. Idempotent-ish: returns the caller's
-- existing owned org if they already have one.
create or replace function public.org_create(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.orgs where owner_id = auth.uid() limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.orgs (name, owner_id)
    values (coalesce(nullif(trim(p_name), ''), 'My agency'), auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

-- Helper: does the caller own this org?
create or replace function public._owns_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.orgs where id = p_org and owner_id = auth.uid());
$$;

-- Add a creator account to the org by email. Guard: caller owns the org AND the
-- target creator isn't already in some other org (prevents poaching).
create or replace function public.org_add_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) limit 1;
  if v_creator is null then return 'no_such_user'; end if;
  if v_org is not null and v_org <> p_org then return 'already_in_org'; end if;
  update public.profiles set org_id = p_org where id = v_creator;
  return 'ok';
end;
$$;

-- Remove a creator from the org (only if it's this org).
create or replace function public.org_remove_creator(p_org uuid, p_creator uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  update public.profiles set org_id = null where id = p_creator and org_id = p_org;
  return 'ok';
end;
$$;

-- Add a staff seat by email with a role.
create or replace function public.org_add_member(p_org uuid, p_email text, p_role org_role)
returns text language plpgsql security definer set search_path = public as $$
declare v_profile uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id into v_profile from public.profiles
   where lower(email) = lower(trim(p_email)) limit 1;
  if v_profile is null then return 'no_such_user'; end if;
  insert into public.org_members (org_id, profile_id, role)
    values (p_org, v_profile, p_role)
    on conflict (org_id, profile_id) do update set role = excluded.role;
  return 'ok';
end;
$$;

create or replace function public.org_remove_member(p_member uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                 where m.id = p_member and o.owner_id = auth.uid()) then
    return 'not_owner';
  end if;
  delete from public.org_members where id = p_member;
  return 'ok';
end;
$$;

-- Scope (or unscope) a seat to a specific creator in the org.
create or replace function public.org_scope_creator(p_member uuid, p_creator uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                 where m.id = p_member and o.owner_id = auth.uid()) then
    return 'not_owner';
  end if;
  if p_on then
    insert into public.org_member_creators (member_id, creator_id)
      values (p_member, p_creator) on conflict do nothing;
  else
    delete from public.org_member_creators where member_id = p_member and creator_id = p_creator;
  end if;
  return 'ok';
end;
$$;

-- ============================================================
-- 0018_agency_invites.sql
-- ============================================================
-- Phase 8A (cont.) — creator invite & consent. A creator's account + data must
-- NOT join an agency without the creator's explicit acceptance. Owners send an
-- invite; the creator accepts/declines from their own dashboard. (Staff seats
-- stay owner-direct — the owner is granting access to their OWN org's data.)

create table if not exists public.org_invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  email      text not null,                       -- lowercased target email
  status     text not null default 'pending',     -- pending|accepted|declined|revoked
  created_at timestamptz not null default now(),
  unique (org_id, email)
);
create index if not exists org_invites_email_idx on public.org_invites(lower(email));

alter table public.org_invites enable row level security;

-- Owner manages invites for their org; the invited creator can read their own
-- (matched by their profile email). Mutations go through SECURITY DEFINER RPCs.
drop policy if exists org_invites_owner on public.org_invites;
create policy org_invites_owner on public.org_invites for all
  using (public._owns_org(org_id) or public.is_admin())
  with check (public._owns_org(org_id) or public.is_admin());

drop policy if exists org_invites_invitee_read on public.org_invites;
create policy org_invites_invitee_read on public.org_invites for select
  using (lower(email) = lower((select email from public.profiles where id = auth.uid())));

-- Owner sends a creator invite. Guards: owns org, target exists, target isn't
-- already in another org. Re-inviting refreshes a non-accepted invite.
create or replace function public.org_invite_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) limit 1;
  if v_creator is null then return 'no_such_user'; end if;
  if v_org is not null then
    return case when v_org = p_org then 'already_in_org' else 'already_in_org' end;
  end if;
  insert into public.org_invites (org_id, email, status)
    values (p_org, lower(trim(p_email)), 'pending')
    on conflict (org_id, email)
      do update set status = 'pending', created_at = now()
      where org_invites.status <> 'accepted';
  return 'ok';
end;
$$;

-- The invited creator accepts or declines. On accept we re-check their org_id is
-- still null (no silent overwrite) and join them to the org.
create or replace function public.org_invite_respond(p_invite uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_inv record; v_my_email text; v_my_org uuid;
begin
  select email, org_id into v_my_email, v_my_org from public.profiles where id = auth.uid();
  select * into v_inv from public.org_invites where id = p_invite;
  if v_inv is null then return 'gone'; end if;
  if lower(v_inv.email) <> lower(coalesce(v_my_email, '')) then return 'not_invitee'; end if;
  if v_inv.status <> 'pending' then return 'gone'; end if;

  if p_accept then
    if v_my_org is not null then return 'already_in_org'; end if;
    update public.profiles set org_id = v_inv.org_id where id = auth.uid();
    update public.org_invites set status = 'accepted' where id = p_invite;
  else
    update public.org_invites set status = 'declined' where id = p_invite;
  end if;
  return 'ok';
end;
$$;

-- Owner withdraws a pending invite.
create or replace function public.org_invite_revoke(p_invite uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.org_invites i where i.id = p_invite and public._owns_org(i.org_id)) then
    return 'not_owner';
  end if;
  delete from public.org_invites where id = p_invite;
  return 'ok';
end;
$$;

-- ============================================================
-- 0019_avatars_storage.sql
-- ============================================================
-- Avatar uploads: a public Storage bucket for creator profile photos. Uploads
-- happen server-side with the service-role key (so no per-object RLS is needed);
-- the bucket is public-read because avatars are shown on fans' spin pages.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- ============================================================
-- 0020_per_wheel_spins.sql
-- ============================================================
-- Per-wheel spins: spins belong to the wheel/campaign they were bought for.
-- Each fan_pass (one per wheel link) now holds its OWN balance; the fan's
-- spins_remaining stays as a maintained sum across passes so existing
-- aggregate reads keep working. Backwards-compatible on upgrade.

alter table public.fan_passes add column if not exists spins_remaining int not null default 0;
alter table public.fan_passes add column if not exists spins_granted_total int not null default 0;
alter table public.grants add column if not exists fan_pass_id uuid references public.fan_passes(id) on delete set null;

-- Backfill: move each fan's existing balance onto their OLDEST pass (the link
-- they've been using), so nothing is lost when this migration runs.
with ranked as (
  select id, fan_id,
         row_number() over (partition by fan_id order by created_at asc) as rn
    from public.fan_passes
)
update public.fan_passes fp
   set spins_remaining = f.spins_remaining,
       spins_granted_total = f.spins_granted_total
  from ranked r
  join public.fans f on f.id = r.fan_id
 where fp.id = r.id and r.rn = 1;

-- Attribute existing grants to each fan's oldest pass (best effort).
update public.grants g
   set fan_pass_id = (
     select id from public.fan_passes fp
      where fp.fan_id = g.fan_id
      order by created_at asc limit 1
   )
 where g.fan_pass_id is null;

-- Rebuild claim_spin to decrement THIS pass's balance (per-wheel), keep the
-- fan-level aggregate in sync, and preserve the rate limit + block / self-
-- exclude guards from 0012.
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_recent integer;
  remaining integer;
  p_max integer := 8;                       -- max spins per window
  p_window interval := interval '10 seconds';
begin
  select fp.fan_id into v_fan
    from public.fan_passes fp
    join public.fans f on f.id = fp.fan_id
   where fp.token = p_token
     and fp.is_active = true
     and fp.self_excluded_at is null
     and f.blocked_at is null;
  if v_fan is null then
    return null; -- bad/inactive/blocked/self-excluded token
  end if;

  -- Rolling-window rate limit (counts this fan's recent spins across all wheels).
  select count(*) into v_recent
    from public.spins
   where fan_id = v_fan and created_at > now() - p_window;
  if v_recent >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  end if;

  -- Decrement THIS wheel's pass balance.
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Keep the fan-level aggregate (sum of passes) in sync.
  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

-- ============================================================
-- 0021_onboarding_dismissed.sql
-- ============================================================
alter table public.profiles
  add column if not exists onboarding_dismissed boolean not null default false;

create or replace function public.set_onboarding_dismissed(p_dismissed boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set onboarding_dismissed = p_dismissed where id = auth.uid();
$$;
