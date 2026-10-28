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

drop policy if exists webhooks_rw on public.webhooks;
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
drop policy if exists fans_select on public.fans;
create policy fans_select on public.fans for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists fans_write on public.fans;
create policy fans_write on public.fans for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- fan_passes (view; create/edit via grant — minting a link is part of granting)
drop policy if exists fan_passes_rw on public.fan_passes;
drop policy if exists fan_passes_select on public.fan_passes;
create policy fan_passes_select on public.fan_passes for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists fan_passes_write on public.fan_passes;
create policy fan_passes_write on public.fan_passes for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- campaigns (edit_wheel-level config)
drop policy if exists campaigns_rw on public.campaigns;
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns for all
  using (public.can_act_for(creator_id, 'manage') or public.is_admin())
  with check (public.can_act_for(creator_id, 'manage') or public.is_admin());

-- redemptions (fulfil)
drop policy if exists redemptions_rw on public.redemptions;
drop policy if exists redemptions_select on public.redemptions;
create policy redemptions_select on public.redemptions for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists redemptions_write on public.redemptions;
create policy redemptions_write on public.redemptions for all
  using (public.can_act_for(creator_id, 'fulfil') or public.is_admin())
  with check (public.can_act_for(creator_id, 'fulfil') or public.is_admin());

-- grants (grant — money in)
drop policy if exists grants_rw on public.grants;
drop policy if exists grants_select on public.grants;
create policy grants_select on public.grants for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists grants_write on public.grants;
create policy grants_write on public.grants for all
  using (public.can_act_for(creator_id, 'grant') or public.is_admin())
  with check (public.can_act_for(creator_id, 'grant') or public.is_admin());

-- messages (chat)
drop policy if exists messages_rw on public.messages;
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());
drop policy if exists messages_write on public.messages;
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

-- ============================================================
-- 0022_commit_reveal.sql
-- ============================================================
alter table public.fan_passes add column if not exists next_server_seed text;
alter table public.fan_passes add column if not exists next_server_seed_hash text;
alter table public.spins add column if not exists client_seed text;

-- ============================================================
-- 0023_chat_settings_rpc.sql
-- ============================================================
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid();
$$;
grant execute on function public.set_chat_settings(text, text) to authenticated;
grant execute on function public.set_leaderboard_enabled(boolean) to authenticated;
grant execute on function public.set_onboarding_dismissed(boolean) to authenticated;

-- ============================================================
-- 0024_referral_spins_on_pass.sql
-- ============================================================
-- Make per-wheel spin balances authoritative and heal drifted counts. Some DBs
-- (set up from schema.sql) had a claim_spin that decremented the FAN aggregate
-- but never the per-wheel PASS the fan page displays, so the pass over-counted
-- (shows 3) while the aggregate was right (2), only "fixing itself" on a spin.
-- Installs the correct pass-decrementing claim_spin, reconciles balances from
-- real spin history, and credits referral bonuses onto a spendable pass.
create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_recent integer;
  remaining integer;
  p_max integer := 8;
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
    return null;
  end if;

  select count(*) into v_recent
    from public.spins
   where fan_id = v_fan and created_at > now() - p_window;
  if v_recent >= p_max then
    return -1;
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null;
  end if;

  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining;
end;
$$;

-- Heal existing pass balances from real spin history (granted minus taken).
update public.fan_passes p
   set spins_remaining = greatest(0, p.spins_granted_total - coalesce(s.cnt, 0))
  from (
    select fan_pass_id, count(*)::int as cnt
      from public.spins
     where fan_pass_id is not null
     group by fan_pass_id
  ) s
 where s.fan_pass_id = p.id;

-- Snap every fan aggregate to the sum of its active passes.
update public.fans f
   set spins_remaining = coalesce((
         select sum(p.spins_remaining) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0),
       spins_granted_total = coalesce((
         select sum(p.spins_granted_total) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0)
 where exists (
   select 1 from public.fan_passes p where p.fan_id = f.id and p.is_active
 );

create or replace function public.credit_pass_spins(p_fan_id uuid, p_spins int)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_pass uuid;
begin
  if p_spins is null or p_spins <= 0 then
    return;
  end if;

  select id into v_pass
    from public.fan_passes
   where fan_id = p_fan_id and is_active = true
   order by created_at asc
   limit 1;
  if v_pass is null then
    return;
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining + p_spins,
         spins_granted_total = spins_granted_total + p_spins
   where id = v_pass;

  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0)
   where f.id = p_fan_id;
end;
$$;

-- ============================================================
-- 0025_account_settings.sql
-- ============================================================
alter table public.wheels
  add column if not exists label_color text;

alter table public.profiles
  add column if not exists notify_new_spin boolean not null default true;
alter table public.profiles
  add column if not exists notify_low_balance boolean not null default true;
alter table public.profiles
  add column if not exists notify_messages boolean not null default true;

create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set display_name = coalesce(nullif(trim(p_name), ''), display_name)
   where id = auth.uid();
$$;

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

grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean) to authenticated;

-- 0026 Atomic admin account-deletion reservation (multi-review #2): make the
-- last-admin guard atomic (lock admin rows; refuse if last, else demote target).
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;

grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;

-- 0027 Lock server-only balance RPCs to service_role (multi-review Audit 2): they
-- were PUBLIC-executable (no grant), so anon could mint spins / bypass /api/spin.
revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;
revoke execute on function public.credit_pass_spins(uuid, int) from public, anon, authenticated;
grant  execute on function public.credit_pass_spins(uuid, int) to service_role;

-- 0028 Atomic per-fan spin rate limit (multi-review #1): in-row fixed-window
-- counter under FOR UPDATE replaces the race-prone spins-table count in claim_spin.
alter table public.fans
  add column if not exists rl_window_start timestamptz,
  add column if not exists rl_count int not null default 0;

create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_win_start timestamptz;
  v_win_count int;
  remaining integer;
  p_max integer := 8;
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
    return null;
  end if;

  select rl_window_start, rl_count into v_win_start, v_win_count
    from public.fans where id = v_fan for update;
  if v_win_start is null or now() - v_win_start > p_window then
    update public.fans set rl_window_start = now(), rl_count = 1 where id = v_fan;
  elsif v_win_count >= p_max then
    return -1;
  else
    update public.fans set rl_count = rl_count + 1 where id = v_fan;
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null;
  end if;

  update public.fans
     set spins_remaining = greatest(0, spins_remaining - 1),
         last_spin_at = now()
   where id = v_fan;

  return remaining;
end;
$$;

revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;

-- 0029 Block suspended creators (is_active=false) from self-updating public fields.
create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug = nullif(trim(p_slug), ''),
         tip_url = nullif(trim(p_tip_url), ''),
         public_tagline = nullif(trim(p_tagline), '')
   where id = auth.uid() and is_active = true;
end;
$$;
create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = nullif(trim(p_note), ''),
         avatar_url = nullif(trim(p_avatar), '')
   where id = auth.uid() and is_active = true;
end;
$$;
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true;
$$;
grant execute on function public.set_chat_settings(text, text) to authenticated;

-- 0030 Close the org_add_creator consent-bypass: the app uses the invite flow;
-- lock the legacy force-add RPC to service_role only.
revoke execute on function public.org_add_creator(uuid, text) from public, anon, authenticated;
grant  execute on function public.org_add_creator(uuid, text) to service_role;

-- 0031 Suspended admins lose deletion power at the DB layer too: the atomic
-- last-admin guard now requires the caller to be an ACTIVE admin (is_active),
-- mirroring public.is_admin(). The API route checks is_active as well.
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;
grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;

-- 0032 Enforce is_active in creator RLS. Suspension was cosmetic: creator-owned
-- policies authorized on creator_id = auth.uid() without checking is_active, so a
-- suspended creator kept reading/mutating their own data. is_admin() already
-- required is_active; extend the same to creators.
create or replace function public.current_user_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and is_active);
$$;

create or replace function public.can_act_for(target_creator uuid, perm text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_role org_role;
  v_member uuid;
  v_scoped boolean;
begin
  -- A suspended caller loses every write/act perm; 'view' stays so a suspended
  -- creator can load a read-only dashboard.
  if perm <> 'view' and not exists (
    select 1 from public.profiles where id = auth.uid() and is_active
  ) then
    return false;
  end if;
  if target_creator = auth.uid() then
    return true;
  end if;
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid() and p.org_id = o.id
   limit 1;
  if v_member is null then
    return false;
  end if;
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

drop policy if exists dm_templates_rw on public.dm_templates;
create policy dm_templates_rw on public.dm_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists campaign_packs_rw on public.campaign_packs;
create policy campaign_packs_rw on public.campaign_packs for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists prize_templates_rw on public.prize_templates;
create policy prize_templates_rw on public.prize_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists wheel_templates_rw on public.wheel_templates;
create policy wheel_templates_rw on public.wheel_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists wishlists_rw on public.wishlists;
create policy wishlists_rw on public.wishlists for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists referrals_rw on public.referrals;
create policy referrals_rw on public.referrals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists webhooks_rw on public.webhooks;
create policy webhooks_rw on public.webhooks for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
drop policy if exists autopilot_dismissals_rw on public.autopilot_dismissals;
create policy autopilot_dismissals_rw on public.autopilot_dismissals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

-- ============================================================
-- 0033_resync_fan_spin_aggregate.sql
-- ============================================================
-- One-time, idempotent heal: snap each fan's spins_remaining / spins_granted_total
-- back to the sum of their active passes, repairing any historical drift. Safe to
-- re-run; claim_spin and the grant/credit RPCs keep them in sync going forward.
update public.fans f
   set spins_remaining = coalesce((
         select sum(p.spins_remaining) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0),
       spins_granted_total = coalesce((
         select sum(p.spins_granted_total) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0)
 where exists (
   select 1 from public.fan_passes p where p.fan_id = f.id and p.is_active
 );


-- ============================================================
-- Synced from migrations/ (effective definitions) so the SQL-sync
-- guard holds after rebasing onto the latest migrations.
-- ============================================================

create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true;
end;
$$;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true;
end;
$$;

create or replace function public.sync_fan_spin_aggregate()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid := coalesce(new.fan_id, old.fan_id);
begin
  if v_fan is null then
    return null;
  end if;
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0)
   where f.id = v_fan;
  return null; -- AFTER trigger; updates fans (not fan_passes) so no recursion
end;
$$;

create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
  );
$$;

create or replace function public.import_fans(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid := auth.uid();
begin
  if v_creator is null then
    raise exception 'unauthorized';
  end if;

  -- SECURITY DEFINER bypasses RLS, so verify the caller owns every referenced
  -- wheel and campaign before inserting anything that points at them.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where not exists (
      select 1 from public.wheels w
       where w.id = (r->>'wheel_id')::uuid and w.creator_id = v_creator
    )
  ) then
    raise exception 'wheel_not_owned';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (r->>'campaign_id') is not null
      and not exists (
        select 1 from public.campaigns c
         where c.id = (r->>'campaign_id')::uuid and c.creator_id = v_creator
      )
  ) then
    raise exception 'campaign_not_owned';
  end if;

  insert into public.fans (id, creator_id, display_name, spins_remaining, spins_granted_total)
  select (r->>'fan_id')::uuid, v_creator,
         coalesce(nullif(r->>'name', ''), 'Fan'),
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.fan_passes
         (id, token, creator_id, wheel_id, fan_id, campaign_id, spins_remaining, spins_granted_total)
  select (r->>'pass_id')::uuid, r->>'token', v_creator,
         (r->>'wheel_id')::uuid, (r->>'fan_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.grants
         (creator_id, fan_id, fan_pass_id, campaign_id, spins, amount_cents, bonus_spins)
  select v_creator, (r->>'fan_id')::uuid, (r->>'pass_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'amount_cents')::int, 0
    from jsonb_array_elements(p_rows) r;
end;
$$;

grant execute on function public.import_fans(jsonb) to authenticated;


-- ============================================================
-- Synced from migrations/ (effective definitions) so the SQL-sync
-- guard holds after rebasing onto the latest migrations.
-- ============================================================

create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_win_start timestamptz;
  v_win_count int;
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

  -- Atomic rate limit: lock the fan row so concurrent claims serialize, then
  -- enforce a fixed-window counter held IN-ROW (independent of the post-hoc
  -- public.spins insert that made the old rolling count race-prone).
  select rl_window_start, rl_count into v_win_start, v_win_count
    from public.fans where id = v_fan for update;
  if v_win_start is null or now() - v_win_start > p_window then
    update public.fans set rl_window_start = now(), rl_count = 1 where id = v_fan;
  elsif v_win_count >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  else
    update public.fans set rl_count = rl_count + 1 where id = v_fan;
  end if;

  -- Decrement THIS wheel's pass balance (row-locked; can't go below 0).
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Touch ONLY last_spin_at here. trg_sync_fan_spin_aggregate (0025) already set
  -- fans.spins_remaining to the new sum of passes after the decrement above;
  -- decrementing it again would double-count.
  update public.fans set last_spin_at = now() where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

-- ============================================================
-- Wire the fan-spin aggregate trigger (0025). The function above is inert
-- without this; a fresh DB must create the trigger too, or fans.spins_remaining
-- never auto-syncs (and the migrated DB would behave differently).
-- ============================================================
drop trigger if exists trg_sync_fan_spin_aggregate on public.fan_passes;
create trigger trg_sync_fan_spin_aggregate
  after insert or delete
     or update of spins_remaining, spins_granted_total, is_active, fan_id
  on public.fan_passes
  for each row execute function public.sync_fan_spin_aggregate();

-- ============================================================
-- 0036_pipeline_probe.sql
-- ============================================================
comment on schema public is 'fanfunnel — migration pipeline verified (0036 probe)';

-- ============================================================
-- 0037_wheel_label_size.sql
-- ============================================================
alter table public.wheels add column if not exists label_color text;
alter table public.wheels add column if not exists label_size text;

-- ============================================================
-- 0038_rollback_claimed_spin.sql
-- ============================================================
create or replace function public.rollback_claimed_spin(p_token text, p_prize_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.fan_passes
     set spins_remaining = spins_remaining + 1
   where token = p_token;
  if p_prize_id is not null then
    update public.prizes
       set stock = stock + 1
     where id = p_prize_id and stock is not null;
  end if;
end;
$$;

revoke execute on function public.rollback_claimed_spin(text, uuid) from public, anon, authenticated;

-- ============================================================
-- 0039_fan_pass_balance_check.sql
-- ============================================================
-- fan_passes.spins_remaining >= 0. Add NOT VALID (new writes checked), clamp any
-- pre-existing negative rows to 0 (already unspendable), then VALIDATE.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'fan_passes_spins_remaining_check'
       and conrelid = 'public.fan_passes'::regclass
  ) then
    alter table public.fan_passes
      add constraint fan_passes_spins_remaining_check
      check (spins_remaining >= 0) not valid;
  end if;
end;
$$;

update public.fan_passes
   set spins_remaining = 0
 where spins_remaining < 0;

alter table public.fan_passes
  validate constraint fan_passes_spins_remaining_check;

-- ============================================================
-- 0040_leaderboard_optin_reset.sql
-- ============================================================
-- Fan leaderboard privacy: spin() used to set fans.leaderboard_opt_in = true on
-- a fan's first spin, so every fan who ever spun is marked as consenting to a
-- public page they never saw a control for. Clear those flags — only where the
-- fan has no board handle (opting in now requires one, so a handle marks a
-- deliberate choice); fans re-consent via the toggle on their spin page.
-- Re-run safe. No schema/RLS/grant change.
update public.fans
   set leaderboard_opt_in = false
 where leaderboard_opt_in
   and (handle is null or btrim(handle) = '');

-- ============================================================
-- 0041_spin_seed_commitment.sql
-- ============================================================
alter table public.spins add column if not exists seed_commitment text
  check (seed_commitment is null or seed_commitment in ('published', 'stored', 'fresh'));

-- ============================================================
-- 0042_reconcile_drift.sql
-- ============================================================
-- Drift repair for the LIVE databases: migration files were edited after they
-- had been applied, and db push never re-applies a recorded version, so TEST and
-- PROD missed those edits. This re-asserts the final definitions of the drifted
-- objects (profiles.notify_* columns, 11 functions + their grants, the fan-spin
-- aggregate trigger, org_invites + policies, the 0032 *_rw policies) and drops
-- the owner-only *_rw policies 0014 replaced. A no-op on a database built from
-- this file. See migrations/0042_reconcile_drift.sql for the full list.
-- 1. Columns (0025_account_settings). They come first: set_notification_prefs
--    is LANGUAGE sql, so its body is checked against them at create time.
alter table public.profiles
  add column if not exists notify_new_spin boolean not null default true;
alter table public.profiles
  add column if not exists notify_low_balance boolean not null default true;
alter table public.profiles
  add column if not exists notify_messages boolean not null default true;

-- 2. Functions, final definitions.
-- current_user_active (0032): the active-state gate the *_rw policies call.
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
  );
$$;

-- set_display_name / set_notification_prefs (0025): self-only profile updates.
create or replace function public.set_display_name(p_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set display_name = coalesce(nullif(trim(p_name), ''), display_name)
   where id = auth.uid();
$$;

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

grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean) to authenticated;

-- set_chat_settings (0029): self-only, and refused for a suspended account.
create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true;
$$;

grant execute on function public.set_chat_settings(text, text) to authenticated;

-- credit_pass_spins (0024): referral bonus credit. SERVER-ONLY (0027).
create or replace function public.credit_pass_spins(p_fan_id uuid, p_spins int)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_pass uuid;
begin
  if p_spins is null or p_spins <= 0 then
    return;
  end if;

  -- Oldest active pass = the fan's original link (matches the 0020 backfill).
  select id into v_pass
    from public.fan_passes
   where fan_id = p_fan_id and is_active = true
   order by created_at asc
   limit 1;
  if v_pass is null then
    return; -- no active pass to credit; nothing spendable to add to
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining + p_spins,
         spins_granted_total = spins_granted_total + p_spins
   where id = v_pass;

  -- Keep the fan-level aggregate exactly equal to the sum of passes.
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0)
   where f.id = p_fan_id;
