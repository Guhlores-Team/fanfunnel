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
