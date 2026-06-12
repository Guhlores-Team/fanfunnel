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