end;
$$;

revoke execute on function public.credit_pass_spins(uuid, int) from public, anon, authenticated;
grant  execute on function public.credit_pass_spins(uuid, int) to service_role;

-- sync_fan_spin_aggregate + its trigger (0035): fans.spins_remaining is the sum
-- of the fan's active passes. Drop + create (one transaction) re-wires the
-- trigger with the final definition whether it was present, stale or missing.
create or replace function public.sync_fan_spin_aggregate()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid := coalesce(new.fan_id, old.fan_id);
begin
  if v_fan is null then
    return null;
  end if;
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = v_fan and p.is_active), 0)
   where f.id = v_fan;
  return null; -- AFTER trigger; updates fans (not fan_passes) so no recursion
end;
$$;

drop trigger if exists trg_sync_fan_spin_aggregate on public.fan_passes;
create trigger trg_sync_fan_spin_aggregate
  after insert or delete
     or update of spins_remaining, spins_granted_total, is_active, fan_id
  on public.fan_passes
  for each row execute function public.sync_fan_spin_aggregate();

-- admin_reserve_account_deletion (0031): only an ACTIVE admin may reserve.
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an ACTIVE admin (defense in depth; the route checks too).
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  -- Lock the target row; missing => not found.
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    -- Lock ALL admin rows so concurrent reservations serialize here.
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    -- Atomic reservation: demote so a concurrent call sees one fewer admin.
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;

grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;

-- handle_new_user (0011): new signups land as approval_status = 'pending'.
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

-- 3. org_invites (0018_agency_invites): creator invite & consent, exactly as
--    0018 defines it (no later migration changes it; 0030 only locks the
--    separate org_add_creator).
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

drop policy if exists org_invites_owner on public.org_invites;
create policy org_invites_owner on public.org_invites for all
  using (public._owns_org(org_id) or public.is_admin())
  with check (public._owns_org(org_id) or public.is_admin());

drop policy if exists org_invites_invitee_read on public.org_invites;
create policy org_invites_invitee_read on public.org_invites for select
  using (lower(email) = lower((select email from public.profiles where id = auth.uid())));

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

-- 4. Creator-config *_rw policies, final 0032 shape: the self branch requires
--    an active account; admins keep access via is_admin() (also active-only).
drop policy if exists dm_templates_rw on public.dm_templates;
create policy dm_templates_rw on public.dm_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists campaign_packs_rw on public.campaign_packs;
create policy campaign_packs_rw on public.campaign_packs for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists prize_templates_rw on public.prize_templates;
create policy prize_templates_rw on public.prize_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wheel_templates_rw on public.wheel_templates;
create policy wheel_templates_rw on public.wheel_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wishlists_rw on public.wishlists;
create policy wishlists_rw on public.wishlists for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists referrals_rw on public.referrals;
create policy referrals_rw on public.referrals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists webhooks_rw on public.webhooks;
create policy webhooks_rw on public.webhooks for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists autopilot_dismissals_rw on public.autopilot_dismissals;
create policy autopilot_dismissals_rw on public.autopilot_dismissals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

-- 5. Owner-only policies that 0014 replaced with *_select / *_write. The repo's
--    final state has no policy of these names, so none may remain.
drop policy if exists wheels_rw on public.wheels;
drop policy if exists prizes_rw on public.prizes;
drop policy if exists fans_rw on public.fans;
drop policy if exists fan_passes_rw on public.fan_passes;
drop policy if exists campaigns_rw on public.campaigns;
drop policy if exists redemptions_rw on public.redemptions;
drop policy if exists grants_rw on public.grants;
drop policy if exists messages_rw on public.messages;

-- 0043_notifications_seen.sql
-- ============================================================
-- Notification bell: per-account "seen" marker (RD-7). The feed is derived on
-- read; unread = after the creator last opened the bell. profiles_update is
-- admin-only, so a narrow SECURITY DEFINER helper stamps now() on the caller's
-- own row only (no arguments: the client can't pick the time).
alter table public.profiles
  add column if not exists notifications_seen_at timestamptz;

create or replace function public.set_notifications_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set notifications_seen_at = now() where id = auth.uid();
$$;

revoke execute on function public.set_notifications_seen() from public, anon;
grant execute on function public.set_notifications_seen() to authenticated;

-- 0044_revoke_anon_setters.sql
-- ============================================================
-- Revoke anon EXECUTE on the self-service RPCs (RD-8). The app calls them only
-- through the signed-in session client; authenticated keeps EXECUTE. Policy
-- helpers (is_admin, can_act_for, current_user_active, _owns_org) stay callable
-- by anon because RLS evaluates them. See migrations/0044 for the full notes.
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

-- 0045_spins_fan_id_index.sql
-- ============================================================
-- Index spins by fan: every fan page load reads the history with
-- "where fan_id = $1 order by created_at desc limit 50". The composite also
-- serves plain fan_id filters and the fans -> spins FK. See migrations/0045.
create index if not exists spins_fan_created_idx on public.spins (fan_id, created_at desc);

-- 0046_pwa_icon_mode.sql
-- ============================================================
-- Home-screen icon for a fan's installed spin link (RM-4, D8): 'neutral' (wheel
-- glyph named "Spins", the default) or 'avatar' (creator photo + name). Written
-- only through a SECURITY DEFINER setter on the caller's own active row
-- (profiles_update stays admin-only); anon cannot execute it. See migrations/0046.
alter table public.profiles
  add column if not exists pwa_icon_mode text not null default 'neutral'
    check (pwa_icon_mode in ('neutral', 'avatar'));

create or replace function public.set_pwa_icon_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_mode is null or p_mode not in ('neutral', 'avatar') then
    raise exception 'invalid pwa_icon_mode' using errcode = '22023';
  end if;
  update public.profiles set pwa_icon_mode = p_mode
   where id = auth.uid() and is_active = true;
end;
$$;

revoke execute on function public.set_pwa_icon_mode(text) from public, anon;
grant execute on function public.set_pwa_icon_mode(text) to authenticated;

-- 0047_fairness_v3.sql
-- ============================================================
-- Fairness v3: each spin records its canonical prize-pool snapshot (fan-safe
-- fields only) and its SHA-256, mixed into the RNG, plus the sold-out re-draws
-- (fair_trace) so /verify can replay the draw. fair_version NULL = v1/v2.
-- Columns only; no function changes. See migrations/0047.
alter table public.spins add column if not exists fair_version smallint
  check (fair_version is null or fair_version in (1, 2, 3));
alter table public.spins add column if not exists pool_snapshot jsonb;
alter table public.spins add column if not exists pool_hash text
  check (pool_hash is null or pool_hash ~ '^[0-9a-f]{64}$');
alter table public.spins add column if not exists fair_trace jsonb;
alter table public.spins drop constraint if exists spins_fair_v3_complete;
alter table public.spins add constraint spins_fair_v3_complete
  check (fair_version is distinct from 3
         or (pool_snapshot is not null and pool_hash is not null and fair_trace is not null));

-- 0048_wheel_show_stock.sql
-- ============================================================
-- Per-wheel "Show stock to fans" switch (RM-2). Written by the creator through
-- the wheels_rw policy; no new function or grant. See migrations/0048.
alter table public.wheels add column if not exists show_stock boolean not null default true;

-- 0049_play_reminders_breaks.sql
-- ============================================================
-- Spend-awareness guardrail (RM-6): fans.break_until (only the fan sets it,
-- never shortened; trigger-guarded), the fan-private fan_play_reminders table
-- (admin-only read; service-role writes), the server-only fan_take_break(),
-- and claim_spin refusing a spin during a break. See migrations/0049.
alter table public.fans add column if not exists break_until timestamptz;

-- Only the fan (through the server) sets a break, and a break in force only
-- ever gets longer. SECURITY INVOKER on purpose: current_user is the caller's
-- role, so a creator's session (authenticated) is refused while the service
-- role and the SECURITY DEFINER fan_take_break() pass the first check.
create or replace function public.guard_fan_break()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.break_until is distinct from old.break_until then
    if current_user in ('anon', 'authenticated') then
      raise exception 'break_until is set by the fan only' using errcode = '42501';
    end if;
    if old.break_until is not null and old.break_until > now()
       and (new.break_until is null or new.break_until < old.break_until) then
      raise exception 'a break cannot be shortened' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_fan_break on public.fans;
create trigger trg_guard_fan_break
  before update of break_until on public.fans
  for each row execute function public.guard_fan_break();

create table if not exists public.fan_play_reminders (
  fan_id     uuid primary key references public.fans(id) on delete cascade,
  daily      integer not null check (daily between 10 and 500),
  updated_at timestamptz not null default now()
);
alter table public.fan_play_reminders enable row level security;
drop policy if exists fan_play_reminders_admin_read on public.fan_play_reminders;
create policy fan_play_reminders_admin_read on public.fan_play_reminders for select
  using (public.is_admin());

create or replace function public.fan_take_break(p_token text, p_until timestamptz)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if p_until is null or p_until <= now() or p_until > now() + interval '31 days' then
    raise exception 'invalid break end' using errcode = '22023';
  end if;
  update public.fans f
     set break_until = greatest(coalesce(f.break_until, now()), p_until)
    from public.fan_passes fp
   where fp.token = p_token
     and fp.fan_id = f.id
     and fp.is_active = true
     and fp.self_excluded_at is null
     and f.blocked_at is null
  returning f.break_until into v_until;
  return v_until; -- null: no live link for this token
end;
$$;

revoke execute on function public.fan_take_break(text, timestamptz) from public, anon, authenticated;
grant  execute on function public.fan_take_break(text, timestamptz) to service_role;

create or replace function public.claim_spin(p_token text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_fan uuid;
  v_win_start timestamptz;
  v_win_count int;
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
     and f.blocked_at is null
     and (f.break_until is null or f.break_until <= now());
  if v_fan is null then
    return null; -- bad/inactive/blocked/self-excluded token, or on a break
  end if;

  -- Atomic rate limit: lock the fan row so concurrent claims serialize, then
  -- enforce a fixed-window counter held IN-ROW (independent of the post-hoc
  -- public.spins insert that made the old rolling count race-prone).
  select rl_window_start, rl_count into v_win_start, v_win_count
    from public.fans where id = v_fan for update;
  if v_win_start is null or now() - v_win_start > p_window then
    update public.fans set rl_window_start = now(), rl_count = 1 where id = v_fan;
  elsif v_win_count >= p_max then
    return -1; -- sentinel: rate limited (caller maps to HTTP 429)
  else
    update public.fans set rl_count = rl_count + 1 where id = v_fan;
  end if;

  -- Decrement THIS wheel's pass balance (row-locked; can't go below 0).
  update public.fan_passes
     set spins_remaining = spins_remaining - 1,
         last_spin_at = now()
   where token = p_token and spins_remaining > 0
  returning spins_remaining into remaining;

  if remaining is null then
    return null; -- no spins left on this wheel's pass
  end if;

  -- Touch ONLY last_spin_at here. trg_sync_fan_spin_aggregate (0025) already set
  -- fans.spins_remaining to the new sum of passes after the decrement above;
  -- decrementing it again would double-count.
  update public.fans set last_spin_at = now() where id = v_fan;

  return remaining; -- spins left ON THIS PASS
end;
$$;

revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;

