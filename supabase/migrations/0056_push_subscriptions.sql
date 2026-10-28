-- 0056 Web push: closed-tab notifications for creators.
--
-- push_subscriptions: one row per browser/device a creator turned push on for.
-- The creator manages ONLY their own devices (list, remove, the per-device
-- "show names and prizes on the lock screen" switch, owner decision D9, off by
-- default). Columns a creator may write are granted explicitly: they insert
-- their own device and may update show_details and nothing else, so they can't
-- reassign a device to another account or forge the delivery bookkeeping
-- (last_success_at, failures). Suspended creators (is_active = false) lose
-- access through current_user_active(), like every creator-owned table (0032).
--
-- push_log: one row per notification sent to an account, so the same feed item
-- (event) is never pushed twice and a thread is throttled. Written only by the
-- server's service role; a creator can read their own rows and nothing else.
--
-- No functions: sending runs server-side through the service client
-- (src/lib/push/notify.ts, server-only), never from the browser.

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
