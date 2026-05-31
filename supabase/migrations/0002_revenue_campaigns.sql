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