-- 0050_fan_checkins.sql
-- ============================================================
-- Fan check-ins for the visit glow (RM-3): one row per fan per day they opened
-- a link. Written only by the server (service role); no insert/update/delete
-- policy, and those privileges are revoked. The owning creator reads them.
-- Never read to grant spins or change odds. See migrations/0050.
create table if not exists public.fan_checkins (
  fan_id     uuid not null references public.fans(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (fan_id, day)
);
create index if not exists fan_checkins_creator_day_idx on public.fan_checkins (creator_id, day);

alter table public.fan_checkins enable row level security;
drop policy if exists fan_checkins_select on public.fan_checkins;
create policy fan_checkins_select on public.fan_checkins for select
  using ((creator_id = auth.uid() and public.current_user_active())
         or public.can_act_for(creator_id, 'view')
         or public.is_admin());

revoke all on table public.fan_checkins from anon;
revoke insert, update, delete, truncate on table public.fan_checkins from authenticated;

-- 0051_fan_outreach.sql
-- ============================================================
-- Win-back outreach log (RM-5): "contacted" (contacted_at) or "snoozed"
-- (snoozed_until only) per fan. Append-only from the client (SELECT + INSERT
-- policies, no UPDATE/DELETE); the insert check pins the fan and any template
-- to the same creator. No function; anon gets nothing. See migrations/0051.
create table if not exists public.fan_outreach (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  fan_id        uuid not null references public.fans(id) on delete cascade,
  template_id   uuid references public.dm_templates(id) on delete set null,
  kind          text not null default 'winback' check (kind in ('winback')),
  contacted_at  timestamptz,
  snoozed_until timestamptz,
  created_at    timestamptz not null default now(),
  constraint fan_outreach_has_action check (contacted_at is not null or snoozed_until is not null)
);
create index if not exists fan_outreach_creator_created_idx
  on public.fan_outreach (creator_id, created_at desc);
create index if not exists fan_outreach_fan_idx on public.fan_outreach (fan_id);

alter table public.fan_outreach enable row level security;

drop policy if exists fan_outreach_select on public.fan_outreach;
create policy fan_outreach_select on public.fan_outreach for select
  using ((public.can_act_for(creator_id, 'view') and public.current_user_active()) or public.is_admin());

drop policy if exists fan_outreach_insert on public.fan_outreach;
create policy fan_outreach_insert on public.fan_outreach for insert
  with check (
    (public.can_act_for(creator_id, 'chat') or public.is_admin())
    and exists (
      select 1 from public.fans f
       where f.id = fan_outreach.fan_id and f.creator_id = fan_outreach.creator_id
    )
    and (
      fan_outreach.template_id is null
      or exists (
        select 1 from public.dm_templates t
         where t.id = fan_outreach.template_id and t.creator_id = fan_outreach.creator_id
      )
    )
  );

revoke all on table public.fan_outreach from anon;

-- 0052_org_rls_and_ledger_checks.sql
-- ============================================================
-- Agency/org RLS without cross-table recursion (SECURITY DEFINER helpers),
-- orgs_read bound to the right id, org_account_stats row-scoped to what a seat
-- may view, every org path requires an active caller; non-negative CHECKs on pass/fan ledgers, rl_count, prize stock and
-- cost (validated only when no row violates them, else dropped with a WARNING;
-- data is never rewritten). See migrations/0052.
-- ── Part 1: org RLS without cross-table recursion ───────────────────────────
-- Every org helper also requires the CALLER's profile to be active, like
-- is_admin() / can_act_for(): a suspended account has no org reach at all.

-- Does the (active) caller own this org? (0017's helper + the active check.)
create or replace function public._owns_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
                 where o.id = p_org and o.owner_id = auth.uid() and p.is_active);
$$;

-- Does the (active) caller hold a seat in this org?
create or replace function public._is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.profiles p on p.id = m.profile_id
                 where m.org_id = p_org and m.profile_id = auth.uid() and p.is_active);
$$;

-- Does the (active) caller own the org this seat belongs to?
create or replace function public._owns_org_seat(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                  join public.profiles p on p.id = o.owner_id
                 where m.id = p_member and o.owner_id = auth.uid() and p.is_active);
$$;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select
  using ((owner_id = auth.uid() and public.current_user_active()) or public._is_org_member(id) or public.is_admin());
drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs for all
  using ((owner_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((owner_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select
  using ((profile_id = auth.uid() and public.current_user_active()) or public._owns_org(org_id) or public.is_admin());
drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for all
  using (public._owns_org(org_id) or public.is_admin())
  with check (public._owns_org(org_id) or public.is_admin());

drop policy if exists omc_rw on public.org_member_creators;
create policy omc_rw on public.org_member_creators for all
  using (public._owns_org_seat(member_id) or public.is_admin())
  with check (public._owns_org_seat(member_id) or public.is_admin());

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
       public._owns_org(p_org)
       or public.is_admin()
       or (public._is_org_member(p_org) and public.can_act_for(p.id, 'view'))
     );
$$;

-- A suspended caller may still VIEW its own account (read-only dashboard), but
-- acting for or viewing ANOTHER creator through an org seat needs an active
-- caller, even for 'view'. Otherwise identical to 0032's can_act_for.
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
  v_active boolean;
begin
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_active
  ) into v_active;

  -- The creator themselves: always 'view'; every mutating perm needs an
  -- active account (a suspended creator gets a read-only dashboard).
  if target_creator = auth.uid() then
    return perm = 'view' or v_active;
  end if;

  -- Reaching another creator through an org seat: never while suspended.
  if not v_active then
    return false;
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

-- A suspended account cannot create an org.
create or replace function public.org_create(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.current_user_active() then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  select id into v_id from public.orgs where owner_id = auth.uid() limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.orgs (name, owner_id)
    values (coalesce(nullif(trim(p_name), ''), 'My agency'), auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

-- Seat removal and scoping: owner check through the active-aware helper.
create or replace function public.org_remove_member(p_member uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public._owns_org_seat(p_member) then
    return 'not_owner';
  end if;
  delete from public.org_members where id = p_member;
  return 'ok';
end;
$$;

create or replace function public.org_scope_creator(p_member uuid, p_creator uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public._owns_org_seat(p_member) then
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

-- A suspended invitee can neither accept (join the org) nor decline.
create or replace function public.org_invite_respond(p_invite uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_inv record; v_my_email text; v_my_org uuid; v_active boolean;
begin
  select email, org_id, is_active into v_my_email, v_my_org, v_active from public.profiles where id = auth.uid();
  if not coalesce(v_active, false) then return 'inactive'; end if;
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

-- ── Part 2: non-negative CHECKs ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fan_passes_spins_granted_total_check'
                  and conrelid = 'public.fan_passes'::regclass) then
    alter table public.fan_passes add constraint fan_passes_spins_granted_total_check
      check (spins_granted_total >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fans_spins_granted_total_check'
                  and conrelid = 'public.fans'::regclass) then
    alter table public.fans add constraint fans_spins_granted_total_check
      check (spins_granted_total >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fans_rl_count_check'
                  and conrelid = 'public.fans'::regclass) then
    alter table public.fans add constraint fans_rl_count_check
      check (rl_count >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prizes_stock_check'
                  and conrelid = 'public.prizes'::regclass) then
    alter table public.prizes add constraint prizes_stock_check
      check (stock >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prizes_cost_cents_check'
                  and conrelid = 'public.prizes'::regclass) then
    alter table public.prizes add constraint prizes_cost_cents_check
      check (cost_cents >= 0) not valid;
  end if;
end;
$$;

do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad from public.fan_passes where spins_granted_total < 0;
  if v_bad = 0 then
    alter table public.fan_passes validate constraint fan_passes_spins_granted_total_check;
  else
    alter table public.fan_passes drop constraint fan_passes_spins_granted_total_check;
    raise warning '0052: % fan_passes row(s) have spins_granted_total < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.fans where spins_granted_total < 0;
  if v_bad = 0 and exists (select 1 from pg_constraint where conname = 'fan_passes_spins_granted_total_check'
                            and conrelid = 'public.fan_passes'::regclass and convalidated) then
    alter table public.fans validate constraint fans_spins_granted_total_check;
  else
    alter table public.fans drop constraint fans_spins_granted_total_check;
    raise warning '0052: fans.spins_granted_total CHECK not added (% negative row(s), or the per-pass CHECK was not added). Fix by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.fans where rl_count < 0;
  if v_bad = 0 then
    alter table public.fans validate constraint fans_rl_count_check;
  else
    alter table public.fans drop constraint fans_rl_count_check;
    raise warning '0052: % fans row(s) have rl_count < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.prizes where stock < 0;
  if v_bad = 0 then
    alter table public.prizes validate constraint prizes_stock_check;
  else
    alter table public.prizes drop constraint prizes_stock_check;
    raise warning '0052: % prizes row(s) have stock < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.prizes where cost_cents < 0;
  if v_bad = 0 then
    alter table public.prizes validate constraint prizes_cost_cents_check;
  else
    alter table public.prizes drop constraint prizes_cost_cents_check;
    raise warning '0052: % prizes row(s) have cost_cents < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;
end;
$$;

-- 0053_app_errors.sql
-- ============================================================
-- In-house error monitoring: grouped, redacted app errors (upsert by
-- environment + fingerprint) and the alert e-mail log behind the global hourly
-- throttle. RLS on both; admins (is_admin()) may read and resolve; writes only
-- via the service-role RPCs, which are revoked from public/anon/authenticated.
-- See migrations/0053.
create table if not exists public.app_errors (
  id            uuid primary key default gen_random_uuid(),
  fingerprint   text not null check (fingerprint ~ '^[0-9a-f]{32,64}$'),
  environment   text not null check (environment in ('production', 'preview', 'development')),
  source        text not null check (source in ('client', 'server')),
  route         text check (char_length(route) <= 512),
  message       text not null check (char_length(message) <= 1000),
  stack         text check (char_length(stack) <= 8000),
  user_agent    text check (char_length(user_agent) <= 256),
  count         integer not null default 1 check (count >= 1),
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  resolved      boolean not null default false,
  resolved_at   timestamptz,
  alert_pending boolean not null default false,
  constraint app_errors_env_fingerprint_key unique (environment, fingerprint)
);
create index if not exists app_errors_last_seen_idx on public.app_errors (last_seen desc);

create table if not exists public.app_error_alerts (
  id      uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  kind    text not null check (kind in ('error', 'digest')),
  errors  integer not null default 1 check (errors >= 1)
);
create index if not exists app_error_alerts_sent_at_idx on public.app_error_alerts (sent_at desc);

alter table public.app_errors enable row level security;
alter table public.app_error_alerts enable row level security;

drop policy if exists app_errors_admin_select on public.app_errors;
create policy app_errors_admin_select on public.app_errors for select to authenticated
  using (public.is_admin());
drop policy if exists app_errors_admin_update on public.app_errors;
create policy app_errors_admin_update on public.app_errors for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists app_error_alerts_admin_select on public.app_error_alerts;
create policy app_error_alerts_admin_select on public.app_error_alerts for select to authenticated
  using (public.is_admin());

revoke all on table public.app_errors from public, anon, authenticated;
grant select on table public.app_errors to authenticated;
grant update (resolved, resolved_at) on table public.app_errors to authenticated;
revoke all on table public.app_error_alerts from public, anon, authenticated;
grant select on table public.app_error_alerts to authenticated;

-- Upsert one occurrence. A repeat bumps count/last_seen and reopens a resolved
-- row (keeping the first sample). A new row prunes the table back to
-- p_max_rows: oldest resolved rows go first, then the oldest open ones.
-- Returns {id, is_new, reopened, count, first_seen} for the alert decision.
create or replace function public.record_app_error(
  p_fingerprint text,
  p_environment text,
  p_source text,
  p_message text,
  p_route text default null,
  p_stack text default null,
  p_user_agent text default null,
  p_max_rows integer default 1000
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_new boolean := false;
  v_was_resolved boolean := false;
  v_count integer;
  v_first timestamptz;
  v_over integer;
begin
  select id, resolved into v_id, v_was_resolved from public.app_errors
   where environment = p_environment and fingerprint = p_fingerprint
   for update;
  if found then
    update public.app_errors
       set count = least(count, 2147483646) + 1,
           last_seen = now(),
           resolved = false,
           resolved_at = null
     where id = v_id
     returning count, first_seen into v_count, v_first;
  else
    v_was_resolved := false;
    insert into public.app_errors (fingerprint, environment, source, route, message, stack, user_agent)
    values (p_fingerprint, p_environment, p_source, p_route, p_message, p_stack, p_user_agent)
    on conflict (environment, fingerprint) do update
       set count = least(app_errors.count, 2147483646) + 1,
           last_seen = now()
    returning id, (xmax = 0), count, first_seen into v_id, v_new, v_count, v_first;
  end if;

  if v_new then
    select count(*) - greatest(coalesce(p_max_rows, 1000), 1) into v_over from public.app_errors;
    if v_over > 0 then
      delete from public.app_errors
       where id in (select id from public.app_errors
                     where id <> v_id
                     order by resolved desc, last_seen asc
                     limit v_over);
    end if;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'is_new', v_new,
    'reopened', coalesce(v_was_resolved, false),
    'count', v_count,
    'first_seen', v_first
  );
end;
$$;

-- Global alert throttle: at most p_limit e-mails per rolling hour, across every
-- server instance (serialized by an advisory lock). With p_error_id (a new or
-- reopened error): send=true when under the limit, and `pending` counts the
-- throttled errors this e-mail also covers; over the limit the error is marked
-- alert_pending for a later digest. Without p_error_id: a digest check, send=true
-- only when under the limit AND open throttled errors are waiting.
create or replace function public.claim_app_error_alert(
  p_limit integer,
  p_error_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sent integer;
  v_pending integer;
begin
  perform pg_advisory_xact_lock(hashtext('public.app_error_alerts'));
  delete from public.app_error_alerts where sent_at < now() - interval '1 day';
  select count(*) into v_sent from public.app_error_alerts where sent_at > now() - interval '1 hour';

  if v_sent >= greatest(coalesce(p_limit, 0), 0) then
    if p_error_id is not null then
      update public.app_errors set alert_pending = true where id = p_error_id;
    end if;
    return jsonb_build_object('send', false, 'pending', 0);
  end if;

  select count(*) into v_pending from public.app_errors
   where alert_pending and not resolved and (p_error_id is null or id <> p_error_id);
  if p_error_id is null and v_pending = 0 then
    return jsonb_build_object('send', false, 'pending', 0);
  end if;
  update public.app_errors set alert_pending = false where alert_pending;

  insert into public.app_error_alerts (kind, errors)
  values (case when p_error_id is null then 'digest' else 'error' end,
          greatest(v_pending + case when p_error_id is null then 0 else 1 end, 1));
  return jsonb_build_object('send', true, 'pending', v_pending);
end;
$$;

-- Server-only: the service role calls these from the server routes. Nobody
-- signed in or anonymous may write errors or burn the alert budget.
revoke execute on function public.record_app_error(text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_app_error(text, text, text, text, text, text, text, integer) to service_role;
revoke execute on function public.claim_app_error_alert(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_app_error_alert(integer, uuid) to service_role;

-- ============================================================
-- 0054_privacy_safety.sql
-- ============================================================
-- Privacy & safety pack: admin_audit_log, creator_notices, link_tombstones,
-- is_admin() needs aal2, the self-close last-admin guard, spins.fan_pass_id
-- ON DELETE SET NULL, and the retention job. See migrations/0054.
-- 1. Admin activity log ------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  -- No foreign keys: an entry must outlive the actor's or target's account.
  actor_id    uuid,
  action      text not null check (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  target_type text check (target_type is null or target_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  target_id   uuid,
  details     jsonb not null default '{}'::jsonb
              check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096),
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
drop policy if exists admin_audit_log_admin_select on public.admin_audit_log;
create policy admin_audit_log_admin_select on public.admin_audit_log for select to authenticated
  using (public.is_admin());
revoke all on table public.admin_audit_log from public, anon, authenticated;
grant select on table public.admin_audit_log to authenticated;
grant select, insert, delete on table public.admin_audit_log to service_role;

-- Entries are append-only: nobody (not even the service role) rewrites one.
-- Only the retention job deletes, by age.
create or replace function public.admin_audit_log_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'admin_audit_log entries are append-only' using errcode = '42501';
end;
$$;
drop trigger if exists admin_audit_log_no_update on public.admin_audit_log;
create trigger admin_audit_log_no_update before update on public.admin_audit_log
  for each row execute function public.admin_audit_log_immutable();

-- 2. Creator notices ---------------------------------------------------------
create table if not exists public.creator_notices (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('fan_deleted_data')),
  details    jsonb not null default '{}'::jsonb
             check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 2048),
  created_at timestamptz not null default now()
);
create index if not exists creator_notices_creator_idx on public.creator_notices (creator_id, created_at desc);

alter table public.creator_notices enable row level security;
drop policy if exists creator_notices_select on public.creator_notices;
create policy creator_notices_select on public.creator_notices for select to authenticated
  using (public.can_act_for(creator_id, 'view'));
revoke all on table public.creator_notices from public, anon, authenticated;
grant select on table public.creator_notices to authenticated;
grant select, insert, delete on table public.creator_notices to service_role;

-- 3. Link tombstones ---------------------------------------------------------
create table if not exists public.link_tombstones (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  reason     text not null check (reason in ('creator_closed', 'fan_deleted')),
  created_at timestamptz not null default now()
);
create index if not exists link_tombstones_created_idx on public.link_tombstones (created_at);

alter table public.link_tombstones enable row level security;
drop policy if exists link_tombstones_admin_select on public.link_tombstones;
create policy link_tombstones_admin_select on public.link_tombstones for select to authenticated
  using (public.is_admin());
revoke all on table public.link_tombstones from public, anon, authenticated;
grant select, insert, delete on table public.link_tombstones to service_role;

-- 4. Admin power needs a two-factor session ---------------------------------
-- aal2 is set by Supabase Auth only after a verified MFA challenge. The app
-- enforces the same rule in src/lib/auth/adminCheck.ts; this makes the
-- database agree, so an aal1 admin JWT gets no admin rows through PostgREST.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- 5. The admin delete reservation trusts the same predicate -----------------
create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an ACTIVE admin on a two-factor session (is_admin()).
  if not public.is_admin() then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  -- Lock the target row; missing => not found.
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    -- Lock ALL admin rows so concurrent reservations serialize here.
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    -- Atomic reservation: demote so a concurrent call sees one fewer admin.
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;

-- 6. Closing your own account: the same last-admin guard ---------------------
-- Called by POST /api/account/close (service role) after the password step-up.
create or replace function public.reserve_self_account_deletion(p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  if p_user is null then
    return 'not_found';
  end if;
  select role into v_role from public.profiles where id = p_user for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    update public.profiles set role = 'creator' where id = p_user;
  end if;
  return 'ok';
end;
$$;
revoke execute on function public.reserve_self_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.reserve_self_account_deletion(uuid) to service_role;

-- 7. Deleting a fan anonymizes their spins -----------------------------------
alter table public.spins alter column fan_pass_id drop not null;
alter table public.spins drop constraint if exists spins_fan_pass_id_fkey;
alter table public.spins add constraint spins_fan_pass_id_fkey
  foreign key (fan_pass_id) references public.fan_passes(id) on delete set null;

-- 8. Daily retention ---------------------------------------------------------
-- Periods come from the caller (src/lib/privacy/retention.ts, documented in
-- docs/DATA_RETENTION.md). app_errors arrives with migration 0053; until that
-- table exists this step is skipped. Agency invites that were declined or
-- revoked hold an email address and nothing else of use, so they go too;
-- pending and accepted invites stay. Fans, spins and redemptions are business
-- records and are never touched here.
create or replace function public.run_retention_cleanup(
  p_audit_days integer,
  p_notice_days integer,
  p_tombstone_days integer,
  p_app_error_days integer,
  p_closed_invite_days integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_audit integer := 0;
  v_notices integer := 0;
  v_tombstones integer := 0;
  v_app_errors integer := 0;
  v_invites integer := 0;
  v_has_app_errors boolean := to_regclass('public.app_errors') is not null;
begin
  if p_audit_days is null or p_notice_days is null or p_tombstone_days is null
     or p_app_error_days is null or p_closed_invite_days is null
     or least(p_audit_days, p_notice_days, p_tombstone_days, p_app_error_days,
              p_closed_invite_days) < 1 then
    raise exception 'retention periods must be at least 1 day' using errcode = '22023';
  end if;

  delete from public.admin_audit_log
   where created_at < now() - make_interval(days => p_audit_days);
  get diagnostics v_audit = row_count;

  delete from public.creator_notices
   where created_at < now() - make_interval(days => p_notice_days);
  get diagnostics v_notices = row_count;

  delete from public.link_tombstones
   where created_at < now() - make_interval(days => p_tombstone_days);
  get diagnostics v_tombstones = row_count;

  delete from public.org_invites
   where status in ('declined', 'revoked')
     and created_at < now() - make_interval(days => p_closed_invite_days);
  get diagnostics v_invites = row_count;

  if v_has_app_errors then
    execute 'delete from public.app_errors
              where resolved and resolved_at is not null
                and resolved_at < now() - make_interval(days => $1)'
      using p_app_error_days;
    get diagnostics v_app_errors = row_count;
  end if;

  return jsonb_build_object(
    'admin_audit_log', v_audit,
    'creator_notices', v_notices,
    'link_tombstones', v_tombstones,
    'org_invites', v_invites,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;
revoke execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) to service_role;

-- ============================================================
-- 0055_terms_acceptance.sql
-- ============================================================
-- Terms acceptance records: creators' clickwrap (time + Terms version) and the
-- Terms version a fan agreed to at the age gate. Written only server-side:
-- record_terms_acceptance() is service-role only. See migrations/0055.
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;
alter table public.fans add column if not exists acked_terms_version text;

create or replace function public.record_terms_acceptance(p_user uuid, p_version text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz;
begin
  if p_user is null or p_version is null or p_version !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid terms acceptance' using errcode = '22023';
  end if;
  update public.profiles
     set terms_accepted_at = now(), terms_version = p_version
   where id = p_user
  returning terms_accepted_at into v_at;
  return v_at;
end;
$$;

revoke execute on function public.record_terms_acceptance(uuid, text) from public, anon, authenticated;
grant execute on function public.record_terms_acceptance(uuid, text) to service_role;

-- 0056_push_subscriptions.sql
-- ============================================================
-- Web push (closed-tab notifications for creators): per-device subscriptions
-- (own devices only; show_details is the one creator-writable column) and the
-- service-only send log. See migrations/0056.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique
    check (endpoint ~ '^https://' and length(endpoint) <= 1024),
  p256dh text not null check (length(p256dh) between 1 and 256),
  auth text not null check (length(auth) between 1 and 64),
  show_details boolean not null default false,
  user_agent text check (user_agent is null or length(user_agent) <= 80),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures integer not null default 0 check (failures >= 0)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions for insert
  with check (user_id = auth.uid() and public.current_user_active());

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions for update
  using (user_id = auth.uid() and public.current_user_active())
  with check (user_id = auth.uid() and public.current_user_active());

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions for delete
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;
grant insert (user_id, endpoint, p256dh, auth, show_details, user_agent)
  on public.push_subscriptions to authenticated;
grant update (show_details) on public.push_subscriptions to authenticated;

create table if not exists public.push_log (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null check (length(item_id) <= 200),
  tag text not null check (length(tag) <= 120),
  sent_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists push_log_user_tag_idx on public.push_log (user_id, tag, sent_at desc);

alter table public.push_log enable row level security;

drop policy if exists push_log_select on public.push_log;
create policy push_log_select on public.push_log for select
  using ((user_id = auth.uid() and public.current_user_active()) or public.is_admin());

revoke all on public.push_log from public, anon, authenticated;
grant select on public.push_log to authenticated;


-- Approval is authorization, not just dashboard navigation ------------------
-- New self-signups start active but pending. Every creator business write,
-- agency action and push subscription must also require admin approval.
-- Read-only own-account access and personal account/application settings remain
-- available. An active admin role is approved for its own creator operations
-- even on legacy profiles whose approval_status is still pending; cross-account
-- admin power continues to require is_admin(), including its aal2 check.
-- No roles or permissions are read from user/app metadata. Existing grants and
-- SECURITY DEFINER search paths are preserved by CREATE OR REPLACE.
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
      and (approval_status = 'approved' or role = 'admin')
  );
$$;

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
  v_active boolean;
begin
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_active
      and (approval_status = 'approved' or role = 'admin')
  ) into v_active;

  -- The creator themselves: always 'view'; every mutating perm needs an
  -- active account (a suspended creator gets a read-only dashboard).
  if target_creator = auth.uid() then
    return perm = 'view' or v_active;
  end if;

  -- Reaching another creator through an org seat: never while suspended.
  if not v_active then
    return false;
  end if;

  -- Find the caller's org membership that covers the target creator's org.
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles owner_profile on owner_profile.id = o.owner_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid()
     and p.org_id = o.id
     and owner_profile.is_active
     and (owner_profile.approval_status = 'approved' or owner_profile.role = 'admin')
     and p.is_active and (p.approval_status = 'approved' or p.role = 'admin')
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

create or replace function public._owns_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
                 where o.id = p_org and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public._is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.profiles p on p.id = m.profile_id
                  join public.orgs o on o.id = m.org_id
                  join public.profiles owner_profile on owner_profile.id = o.owner_id
                 where m.org_id = p_org and m.profile_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin')
                   and owner_profile.is_active
                   and (owner_profile.approval_status = 'approved' or owner_profile.role = 'admin'));
$$;

create or replace function public._owns_org_seat(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                  join public.profiles p on p.id = o.owner_id
                 where m.id = p_member and o.owner_id = auth.uid() and p.is_active
                   and (p.approval_status = 'approved' or p.role = 'admin'));
$$;

create or replace function public.org_invite_respond(p_invite uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_inv record; v_my_email text; v_my_org uuid; v_active boolean;
begin
  select email, org_id, (is_active and (approval_status = 'approved' or role = 'admin')) into v_my_email, v_my_org, v_active from public.profiles where id = auth.uid();
  if not coalesce(v_active, false) then return 'inactive'; end if;
  select * into v_inv from public.org_invites where id = p_invite;
  if v_inv is null then return 'gone'; end if;
  if not exists (
    select 1 from public.orgs o join public.profiles p on p.id = o.owner_id
     where o.id = v_inv.org_id and p.is_active
       and (p.approval_status = 'approved' or p.role = 'admin')
  ) then return 'inactive'; end if;
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

create or replace function public.org_add_member(p_org uuid, p_email text, p_role org_role)
returns text language plpgsql security definer set search_path = public as $$
declare v_profile uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id into v_profile from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
  if v_profile is null then return 'no_such_user'; end if;
  insert into public.org_members (org_id, profile_id, role)
    values (p_org, v_profile, p_role)
    on conflict (org_id, profile_id) do update set role = excluded.role;
  return 'ok';
end;
$$;

create or replace function public.org_add_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
  if v_creator is null then return 'no_such_user'; end if;
  if v_org is not null and v_org <> p_org then return 'already_in_org'; end if;
  update public.profiles set org_id = p_org where id = v_creator;
  return 'ok';
end;
$$;

create or replace function public.org_invite_creator(p_org uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_org uuid;
begin
  if not public._owns_org(p_org) then return 'not_owner'; end if;
  select id, org_id into v_creator, v_org from public.profiles
   where lower(email) = lower(trim(p_email)) and is_active
     and (approval_status = 'approved' or role = 'admin') limit 1;
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

create or replace function public.import_fans(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid := auth.uid();
begin
  if v_creator is null then
    raise exception 'unauthorized';
  end if;

  if not public.current_user_active() then
    raise exception 'account is not active or approved' using errcode = '42501';
  end if;

  -- SECURITY DEFINER bypasses RLS, so verify the caller owns every referenced
  -- wheel and campaign before inserting anything that points at them.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where not exists (
      select 1 from public.wheels w
       where w.id = (r->>'wheel_id')::uuid and w.creator_id = v_creator
    )
  ) then
    raise exception 'wheel_not_owned';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (r->>'campaign_id') is not null
      and not exists (
        select 1 from public.campaigns c
         where c.id = (r->>'campaign_id')::uuid and c.creator_id = v_creator
      )
  ) then
    raise exception 'campaign_not_owned';
  end if;

  insert into public.fans (id, creator_id, display_name, spins_remaining, spins_granted_total)
  select (r->>'fan_id')::uuid, v_creator,
         coalesce(nullif(r->>'name', ''), 'Fan'),
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.fan_passes
         (id, token, creator_id, wheel_id, fan_id, campaign_id, spins_remaining, spins_granted_total)
  select (r->>'pass_id')::uuid, r->>'token', v_creator,
         (r->>'wheel_id')::uuid, (r->>'fan_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.grants
         (creator_id, fan_id, fan_pass_id, campaign_id, spins, amount_cents, bonus_spins)
  select v_creator, (r->>'fan_id')::uuid, (r->>'pass_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'amount_cents')::int, 0
    from jsonb_array_elements(p_rows) r;
end;
$$;

create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;

create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true and public.current_user_active();
$$;

create or replace function public.set_pwa_icon_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_mode is null or p_mode not in ('neutral', 'avatar') then
    raise exception 'invalid pwa_icon_mode' using errcode = '22023';
  end if;
  update public.profiles set pwa_icon_mode = p_mode
   where id = auth.uid() and is_active = true and public.current_user_active();
end;
$$;
revoke execute on function public.set_pwa_icon_mode(text) from public, anon;
grant execute on function public.set_pwa_icon_mode(text) to authenticated;

create or replace function public.set_leaderboard_enabled(p_enabled boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set leaderboard_enabled = p_enabled where id = auth.uid() and public.current_user_active();
$$;


-- Daily push history cleanup ------------------------------------------------
-- Preserve the existing five-argument RPC, all existing periods and its
-- server-only grant. Include push delivery logs even for inactive accounts.
create or replace function public.run_retention_cleanup(
  p_audit_days integer,
  p_notice_days integer,
  p_tombstone_days integer,
  p_app_error_days integer,
  p_closed_invite_days integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- Matches PUSH_LOG_RETENTION_DAYS; retention.test.ts checks every SQL mirror.
  v_push_log_days constant integer := 30;
  v_push_log integer := 0;
  v_audit integer := 0;
  v_notices integer := 0;
  v_tombstones integer := 0;
  v_app_errors integer := 0;
  v_invites integer := 0;
  v_has_app_errors boolean := to_regclass('public.app_errors') is not null;
begin
  if p_audit_days is null or p_notice_days is null or p_tombstone_days is null
     or p_app_error_days is null or p_closed_invite_days is null
     or least(p_audit_days, p_notice_days, p_tombstone_days, p_app_error_days,
              p_closed_invite_days) < 1 then
    raise exception 'retention periods must be at least 1 day' using errcode = '22023';
  end if;

  delete from public.admin_audit_log
   where created_at < now() - make_interval(days => p_audit_days);
  get diagnostics v_audit = row_count;

  delete from public.creator_notices
   where created_at < now() - make_interval(days => p_notice_days);
  get diagnostics v_notices = row_count;

  delete from public.link_tombstones
   where created_at < now() - make_interval(days => p_tombstone_days);
  get diagnostics v_tombstones = row_count;

  delete from public.org_invites
   where status in ('declined', 'revoked')
     and created_at < now() - make_interval(days => p_closed_invite_days);
  get diagnostics v_invites = row_count;

  -- Deterministic, global cleanup: no future notification or active account
  -- is needed for old deduplication history to expire.
  delete from public.push_log
   where sent_at < now() - make_interval(days => v_push_log_days);
  get diagnostics v_push_log = row_count;

  if v_has_app_errors then
    execute 'delete from public.app_errors
              where resolved and resolved_at is not null
                and resolved_at < now() - make_interval(days => $1)'
      using p_app_error_days;
    get diagnostics v_app_errors = row_count;
  end if;

  return jsonb_build_object(
    'push_log', v_push_log,
    'admin_audit_log', v_audit,
    'creator_notices', v_notices,
    'link_tombstones', v_tombstones,
    'org_invites', v_invites,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;
revoke execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.run_retention_cleanup(integer, integer, integer, integer, integer) to service_role;

-- 0057_instant_rewards.sql
-- ============================================================
-- 0057 Instant-delivery prizes (#26).
--
-- A prize can carry a digital reward that is revealed to the winner the moment
-- they win it, and its redemption is recorded as fulfilled automatically:
--   prizes.delivery     'manual' (today) | 'link' | 'text' | 'codes'. Not a
--                       secret: the creator's editor reads it; the fan-safe
--                       projection never sends it.
--   prize_rewards       one encrypted link or text per prize (link/text).
--   prize_reward_codes  a list of single-use encrypted codes per prize. A code
--                       is handed out at most once: spin_id is unique and a
--                       code is only ever assigned under its prize's row lock.
--   spin_rewards        what one winning spin received (a copy of the
--                       ciphertext, made in the same statement as the spin
--                       insert by trg_attach_spin_reward), plus how often the
--                       fan has viewed it. The fan's re-view reads only this.
--
-- Values are AES-256-GCM ciphertext made on the server with a key that never
-- leaves it (REWARD_ENCRYPTION_KEY). Nobody but the service role can read a
-- cipher or iv column: creators read only metadata (kind, hint, counts, views)
-- through column grants, anon reads nothing, and every write goes through the
-- server-only functions below (revoked from public, anon and authenticated).
--
-- Stock: for a code-list prize, prizes.stock IS the number of unused codes.
-- trg_sync_code_prize_stock recounts it on every write to the prize row, so the
-- editor, a hand edit or a stale save can't drift it, and the prize leaves the
-- wheel exactly when the codes run out. A spin reserves its code before the
-- spin row exists (reserve_reward_code, bound to the spin's pre-generated id),
-- and the spin insert itself refuses a code prize without a reserved code, so a
-- prize that can't be delivered is never awarded.

alter table public.prizes add column if not exists delivery text not null default 'manual'
  check (delivery in ('manual', 'link', 'text', 'codes'));

create table if not exists public.prize_rewards (
  prize_id    uuid primary key references public.prizes(id) on delete cascade,
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('link', 'text')),
  cipher      text not null check (char_length(cipher) <= 8192),
  iv          text not null check (char_length(iv) <= 64),
  key_version smallint not null default 1 check (key_version >= 1),
  updated_at  timestamptz not null default now()
);
create index if not exists prize_rewards_creator_idx on public.prize_rewards (creator_id);

create table if not exists public.prize_reward_codes (
  id          uuid primary key default gen_random_uuid(),
  prize_id    uuid not null references public.prizes(id) on delete cascade,
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  cipher      text check (char_length(cipher) <= 1024),
  iv          text check (char_length(iv) <= 64),
  erased_at   timestamptz,
  key_version smallint not null default 1 check (key_version >= 1),
  hint        text check (char_length(hint) <= 8),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  spin_id     uuid unique,
  assigned_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint prize_reward_codes_assignment check ((spin_id is null) = (assigned_at is null)),
  unique (prize_id, fingerprint),
  constraint prize_reward_codes_erasure check (
    (erased_at is null and cipher is not null and iv is not null) or
    (erased_at is not null and cipher is null and iv is null) and spin_id is not null and hint is null
  )
);
create index if not exists prize_reward_codes_free_idx
  on public.prize_reward_codes (prize_id, created_at) where spin_id is null;
create index if not exists prize_reward_codes_creator_idx on public.prize_reward_codes (creator_id);

create table if not exists public.spin_rewards (
  spin_id        uuid primary key references public.spins(id) on delete cascade,
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('link', 'text', 'code')),
  cipher         text check (char_length(cipher) <= 8192),
  iv             text check (char_length(iv) <= 64),
  erased_at   timestamptz,
  key_version    smallint not null default 1 check (key_version >= 1),
  code_id        uuid unique references public.prize_reward_codes(id) on delete set null,
  stock_after    integer,
  views          integer not null default 1 check (views >= 0),
  last_viewed_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint spin_rewards_erasure check (
    (erased_at is null and cipher is not null and iv is not null) or
    (erased_at is not null and cipher is null and iv is null)
  )
);
create index if not exists spin_rewards_creator_idx on public.spin_rewards (creator_id);
create index if not exists spins_reward_history_idx on public.spins (fan_id, created_at desc, share_id desc) where share_id is not null;

-- RLS: a creator (or a seat that may edit / view for them) reads its own
-- metadata rows; an admin reads all. No write policy exists, so even with
-- table privileges a session could not insert, update or delete a row.
alter table public.prize_rewards enable row level security;
drop policy if exists prize_rewards_select on public.prize_rewards;
create policy prize_rewards_select on public.prize_rewards for select
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

alter table public.prize_reward_codes enable row level security;
drop policy if exists prize_reward_codes_select on public.prize_reward_codes;
create policy prize_reward_codes_select on public.prize_reward_codes for select
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

alter table public.spin_rewards enable row level security;
drop policy if exists spin_rewards_select on public.spin_rewards;
create policy spin_rewards_select on public.spin_rewards for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());

-- Privileges: anon nothing; authenticated only the non-secret columns.
revoke all on table public.prize_rewards from anon, authenticated;
revoke all on table public.prize_reward_codes from anon, authenticated;
revoke all on table public.spin_rewards from anon, authenticated;
grant select (prize_id, creator_id, kind, key_version, updated_at) on table public.prize_rewards to authenticated;
grant select (id, prize_id, creator_id, key_version, hint, spin_id, assigned_at, created_at, erased_at) on table public.prize_reward_codes to authenticated;
grant select (spin_id, creator_id, kind, key_version, code_id, views, last_viewed_at, created_at, erased_at) on table public.spin_rewards to authenticated;

-- A code-list prize's stock is its unused-code count, whoever writes the row.
-- SECURITY DEFINER so the recount sees every code whatever the caller may read.
create or replace function public.sync_code_prize_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery = 'codes' then
    new.stock := (select count(*)::integer from public.prize_reward_codes c
                   where c.prize_id = new.id and c.spin_id is null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_code_prize_stock on public.prizes;
create trigger trg_sync_code_prize_stock
  before insert or update on public.prizes
  for each row execute function public.sync_code_prize_stock();

-- Copy the delivered reward onto the spin in the same statement as the spin
-- insert. A code prize without a code reserved for this spin, or a link/text
-- prize without its reward, fails the insert: the server then refunds the
-- spin, so an undeliverable prize is never awarded.
create or replace function public.attach_spin_reward()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.prize_reward_codes%rowtype;
  v_reward public.prize_rewards%rowtype;
  v_delivery text;
begin
  select * into v_code from public.prize_reward_codes where spin_id = new.id;
  if found then
    if v_code.prize_id is distinct from new.prize_id or v_code.creator_id <> new.creator_id then
      raise exception 'reward code belongs to another prize' using errcode = '23514';
    end if;
    insert into public.spin_rewards (spin_id, creator_id, kind, cipher, iv, key_version, code_id)
    values (new.id, new.creator_id, 'code', v_code.cipher, v_code.iv, v_code.key_version, v_code.id);
    return new;
  end if;
  if new.prize_id is null then
    return new;
  end if;
  select delivery into v_delivery from public.prizes where id = new.prize_id;
  if v_delivery = 'codes' then
    raise exception 'no reward code reserved for this spin' using errcode = '23514';
  elsif v_delivery in ('link', 'text') then
    if current_setting('fanfunnel.reward_finalization', true) is distinct from new.id::text then
      raise exception 'instant prize must be finalized atomically' using errcode = '23514';
    end if;
    select * into v_reward from public.prize_rewards where prize_id = new.prize_id;
    if not found or v_reward.creator_id <> new.creator_id then
      raise exception 'instant prize has no reward' using errcode = '23514';
    end if;
    insert into public.spin_rewards (spin_id, creator_id, kind, cipher, iv, key_version)
    values (new.id, new.creator_id, v_reward.kind, v_reward.cipher, v_reward.iv, v_reward.key_version);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attach_spin_reward on public.spins;
create trigger trg_attach_spin_reward
  after insert on public.spins
  for each row execute function public.attach_spin_reward();

-- Server-only: take one unused code of a code-list prize for the spin that is
-- about to be recorded (its id is generated by the server first). Every change
-- to a prize's code pool locks the prize row, so concurrent spins queue here
-- and no two can take the same code. No row back = no code left (sold out).
create or replace function public.reserve_reward_code(p_prize uuid, p_spin uuid)
returns table (code_id uuid, code_cipher text, code_iv text, code_key_version smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.prize_reward_codes%rowtype;
begin
  if p_prize is null or p_spin is null then
    return;
  end if;
  perform 1 from public.prizes where id = p_prize and delivery = 'codes' for update;
  if not found then
    return;
  end if;
  select * into v_code from public.prize_reward_codes c
   where c.prize_id = p_prize and c.spin_id is null
   order by c.created_at, c.id
   limit 1;
  if found then
    update public.prize_reward_codes set spin_id = p_spin, assigned_at = now() where id = v_code.id;
  end if;
  -- Recount stock (trg_sync_code_prize_stock), also when nothing was left.
  update public.prizes set stock = stock where id = p_prize;
  if v_code.id is not null then
    return query select v_code.id, v_code.cipher, v_code.iv, v_code.key_version;
  end if;
end;
$$;

-- Server-only: give back the code reserved for a spin that was never recorded
-- (the spin failed after the reservation). A code whose spin row exists was
-- delivered and is never handed out again.
create or replace function public.release_reward_code(p_spin uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prize uuid;
begin
  select prize_id into v_prize from public.prize_reward_codes where spin_id = p_spin and erased_at is null;
  if v_prize is null then
    return false;
  end if;
  perform 1 from public.prizes where id = v_prize for update;
  if exists (select 1 from public.spins where id = p_spin) then
    return false;
  end if;
  update public.prize_reward_codes set spin_id = null, assigned_at = null where spin_id = p_spin;
  update public.prizes set stock = stock where id = v_prize;
  return true;
end;
$$;

-- Server-only: append encrypted codes to a prize on one of p_creator's wheels
-- and make it a code-list prize, in one transaction. Returns the codes left.
-- p_codes: [{ "cipher": text, "iv": text, "key_version": int, "hint": text|null }].
create or replace function public.add_reward_codes(p_prize uuid, p_creator uuid, p_codes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left integer;
  v_new integer;
  v_added integer;
begin
  perform 1 from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = p_prize and w.creator_id = p_creator
   for update of p;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 then
    raise exception 'codes must be a non-empty array' using errcode = '22023';
  end if;
  select count(*) into v_left from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  select count(distinct e->>'fingerprint') into v_new from jsonb_array_elements(p_codes) e
   where not exists (select 1 from public.prize_reward_codes c where c.prize_id = p_prize and c.fingerprint = e->>'fingerprint');
  if v_left + v_new > 5000 then
    raise exception 'too many codes on one prize' using errcode = '22023';
  end if;
  with added as (
    insert into public.prize_reward_codes (prize_id, creator_id, cipher, iv, key_version, hint, fingerprint)
    select p_prize, p_creator, e->>'cipher', e->>'iv', coalesce((e->>'key_version')::smallint, 1), nullif(e->>'hint', ''), e->>'fingerprint'
      from jsonb_array_elements(p_codes) e
    on conflict (prize_id, fingerprint) do nothing
    returning 1
  ) select count(*) into v_added from added;
  delete from public.prize_rewards where prize_id = p_prize;
  update public.prizes set delivery = 'codes' where id = p_prize;
  select stock into v_left from public.prizes where id = p_prize;
  return v_added;
end;
$$;

-- Server-only: set a prize on one of p_creator's wheels to manual, an
-- encrypted link or an encrypted text. Leaving a code list discards its unused
-- codes; the prize keeps its current stock as an ordinary limit.
create or replace function public.set_prize_delivery(
  p_prize uuid,
  p_creator uuid,
  p_kind text,
  p_cipher text default null,
  p_iv text default null,
  p_key_version smallint default 1
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind is null or p_kind not in ('manual', 'link', 'text') then
    raise exception 'invalid delivery' using errcode = '22023';
  end if;
  perform 1 from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = p_prize and w.creator_id = p_creator
   for update of p;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_kind = 'manual' then
    delete from public.prize_rewards where prize_id = p_prize;
  else
    if p_cipher is null or p_iv is null then
      raise exception 'reward value required' using errcode = '22023';
    end if;
    insert into public.prize_rewards (prize_id, creator_id, kind, cipher, iv, key_version, updated_at)
    values (p_prize, p_creator, p_kind, p_cipher, p_iv, coalesce(p_key_version, 1), now())
    on conflict (prize_id) do update
      set creator_id = excluded.creator_id, kind = excluded.kind, cipher = excluded.cipher,
          iv = excluded.iv, key_version = excluded.key_version, updated_at = now();
  end if;
  update public.prizes set delivery = p_kind where id = p_prize;
  delete from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  return p_kind;
end;
$$;

-- Server-only: the fan re-opened their reward (the spin's owner is checked by
-- the server route first). Returns the new view count.
create or replace function public.record_reward_view(p_spin uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.spin_rewards
     set views = views + 1, last_viewed_at = now()
   where spin_id = p_spin and erased_at is null
  returning views;
$$;

revoke execute on function public.reserve_reward_code(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_reward_code(uuid, uuid) to service_role;
revoke execute on function public.release_reward_code(uuid) from public, anon, authenticated;
grant execute on function public.release_reward_code(uuid) to service_role;
revoke execute on function public.add_reward_codes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_reward_codes(uuid, uuid, jsonb) to service_role;
revoke execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) from public, anon, authenticated;
grant execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) to service_role;
revoke execute on function public.record_reward_view(uuid) from public, anon, authenticated;
grant execute on function public.record_reward_view(uuid) to service_role;

-- Instant wins finalize in one transaction. The caller has already decrypted
-- exactly p_expected; a changed code/value is retried without changing odds.
-- A retry after an HTTP timeout uses the same spin id and recovers its receipt.
create or replace function public.finalize_reward_spin(p_spin jsonb, p_expected jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_input public.spins%rowtype;
  v_existing public.spins%rowtype;
  v_prize public.prizes%rowtype;
  v_code public.prize_reward_codes%rowtype;
  v_reward public.prize_rewards%rowtype;
  v_receipt public.spin_rewards%rowtype;
  v_pass uuid;
begin
  select * into v_input from jsonb_populate_record(null::public.spins, p_spin);
  if v_input.id is null or v_input.fan_pass_id is null or v_input.creator_id is null or v_input.fan_id is null then
    raise exception 'invalid spin identity' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_input.id::text, 57));
  select * into v_existing from public.spins where id = v_input.id;
  if found then
    if v_existing.creator_id is distinct from v_input.creator_id or v_existing.fan_id is distinct from v_input.fan_id
       or v_existing.fan_pass_id is distinct from v_input.fan_pass_id then
      raise exception 'spin identity conflict' using errcode = '42501';
    end if;
    select * into v_receipt from public.spin_rewards where spin_id = v_existing.id;
    return jsonb_build_object('status', 'recorded', 'id', v_existing.id, 'shareId', v_existing.share_id,
      'reward', jsonb_build_object('kind', v_receipt.kind, 'cipher', v_receipt.cipher, 'iv', v_receipt.iv, 'keyVersion', v_receipt.key_version),
      'stockAfter', v_receipt.stock_after);
  end if;

  -- Match the existing claim lock order, then serialize prize edits/allocations.
  perform 1 from public.fans where id = v_input.fan_id for update;
  select fp.id into v_pass from public.fan_passes fp
    join public.fans f on f.id = fp.fan_id
    join public.profiles c on c.id = fp.creator_id
   where fp.id = v_input.fan_pass_id and fp.fan_id = v_input.fan_id and fp.creator_id = v_input.creator_id
     and fp.is_active and fp.self_excluded_at is null and f.blocked_at is null
     and (f.break_until is null or f.break_until <= now()) and c.is_active
   for update of fp;
  if v_pass is null then raise exception 'spin link is not active' using errcode = '42501'; end if;
  select p.* into v_prize from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = v_input.prize_id and p.wheel_id = v_input.wheel_id and w.creator_id = v_input.creator_id for update of p;
  if not found then return jsonb_build_object('status', 'sold_out'); end if;
  if v_prize.delivery is distinct from p_expected->>'delivery' then return jsonb_build_object('status', 'changed'); end if;

  if v_prize.delivery = 'codes' then
    select * into v_code from public.prize_reward_codes
     where id = (p_expected->>'codeId')::uuid and prize_id = v_prize.id and spin_id is null;
    if not found then
      if exists (select 1 from public.prize_reward_codes where prize_id = v_prize.id and spin_id is null) then
        return jsonb_build_object('status', 'retry');
      end if;
      return jsonb_build_object('status', 'sold_out');
    end if;
    if v_code.cipher is distinct from p_expected->>'cipher' or v_code.iv is distinct from p_expected->>'iv'
       or v_code.key_version is distinct from (p_expected->>'keyVersion')::smallint then
      return jsonb_build_object('status', 'retry');
    end if;
    update public.prize_reward_codes set spin_id = v_input.id, assigned_at = now() where id = v_code.id;
    update public.prizes set stock = stock where id = v_prize.id;
  elsif v_prize.delivery in ('link', 'text') then
    select * into v_reward from public.prize_rewards where prize_id = v_prize.id;
    if not found then return jsonb_build_object('status', 'unavailable'); end if;
    if v_reward.kind is distinct from p_expected->>'delivery' or v_reward.cipher is distinct from p_expected->>'cipher'
       or v_reward.iv is distinct from p_expected->>'iv' or v_reward.key_version is distinct from (p_expected->>'keyVersion')::smallint then
      return jsonb_build_object('status', 'retry');
    end if;
    if v_prize.stock is not null then
      if v_prize.stock <= 0 then return jsonb_build_object('status', 'sold_out'); end if;
      update public.prizes set stock = stock - 1 where id = v_prize.id;
    end if;
  else
    return jsonb_build_object('status', 'changed');
  end if;

  perform set_config('fanfunnel.reward_finalization', v_input.id::text, true);
  insert into public.spins (
    id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity, prize_image_url,
    campaign_id, server_seed, server_seed_hash, nonce, client_seed, seed_commitment,
    fair_version, pool_snapshot, pool_hash, fair_trace
  ) values (
    v_input.id, v_input.fan_pass_id, v_input.creator_id, v_input.wheel_id, v_input.fan_id, v_input.prize_id,
    v_input.prize_label, v_input.prize_rarity, v_input.prize_image_url, v_input.campaign_id,
    v_input.server_seed, v_input.server_seed_hash, v_input.nonce, v_input.client_seed, v_input.seed_commitment,
    v_input.fair_version, v_input.pool_snapshot, v_input.pool_hash, v_input.fair_trace
  ) returning * into v_existing;
  insert into public.redemptions (spin_id, creator_id, status, fulfilled_at)
  values (v_existing.id, v_existing.creator_id, 'fulfilled', now());
  update public.spin_rewards set stock_after = (select stock from public.prizes where id = v_existing.prize_id) where spin_id = v_existing.id;
  select * into v_receipt from public.spin_rewards where spin_id = v_existing.id;
  return jsonb_build_object('status', 'recorded', 'id', v_existing.id, 'shareId', v_existing.share_id,
    'reward', jsonb_build_object('kind', v_receipt.kind, 'cipher', v_receipt.cipher, 'iv', v_receipt.iv, 'keyVersion', v_receipt.key_version),
    'stockAfter', v_receipt.stock_after);
end;
$$;
revoke execute on function public.finalize_reward_spin(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_reward_spin(jsonb, jsonb) to service_role;

-- A delivered secret cannot be undone by changing a queue status or due date,
-- including direct requests through the creator's RLS-scoped database client.
create or replace function public.guard_delivered_redemption()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.spin_rewards where spin_id = new.spin_id) then
    if new.status <> 'fulfilled' or new.fulfilled_at is null or new.due_at is not null then
      raise exception 'instant reward is already delivered' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_delivered_redemption on public.redemptions;
create trigger trg_guard_delivered_redemption before insert or update of status, fulfilled_at, due_at on public.redemptions
  for each row execute function public.guard_delivered_redemption();


-- Erasure removes delivered values, preserving only anonymous fulfilment
-- metadata and a keyed consumed-code tombstone so an exposed coupon is never
-- restocked or re-uploaded as a fresh code. The trigger runs before0054's
-- ON DELETE SET NULL actions remove the fan association from retained spins.
create or replace function public.scrub_fan_reward_values(p_fan uuid)
returns void
language sql
security definer set search_path = public
as $$
  update public.prize_reward_codes c
     set cipher = null, iv = null, hint = null, erased_at = now()
    from public.spins s where s.id = c.spin_id and s.fan_id = p_fan;
  update public.spin_rewards r
     set cipher = null, iv = null, erased_at = now()
    from public.spins s where s.id = r.spin_id and s.fan_id = p_fan;
$$;
revoke execute on function public.scrub_fan_reward_values(uuid) from public, anon, authenticated, service_role;

create or replace function public.erase_fan_reward_values()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.scrub_fan_reward_values(old.id);
  return old;
end;
$$;
drop trigger if exists trg_erase_fan_reward_values on public.fans;
create trigger trg_erase_fan_reward_values before delete on public.fans
  for each row execute function public.erase_fan_reward_values();


-- Re-check the live token on the view write, so deletion/pause/block races
-- between the first lookup and decryption cannot disclose an invalidated win.
create or replace function public.record_fan_reward_view(p_spin uuid, p_token text)
returns integer
language sql
security definer set search_path = public
as $$
  update public.spin_rewards r set views = r.views + 1, last_viewed_at = now()
    from public.spins s
    join public.fan_passes fp on fp.fan_id = s.fan_id and fp.creator_id = s.creator_id
    join public.fans f on f.id = fp.fan_id
    join public.profiles c on c.id = fp.creator_id
   where r.spin_id = p_spin and s.id = r.spin_id and fp.token = p_token
     and fp.is_active and fp.self_excluded_at is null and f.blocked_at is null and c.is_active
     and r.erased_at is null
  returning r.views;
$$;
revoke execute on function public.record_fan_reward_view(uuid, text) from public, anon, authenticated;
grant execute on function public.record_fan_reward_view(uuid, text) to service_role;

-- Prize replacement must not cascade away encrypted rewards before a failing
-- insert. Keep this set in one transaction, retaining ids owned by this wheel.
create or replace function public.save_wheel_prizes(p_wheel uuid, p_creator uuid, p_prizes jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_order integer := 0;
begin
  perform 1 from public.wheels where id = p_wheel and creator_id = p_creator for update;
  if not found then raise exception 'wheel not found' using errcode = 'P0002'; end if;
  if p_prizes is null or jsonb_typeof(p_prizes) <> 'array' or jsonb_array_length(p_prizes) not between 2 and 50 then
    raise exception 'invalid prize count' using errcode = '22023';
  end if;
  perform 1 from public.prizes where wheel_id = p_wheel order by id for update;
  for v_row in select * from jsonb_array_elements(p_prizes) loop
    v_id := null;
    if (v_row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into v_id from public.prizes where id = (v_row->>'id')::uuid and wheel_id = p_wheel;
    end if;
    if v_id is null then v_id := gen_random_uuid(); end if;
    if v_id = any(v_ids) then raise exception 'duplicate prize id' using errcode = '22023'; end if;
    insert into public.prizes (id,wheel_id,label,description,rarity,weight,color,emoji,image_url,cost_cents,stock,sort_order)
    values(v_id,p_wheel,v_row->>'label',v_row->>'description',(v_row->>'rarity')::public.prize_rarity,
      (v_row->>'weight')::integer,v_row->>'color',v_row->>'emoji',v_row->>'image_url',
      (v_row->>'cost_cents')::integer,(v_row->>'stock')::integer,v_order)
    on conflict(id) do update set label=excluded.label,description=excluded.description,rarity=excluded.rarity,
      weight=excluded.weight,color=excluded.color,emoji=excluded.emoji,image_url=excluded.image_url,
      cost_cents=excluded.cost_cents,stock=excluded.stock,sort_order=excluded.sort_order;
    v_ids := array_append(v_ids,v_id);
    v_order := v_order + 1;
  end loop;
  delete from public.prizes where wheel_id=p_wheel and not(id=any(v_ids));
end;
$$;
revoke execute on function public.save_wheel_prizes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_wheel_prizes(uuid, uuid, jsonb) to service_role;

-- 0058_creator_theme_media.sql
-- ============================================================
-- 0058 Per-creator theming: headline font, page background and a photo hub
-- (owner decisions D12: per creator, the brand colour stays per wheel; D13:
-- SFW-only everywhere, the creator attests each photo, fans can report it).
--
-- profiles.theme holds the creator's look as allow-listed KEYS only:
--   {"font": <font key>, "background": <preset key>, "bg_media_id": <uuid>}
-- never a URL, colour or CSS string. The app maps each key to a self-hosted
-- font and a computed, contrast-checked background (src/lib/creatorTheme/).
-- profiles UPDATE is admin-only (AGENTS.md rule 6), so the creator writes it
-- through set_creator_theme(), which validates every key against the same
-- allow-list, accepts a background photo only from the caller's OWN media,
-- writes auth.uid()'s active row only, and is not executable by anon (0044).
--
-- creator_media is the photo hub: one row per re-encoded WebP in the
-- `creator-media` bucket. Rows are inserted ONLY by the upload route with the
-- service role, after it has sniffed, size-checked and re-encoded the file
-- (no insert policy or grant for any client role). The creator may change a
-- photo's caption and order (column-level grant) and delete it, on their own
-- rows only, while active; an admin may delete any (moderation: "Remove
-- photos" on the account row). The path is pinned to "<creator_id>/<uuid>.webp".
-- A trigger caps the hub at 12 photos, and deleting the photo the theme uses
-- as its background drops the theme back to the default background.
--
-- The bucket is public-read (fan and link-in-bio pages show the photos) with
-- no storage.objects policy for it at all, so no client can write, overwrite
-- or delete an object directly; it only accepts WebP up to 2 MB.

alter table public.profiles
  add column if not exists theme jsonb not null default '{}'::jsonb
    check (jsonb_typeof(theme) = 'object');

create table if not exists public.creator_media (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles(id) on delete cascade,
  path            text not null unique,
  caption         text check (caption is null or char_length(caption) <= 140),
  sort_order      integer not null default 0,
  width           integer not null check (width between 1 and 1600),
  height          integer not null check (height between 1 and 1600),
  sfw_attested_at timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint creator_media_path_shape check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
    and split_part(path, '/', 1) = creator_id::text
  )
);
create index if not exists creator_media_creator_idx
  on public.creator_media (creator_id, sort_order, created_at);

alter table public.creator_media enable row level security;

drop policy if exists creator_media_select on public.creator_media;
create policy creator_media_select on public.creator_media for select
  using ((public.can_act_for(creator_id, 'view') and public.current_user_active()) or public.is_admin());

drop policy if exists creator_media_update on public.creator_media;
create policy creator_media_update on public.creator_media for update
  using (creator_id = auth.uid() and public.current_user_active())
  with check (creator_id = auth.uid() and public.current_user_active());

drop policy if exists creator_media_delete on public.creator_media;
create policy creator_media_delete on public.creator_media for delete
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

-- Anon never touches the table. A signed-in creator may read (RLS), delete
-- (RLS) and change only the caption and order; never insert, and never move a
-- row's path, owner, size or attestation.
revoke all on table public.creator_media from anon;
revoke insert, update on table public.creator_media from authenticated;
grant update (caption, sort_order) on table public.creator_media to authenticated;

create or replace function public.creator_media_cap()
returns trigger language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('creator_media:' || new.creator_id::text));
  if (select count(*) from public.creator_media where creator_id = new.creator_id) >= 12 then
    raise exception 'creator media limit reached' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists creator_media_cap on public.creator_media;
create trigger creator_media_cap before insert on public.creator_media
  for each row execute function public.creator_media_cap();

create or replace function public.creator_media_unset_background()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set theme = (theme - 'bg_media_id') || jsonb_build_object('background', 'glow')
   where id = old.creator_id and theme ->> 'bg_media_id' = old.id::text;
  return old;
end;
$$;

drop trigger if exists creator_media_unset_background on public.creator_media;
create trigger creator_media_unset_background after delete on public.creator_media
  for each row execute function public.creator_media_unset_background();

create or replace function public.set_creator_theme(p_theme jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_font text := 'bricolage';
  v_bg text := 'glow';
  v_media uuid;
  v_out jsonb;
begin
  if p_theme is null or jsonb_typeof(p_theme) <> 'object' then
    raise exception 'invalid theme' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_theme) as k(key)
     where k.key not in ('font', 'background', 'bg_media_id')
  ) then
    raise exception 'invalid theme key' using errcode = '22023';
  end if;
  if p_theme ? 'font' then
    if jsonb_typeof(p_theme -> 'font') <> 'string'
       or (p_theme ->> 'font') not in ('bricolage', 'playfair', 'dm-serif', 'syne', 'fraunces', 'unbounded') then
      raise exception 'invalid theme font' using errcode = '22023';
    end if;
    v_font := p_theme ->> 'font';
  end if;
  if p_theme ? 'background' then
    if jsonb_typeof(p_theme -> 'background') <> 'string'
       or (p_theme ->> 'background') not in ('glow', 'velvet', 'noir', 'aurora', 'solid', 'photo') then
      raise exception 'invalid theme background' using errcode = '22023';
    end if;
    v_bg := p_theme ->> 'background';
  end if;
  if v_bg = 'photo' then
    if jsonb_typeof(p_theme -> 'bg_media_id') is distinct from 'string'
       or (p_theme ->> 'bg_media_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
    v_media := (p_theme ->> 'bg_media_id')::uuid;
    if not exists (
      select 1 from public.creator_media m where m.id = v_media and m.creator_id = auth.uid()
    ) then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
  elsif p_theme ? 'bg_media_id' and jsonb_typeof(p_theme -> 'bg_media_id') <> 'null' then
    raise exception 'invalid theme photo' using errcode = '22023';
  end if;

  v_out := jsonb_build_object('font', v_font, 'background', v_bg);
  if v_media is not null then
    v_out := v_out || jsonb_build_object('bg_media_id', v_media);
  end if;
  update public.profiles set theme = v_out where id = auth.uid() and is_active = true;
  if not found then
    return null;
  end if;
  return v_out;
end;
$$;

revoke execute on function public.set_creator_theme(jsonb) from public, anon;
grant execute on function public.set_creator_theme(jsonb) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creator-media', 'creator-media', true, 2097152, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 0058 storage durability tail. Requires the integrated 0054–0056 foundation.
-- Client DELETE would discard the retry path before storage is removed.
-- All photo removal now goes through the authorized durable server queue.
revoke delete on table public.creator_media from public, anon, authenticated;

-- These records deliberately have no auth/profile/media FK: retries must
-- survive an auth cascade. Paths are random names, never credentials/tokens.
create table if not exists public.creator_storage_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  bucket text not null check (bucket in ('avatars', 'creator-media')),
  path text not null,
  upload_state text not null check (upload_state in ('inflight', 'stored', 'rejected', 'uncertain')),
  cleanup_kind text not null default 'none' check (cleanup_kind in ('none', 'orphan', 'media', 'account')),
  media_id uuid,
  audit_actor uuid,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  published_at timestamptz,
  removed_at timestamptz,
  unique (bucket, path),
  constraint creator_storage_object_scope check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|jpeg|gif|webp|avif)$'
    and split_part(path, '/', 1) = owner_id::text
  )
);
create index if not exists creator_storage_objects_work_idx on public.creator_storage_objects (cleanup_kind, updated_at) where removed_at is null;
create index if not exists creator_storage_objects_owner_idx on public.creator_storage_objects (owner_id);
alter table public.creator_storage_objects enable row level security;
drop policy if exists creator_storage_objects_read on public.creator_storage_objects;
create policy creator_storage_objects_read on public.creator_storage_objects for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
revoke all on table public.creator_storage_objects from public, anon, authenticated;
grant select on table public.creator_storage_objects to authenticated;
grant all on table public.creator_storage_objects to service_role;

create table if not exists public.creator_storage_deletions (
  owner_id uuid primary key,
  id uuid not null unique default gen_random_uuid(),
  state text not null check (state in ('pending', 'auth_deleting', 'auth_deleted', 'complete', 'paused')),
  was_role text not null check (was_role in ('admin', 'creator')),
  was_active boolean not null,
  actor_id uuid,
  action text not null check (action in ('account.delete', 'account.self_close')),
  link_hashes jsonb not null default '[]'::jsonb check (jsonb_typeof(link_hashes) = 'array' and jsonb_array_length(link_hashes) <= 100000)
    check (link_hashes::text ~ '^\[("[0-9a-f]{64}"(, "[0-9a-f]{64}")*)?\]$'),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists creator_storage_deletions_work_idx on public.creator_storage_deletions (state, updated_at);
alter table public.creator_storage_deletions enable row level security;
drop policy if exists creator_storage_deletions_read on public.creator_storage_deletions;
create policy creator_storage_deletions_read on public.creator_storage_deletions for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
revoke all on table public.creator_storage_deletions from public, anon, authenticated;
grant select on table public.creator_storage_deletions to authenticated;
grant all on table public.creator_storage_deletions to service_role;

-- Recheck eligibility under the same owner lock at the media-row write too.
-- This closes the upload-publication -> service INSERT quiescence race.
create or replace function public.creator_media_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_active boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || new.creator_id::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_active
    from public.profiles where id = new.creator_id for update;
  if v_active is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = new.creator_id and state not in ('paused', 'complete')) then
    raise exception 'creator media forbidden' using errcode = '42501';
  end if;
  if (select count(*) from public.creator_media where creator_id = new.creator_id) >= 12 then
    raise exception 'creator media limit reached' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke execute on function public.creator_media_cap() from public, anon, authenticated;
grant execute on function public.creator_media_cap() to service_role;
revoke execute on function public.creator_media_unset_background() from public, anon, authenticated;
grant execute on function public.creator_media_unset_background() to service_role;
grant all on table public.creator_media to service_role;

-- The new setter must retain0056's active/approval predicate.
create or replace function public.set_creator_theme(p_theme jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_font text := 'bricolage';
  v_bg text := 'glow';
  v_media uuid;
  v_out jsonb;
begin
  if p_theme is null or jsonb_typeof(p_theme) <> 'object' then
    raise exception 'invalid theme' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_theme) as k(key)
     where k.key not in ('font', 'background', 'bg_media_id')
  ) then
    raise exception 'invalid theme key' using errcode = '22023';
  end if;
  if p_theme ? 'font' then
    if jsonb_typeof(p_theme -> 'font') <> 'string'
       or (p_theme ->> 'font') not in ('bricolage', 'playfair', 'dm-serif', 'syne', 'fraunces', 'unbounded') then
      raise exception 'invalid theme font' using errcode = '22023';
    end if;
    v_font := p_theme ->> 'font';
  end if;
  if p_theme ? 'background' then
    if jsonb_typeof(p_theme -> 'background') <> 'string'
       or (p_theme ->> 'background') not in ('glow', 'velvet', 'noir', 'aurora', 'solid', 'photo') then
      raise exception 'invalid theme background' using errcode = '22023';
    end if;
    v_bg := p_theme ->> 'background';
  end if;
  if v_bg = 'photo' then
    if jsonb_typeof(p_theme -> 'bg_media_id') is distinct from 'string'
       or (p_theme ->> 'bg_media_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
    v_media := (p_theme ->> 'bg_media_id')::uuid;
    if not exists (
      select 1 from public.creator_media m where m.id = v_media and m.creator_id = auth.uid()
    ) then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
  elsif p_theme ? 'bg_media_id' and jsonb_typeof(p_theme -> 'bg_media_id') <> 'null' then
    raise exception 'invalid theme photo' using errcode = '22023';
  end if;

  v_out := jsonb_build_object('font', v_font, 'background', v_bg);
  if v_media is not null then
    v_out := v_out || jsonb_build_object('bg_media_id', v_media);
  end if;
  update public.profiles set theme = v_out where id = auth.uid() and is_active = true and public.current_user_active();
  if not found then
    return null;
  end if;
  return v_out;
end;
$$;

revoke execute on function public.set_creator_theme(jsonb) from public, anon;
grant execute on function public.set_creator_theme(jsonb) to authenticated;

alter table public.creator_storage_objects add column if not exists upload_registered boolean not null default false;

create or replace function public.creator_storage_register_upload(p_id uuid, p_owner uuid, p_bucket text, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok
    from public.profiles where id = p_owner for update;
  if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](webp|png|jpg|jpeg|gif)$' or v_ok is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = p_owner and state not in ('paused', 'complete')) then
    raise exception 'creator upload forbidden' using errcode = '42501';
  end if;
  -- A duplicate registration never grants permission to launch another upload
  -- to the same immutable path. Retries create a fresh, separately tracked id.
  insert into public.creator_storage_objects (id, owner_id, bucket, path, upload_state,upload_registered)
    values (p_id, p_owner, p_bucket, p_path, 'inflight',true);
  return jsonb_build_object('id', p_id, 'registered', true);
end; $$;

create or replace function public.creator_storage_finish_upload(p_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_ok boolean; v_object public.creator_storage_objects%rowtype;
begin
  if p_outcome not in ('stored', 'rejected', 'uncertain', 'cleanup', 'publish') then raise exception 'invalid upload outcome' using errcode = '22023'; end if;
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then raise exception 'upload intent missing' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = v_owner for update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  v_ok := coalesce(v_ok, false) and v_object.expires_at > now() and not exists (select 1 from public.creator_storage_deletions where owner_id = v_owner and state not in ('paused', 'complete'));
  update public.creator_storage_objects set
    upload_state = case when upload_state in ('stored', 'rejected') or p_outcome in ('cleanup', 'publish') then upload_state else p_outcome end,
    settled_at = case when p_outcome in ('stored', 'rejected') then coalesce(settled_at, now()) else settled_at end,
    cleanup_kind = case when cleanup_kind = 'none' and (not v_ok or p_outcome in ('rejected', 'uncertain', 'cleanup')) then 'orphan' else cleanup_kind end,
    media_id = case when p_outcome='cleanup' then coalesce(media_id,(select m.id from public.creator_media m where m.creator_id=creator_storage_objects.owner_id and m.path=creator_storage_objects.path)) else media_id end,
    updated_at = now()
    where id = p_id returning * into v_object;
  v_ok := v_ok and v_object.upload_state = 'stored' and v_object.cleanup_kind = 'none' and v_object.removed_at is null;
  if p_outcome = 'publish' and v_ok then update public.creator_storage_objects set published_at = coalesce(published_at, now()) where id = p_id; end if;
  return v_ok;
end; $$;

create or replace function public.creator_storage_queue_remove(p_owner uuid, p_objects jsonb, p_actor uuid default null, p_admin boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_ok boolean; v_count integer := 0;
begin
  if jsonb_typeof(p_objects) is distinct from 'array' or jsonb_array_length(p_objects) not between 1 and 12 then raise exception 'invalid removal batch' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = p_owner for update;
  if p_admin then
    if not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active) then raise exception 'admin required' using errcode = '42501'; end if;
  elsif v_ok is distinct from true or p_actor is distinct from p_owner then raise exception 'creator removal forbidden' using errcode = '42501'; end if;
  for v_item in select value from jsonb_array_elements(p_objects) loop
    if not exists (select 1 from public.creator_media where id = (v_item ->> 'id')::uuid and creator_id = p_owner and path = v_item ->> 'path') then raise exception 'media scope mismatch' using errcode = '42501'; end if;
    insert into public.creator_storage_objects (owner_id, bucket, path, upload_state, cleanup_kind, media_id, audit_actor, settled_at)
      values (p_owner, 'creator-media', v_item ->> 'path', 'stored', 'media', (v_item ->> 'id')::uuid, case when p_admin then p_actor else null end, now())
      on conflict (bucket, path) do update set
        cleanup_kind = 'media', media_id = excluded.media_id, removed_at = null,
        audit_actor = coalesce(public.creator_storage_objects.audit_actor, excluded.audit_actor),
        upload_state = 'stored', settled_at = coalesce(public.creator_storage_objects.settled_at, now()), updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

create or replace function public.creator_storage_complete_remove(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype;
begin
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  perform id from public.profiles where id = v_owner for update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  if v_object.cleanup_kind = 'none' or v_object.upload_state not in ('stored', 'rejected') then return false; end if;
  if v_object.removed_at is not null then return true; end if;
  if v_object.media_id is not null then
    delete from public.creator_media where id = v_object.media_id and creator_id = v_object.owner_id and path = v_object.path;
  end if;
  update public.creator_storage_objects set removed_at = now(), updated_at = now(), last_error = null where id = p_id;
  if v_object.audit_actor is not null then
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_object.id, v_object.audit_actor, 'account.media_remove', 'profile', v_object.owner_id, jsonb_build_object('photosRemoved', 1))
      on conflict (id) do nothing;
  end if;
  return true;
end; $$;

-- Every external destructive call has a durable immutable dispatch record.
alter table public.creator_storage_objects add column if not exists deletion_attempt uuid;
alter table public.creator_storage_objects add column if not exists last_attempt_at timestamptz;
alter table public.creator_storage_objects add column if not exists next_attempt_at timestamptz not null default now();
alter table public.creator_storage_deletions add column if not exists attempt_id uuid not null default gen_random_uuid();
alter table public.creator_storage_deletions add column if not exists restore_allowed boolean not null default true;

-- A later security decision must survive a failed deletion. UPDATE OF counts
-- even an admin's same-value is_active=false write while this account is already
-- quiesced. Only the service-owned job holds the restoration fence; client GUCs,
-- editable metadata and profile values cannot re-arm it. Profile UPDATE has
-- already locked its row before this trigger locks the job (the account worker
-- uses the same profile -> job order).
create or replace function public.creator_storage_security_write()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_pending boolean;
begin
 select state in ('pending','auth_deleting','auth_deleted') into v_pending
  from public.creator_storage_deletions where owner_id=new.id for update;
 if coalesce(v_pending,false) then
  if new.is_active then
   raise exception 'account cleanup pending' using errcode='42501';
  end if;
  update public.creator_storage_deletions set restore_allowed=false where owner_id=new.id;
 end if;
 return new;
end; $$;
revoke execute on function public.creator_storage_security_write() from public,anon,authenticated;
grant execute on function public.creator_storage_security_write() to service_role;
drop trigger if exists creator_storage_security_write on public.profiles;
create trigger creator_storage_security_write before update of role,is_active,approval_status on public.profiles
 for each row execute function public.creator_storage_security_write();


create table if not exists public.creator_storage_dispatches (
 id uuid primary key,
 owner_id uuid not null,
 attempt_id uuid,
 worker_id uuid,
 kind text not null check (kind in ('remove','auth','manifest')),
 object_id uuid,
 bucket text check (bucket in ('avatars','creator-media')),
 path text,
 state text not null default 'pending' check (state in ('pending','acknowledged','rejected','uncertain')),
 created_at timestamptz not null default now(),
 settled_at timestamptz,
 constraint creator_storage_dispatch_scope check (
   (kind='auth' and object_id is null and bucket is null and path is null and attempt_id is not null) or
   (kind in ('remove','manifest') and object_id is not null and bucket is not null and path is not null and split_part(path,'/',1)=owner_id::text)
 )
);
create unique index if not exists creator_storage_manifest_item_idx on public.creator_storage_dispatches(attempt_id,object_id) where kind='manifest';
create index if not exists creator_storage_dispatches_owner_idx on public.creator_storage_dispatches(owner_id,state);
alter table public.creator_storage_dispatches enable row level security;
drop policy if exists creator_storage_dispatches_read on public.creator_storage_dispatches;
create policy creator_storage_dispatches_read on public.creator_storage_dispatches for select to authenticated
 using (owner_id=auth.uid() or public.is_admin());
revoke all on public.creator_storage_dispatches from public, anon, authenticated;
grant select on public.creator_storage_dispatches to authenticated;
grant all on public.creator_storage_dispatches to service_role;

-- Registration remains UUID/immutable; a fenced manifest also records older
-- safe nested/replaced paths that predate the upload-intent protocol.
alter table public.creator_storage_objects drop constraint if exists creator_storage_object_scope;
alter table public.creator_storage_objects add constraint creator_storage_object_scope check (
 split_part(path,'/',1)=owner_id::text and length(path)<=2048 and
 path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$' and
 path !~ '(^|/)[.]{1,2}(/|$)'
);

create or replace function public.creator_storage_manifest(p_owner uuid,p_attempt uuid,p_worker uuid,p_bucket text,p_paths jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_job public.creator_storage_deletions%rowtype; v_path text; v_count integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||p_owner::text,0));
 select * into v_job from public.creator_storage_deletions where owner_id=p_owner for update;
 if v_job.attempt_id is distinct from p_attempt or v_job.lease_id is distinct from p_worker or v_job.lease_until<=now() or
    v_job.state not in ('pending','auth_deleting') or exists(select 1 from public.profiles where id=p_owner and is_active) then return null; end if;
 if p_bucket not in ('avatars','creator-media') or jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths)>100 then raise exception 'invalid manifest' using errcode='22023'; end if;
 for v_path in select jsonb_array_elements_text(p_paths) loop
  insert into public.creator_storage_objects(owner_id,bucket,path,upload_state,cleanup_kind,settled_at,deletion_attempt,media_id)
   values(p_owner,p_bucket,v_path,'stored','account',now(),p_attempt,(select id from public.creator_media where creator_id=p_owner and path=v_path))
   on conflict(bucket,path) do update set cleanup_kind='account',deletion_attempt=p_attempt,upload_state='stored',settled_at=coalesce(public.creator_storage_objects.settled_at,now()),removed_at=null,updated_at=now()
   where public.creator_storage_objects.owner_id=p_owner;
  if not found then raise exception 'manifest scope mismatch' using errcode='42501'; end if;
  insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind,object_id,bucket,path,state,settled_at)
   select gen_random_uuid(),p_owner,p_attempt,p_worker,'manifest',id,bucket,path,'acknowledged',now() from public.creator_storage_objects where owner_id=p_owner and bucket=p_bucket and path=v_path
   on conflict(attempt_id,object_id) where kind='manifest' do nothing;
  v_count:=v_count+1;
 end loop;
 return v_count;
end; $$;

create or replace function public.creator_storage_dispatch(p_operation text,p_id uuid,p_owner uuid,p_kind text default null,p_attempt uuid default null,p_worker uuid default null,p_object uuid default null,p_outcome text default null,p_origin_upload boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_job public.creator_storage_deletions%rowtype; v_object public.creator_storage_objects%rowtype; v_call public.creator_storage_dispatches%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||p_owner::text,0));
 select * into v_job from public.creator_storage_deletions where owner_id=p_owner for update;
 if p_operation='begin' then
  if exists(select 1 from public.creator_storage_dispatches where id=p_id) then return jsonb_build_object('dispatch',false); end if;
  if p_attempt is not null then
   if v_job.attempt_id is distinct from p_attempt or v_job.lease_id is distinct from p_worker or v_job.lease_until<=now() or v_job.state not in ('pending','auth_deleting') or exists(select 1 from public.profiles where id=p_owner and is_active) then return null; end if;
  end if;
  if p_kind='remove' then
   select * into v_object from public.creator_storage_objects where id=p_object and owner_id=p_owner for update;
   if v_object.id is null or v_object.cleanup_kind='none' or v_object.upload_state not in ('stored','rejected') or v_object.removed_at is not null or (p_attempt is not null and v_object.deletion_attempt is distinct from p_attempt) then return null; end if;
   if p_attempt is not null and not exists(select 1 from public.creator_storage_dispatches where kind='manifest' and owner_id=p_owner and attempt_id=p_attempt and object_id=v_object.id and bucket=v_object.bucket and path=v_object.path) then return null; end if;
   if p_attempt is null and (v_object.cleanup_kind='account' or (v_job.owner_id is not null and v_job.state not in ('paused','complete'))) and not (p_origin_upload and v_object.upload_registered and v_object.published_at is null) then return null; end if;
   insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind,object_id,bucket,path)
    values(p_id,p_owner,p_attempt,p_worker,p_kind,v_object.id,v_object.bucket,v_object.path);
  elsif p_kind='auth' and p_attempt is not null and v_job.state='auth_deleting' then
   insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind) values(p_id,p_owner,p_attempt,p_worker,p_kind);
  else raise exception 'invalid dispatch' using errcode='22023'; end if;
  return jsonb_build_object('dispatch',true);
 elsif p_operation='finish' then
  if p_outcome not in ('acknowledged','rejected','uncertain') then raise exception 'invalid dispatch outcome' using errcode='22023'; end if;
  select * into v_call from public.creator_storage_dispatches where id=p_id and owner_id=p_owner for update;
  if v_call.id is null then return null; end if;
  if v_call.state in ('acknowledged','rejected') then return jsonb_build_object('state',v_call.state); end if;
  -- Completion can be recorded by a lease-expired worker, but cannot authorize
  -- another dispatch or change a later attempt's manifest.
  update public.creator_storage_dispatches set state=p_outcome,settled_at=case when p_outcome='uncertain' then null else now() end where id=p_id;
  if p_outcome='acknowledged' and v_call.kind='remove' then
   if not public.creator_storage_complete_remove(v_call.object_id) then raise exception 'removal completion failed' using errcode='40001'; end if;
  end if;
  return jsonb_build_object('state',p_outcome);
 end if;
 raise exception 'invalid dispatch operation' using errcode='22023';
end; $$;

-- Media publication, metadata creation and intent binding are one idempotent
-- transaction. An INSERT acknowledgement loss cannot detach bytes from a row.
create or replace function public.creator_storage_publish_media(p_id uuid,p_caption text,p_width integer,p_height integer,p_sort_order integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype; v_media public.creator_media%rowtype; v_ok boolean;
begin
 select owner_id into v_owner from public.creator_storage_objects where id=p_id;
 if v_owner is null then raise exception 'upload missing' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||v_owner::text,0));
 select is_active and (approval_status='approved' or role='admin') into v_ok from public.profiles where id=v_owner for update;
 select * into v_object from public.creator_storage_objects where id=p_id for update;
 select * into v_media from public.creator_media where id=p_id and creator_id=v_owner and path=v_object.path;
 if v_media.id is not null and v_object.media_id=p_id and v_object.cleanup_kind='none' and v_object.removed_at is null then return to_jsonb(v_media); end if;
 if v_ok is distinct from true or v_object.bucket<>'creator-media' or v_object.upload_state<>'stored' or v_object.cleanup_kind<>'none' or v_object.removed_at is not null or v_object.expires_at<=now() or exists(select 1 from public.creator_storage_deletions where owner_id=v_owner and state not in ('paused','complete')) then raise exception 'media publication forbidden' using errcode='42501'; end if;
 insert into public.creator_media(id,creator_id,path,caption,width,height,sort_order,sfw_attested_at)
 values(p_id,v_owner,v_object.path,p_caption,p_width,p_height,p_sort_order,now()) returning * into v_media;
 update public.creator_storage_objects set media_id=p_id,published_at=now(),updated_at=now() where id=p_id;
 return to_jsonb(v_media);
end; $$;

-- Claim updates the schedule before inspecting bytes, including on a crash or
-- an absent uncertain object. All eligible categories share one fair queue.
create or replace function public.creator_storage_work_claim(p_limit integer default 20)
returns jsonb language sql security definer set search_path=public as $$
 with candidates as (
  select id from public.creator_storage_objects
   where removed_at is null and cleanup_kind<>'account' and next_attempt_at<=now()
    and (cleanup_kind<>'none' or (published_at is null and expires_at<now()))
   order by next_attempt_at,last_attempt_at nulls first,created_at,id
   for update skip locked limit least(greatest(p_limit,1),20)
 ), claimed as (
 update public.creator_storage_objects o set attempts=o.attempts+1,last_attempt_at=now(),
  next_attempt_at=now()+make_interval(secs=>least(900,5*power(2,least(o.attempts,8)))::integer),updated_at=now()
 from candidates c where o.id=c.id returning o.*
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) from claimed;
$$;

revoke execute on function public.creator_storage_manifest(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.creator_storage_manifest(uuid,uuid,uuid,text,jsonb) to service_role;
revoke execute on function public.creator_storage_dispatch(text,uuid,uuid,text,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.creator_storage_dispatch(text,uuid,uuid,text,uuid,uuid,uuid,text,boolean) to service_role;
revoke execute on function public.creator_storage_publish_media(uuid,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.creator_storage_publish_media(uuid,text,integer,integer,integer) to service_role;
revoke execute on function public.creator_storage_work_claim(integer) from public,anon,authenticated;
grant execute on function public.creator_storage_work_claim(integer) to service_role;

create or replace function public.creator_storage_account(p_operation text, p_owner uuid, p_was_admin boolean default false, p_worker uuid default null, p_actor uuid default null, p_action text default 'account.self_close', p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.creator_storage_deletions%rowtype; v_profile public.profiles%rowtype; v_hashes jsonb; v_reserve text;
begin
  if p_error is not null and p_error not in ('storage_cleanup_failed', 'delete_failed', 'db_error', 'upload_unconfirmed') then raise exception 'invalid work error' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select * into v_profile from public.profiles where id = p_owner for update;
  select * into v_job from public.creator_storage_deletions where owner_id = p_owner for update;
  if p_operation = 'begin' then
    if (p_action = 'account.self_close' and p_actor is distinct from p_owner) or
       (p_action = 'account.delete' and (p_actor = p_owner or not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active))) or
       p_action not in ('account.self_close', 'account.delete') then raise exception 'deletion actor forbidden' using errcode = '42501'; end if;
    if v_job.owner_id is not null and v_job.state <> 'paused' then
      return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
    end if;
    if v_profile.id is null then raise exception 'account missing' using errcode = '22023'; end if;
    -- Reservation and durable quiescence commit together: a crash cannot leave
    -- an admin demoted with no deletion record to resume or restore.
    v_reserve := public.reserve_self_account_deletion(p_owner);
    if v_reserve <> 'ok' then return jsonb_build_object('error', v_reserve); end if;
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') h from public.fan_passes where creator_id = p_owner) hashes;
    if jsonb_array_length(v_hashes) > 100000 then raise exception 'too many links' using errcode = '54000'; end if;
    insert into public.creator_storage_deletions (owner_id, state, was_role, was_active, actor_id, action, link_hashes)
      values (p_owner, 'pending', v_profile.role, v_profile.is_active, p_actor, p_action, v_hashes)
      on conflict (owner_id) do update set state = 'pending', attempt_id=gen_random_uuid(), was_role = excluded.was_role, was_active = excluded.was_active, actor_id = excluded.actor_id, action = excluded.action,
        link_hashes = excluded.link_hashes, lease_id = null, lease_until = null, updated_at = now(), last_error = null
      returning * into v_job;
    update public.profiles set is_active = false where id = p_owner;
    -- Re-arm only after our own reservation/quiescence updates, with the
    -- profile row still locked. An external admin cannot interleave here.
    update public.creator_storage_deletions set restore_allowed=true where owner_id=p_owner;
    update public.creator_storage_objects set cleanup_kind = 'account', deletion_attempt=v_job.attempt_id, updated_at = now() where owner_id = p_owner and removed_at is null;
    insert into public.creator_storage_dispatches(id,owner_id,attempt_id,kind,object_id,bucket,path,state,settled_at)
      select gen_random_uuid(),p_owner,v_job.attempt_id,'manifest',id,bucket,path,'acknowledged',now() from public.creator_storage_objects where owner_id=p_owner and removed_at is null
      on conflict(attempt_id,object_id) where kind='manifest' do nothing;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.owner_id is null then return null; end if;
  if v_job.state = 'complete' then return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes)); end if;
  if p_operation = 'claim' then
    if v_job.state in ('paused', 'complete') or (v_job.lease_until > now() and v_job.lease_id is distinct from p_worker) then return null; end if;
    if p_worker is null then raise exception 'worker id required' using errcode = '22023'; end if;
    update public.creator_storage_deletions set lease_id = p_worker, lease_until = now() + interval '3 minutes', attempts = attempts + 1, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.lease_id is distinct from p_worker or v_job.lease_until <= now() then return null; end if;
  if p_operation = 'check' then
    update public.creator_storage_deletions set lease_until=now()+interval '3 minutes' where owner_id=p_owner;
    return jsonb_build_object('state',v_job.state,'attempt_id',v_job.attempt_id);
  end if;
  if p_operation = 'prepare' then
    if exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null and upload_state in ('inflight', 'uncertain')) then return jsonb_build_object('state', 'pending'); end if;
    if v_profile.id is not null and v_profile.is_active then raise exception 'account not quiesced' using errcode = '42501'; end if;
    -- Refresh hashes immediately before the auth call; only hashes survive it.
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct value h from jsonb_array_elements_text(v_job.link_hashes) union select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') from public.fan_passes where creator_id = p_owner) hashes;
    if exists(select 1 from public.creator_storage_objects where owner_id=p_owner and removed_at is null) then return jsonb_build_object('state','pending'); end if;
    update public.creator_storage_deletions set state = 'auth_deleting', link_hashes = v_hashes, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleting');
  elsif p_operation = 'auth_deleted' then
    if exists (select 1 from auth.users where id = p_owner) then return null; end if;
    update public.creator_storage_dispatches set state='acknowledged',settled_at=now() where owner_id=p_owner and kind='auth' and state in ('pending','uncertain');
    update public.creator_storage_deletions set state = 'auth_deleted', updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleted');
  elsif p_operation = 'complete' then
    if v_job.state <> 'auth_deleted' or exists (select 1 from auth.users where id = p_owner) or exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null) then return null; end if;
    insert into public.link_tombstones (token_hash, reason)
      select value, 'creator_closed' from jsonb_array_elements_text(v_job.link_hashes) on conflict (token_hash) do nothing;
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_job.id, v_job.actor_id, v_job.action, 'profile', p_owner, jsonb_build_object('role', v_job.was_role, 'fanLinks', jsonb_array_length(v_job.link_hashes))) on conflict (id) do nothing;
    update public.creator_storage_deletions set state = 'complete', completed_at = now(), updated_at = now(), lease_id = null, lease_until = null, last_error = null where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes));
  elsif p_operation = 'pause' then
    if v_profile.id is null or exists(select 1 from public.creator_storage_dispatches where owner_id=p_owner and state in ('pending','uncertain')) then return null; end if;
    -- Change the service-owned state before our restoration write, in this
    -- same transaction under profile -> job locks. This is the sole safe way
    -- to reopen an account; ordinary profile writes cannot bypass quiescence.
    update public.creator_storage_deletions set state = 'paused', last_error = p_error, updated_at = now(), lease_id = null, lease_until = null where owner_id = p_owner;
    if v_job.restore_allowed then
      update public.profiles set role = v_job.was_role::public.app_role, is_active = v_job.was_active where id = p_owner;
    end if;
    return jsonb_build_object('state', 'paused');
  elsif p_operation = 'release' then
    update public.creator_storage_deletions set lease_id = null, lease_until = null, last_error = p_error, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', v_job.state);
  end if;
  raise exception 'invalid storage operation' using errcode = '22023';
end; $$;

create or replace function public.creator_storage_prune(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  -- Uncertain/inflight work is never expired: absence is not completion proof.
  delete from public.creator_storage_objects where removed_at < now() - make_interval(days => greatest(p_days, 1)) and upload_state in ('stored', 'rejected') and not exists(select 1 from public.creator_storage_dispatches d where d.object_id=creator_storage_objects.id and d.state in ('pending','uncertain'));
  get diagnostics v_count = row_count;
  delete from public.creator_storage_deletions where state = 'complete' and completed_at < now() - make_interval(days => greatest(p_days, 1));
  delete from public.creator_storage_dispatches d where state in ('acknowledged','rejected') and settled_at<now()-make_interval(days=>greatest(p_days,1)) and (kind<>'manifest' or not exists(select 1 from public.creator_storage_deletions j where j.owner_id=d.owner_id and j.attempt_id=d.attempt_id and j.state not in ('complete','paused')));
  return v_count;
end; $$;

revoke execute on function public.creator_storage_register_upload(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_register_upload(uuid, uuid, text, text) to service_role;
revoke execute on function public.creator_storage_finish_upload(uuid, text) from public, anon, authenticated;
grant execute on function public.creator_storage_finish_upload(uuid, text) to service_role;
revoke execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) to service_role;
revoke execute on function public.creator_storage_complete_remove(uuid) from public, anon, authenticated;
grant execute on function public.creator_storage_complete_remove(uuid) to service_role;
revoke execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) to service_role;
revoke execute on function public.creator_storage_prune(integer) from public, anon, authenticated;
grant execute on function public.creator_storage_prune(integer) to service_role;
