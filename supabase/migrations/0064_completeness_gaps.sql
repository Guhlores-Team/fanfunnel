-- 0064: completeness gaps (audit #2: A1, A5, A13, A16). Additive and idempotent.
--
--  A1  creator_reports gets a review trail: resolved/dismissed with a note,
--      stamped by the database (who, when), never by the caller.
--  A5  creator_redemption_queue(): the whole fulfilment queue, filtered and
--      keyset-paginated on the server, so every pending prize is reachable.
--  A13 creator_inbox_threads(): one row per fan thread (latest message plus
--      unread count), keyset-paginated, instead of reading every message.
--  A16 webhooks: a known event per hook, at most 5 hooks per creator, and a
--      per-creator signing secret that only the server can read.

-- ── A1: report review trail ───────────────────────────────────────────────
alter table public.creator_reports add column if not exists resolved_at timestamptz;
alter table public.creator_reports add column if not exists resolved_by uuid references public.profiles(id) on delete set null;
alter table public.creator_reports add column if not exists resolution_note text;

-- 0012 documented open | reviewed | actioned; nothing ever wrote the last two.
update public.creator_reports
   set status = 'resolved', resolved_at = coalesce(resolved_at, created_at)
 where status in ('reviewed', 'actioned');
update public.creator_reports
   set resolved_at = coalesce(resolved_at, created_at)
 where status <> 'open' and resolved_at is null;

alter table public.creator_reports drop constraint if exists creator_reports_status_check;
alter table public.creator_reports add constraint creator_reports_status_check
  check (status in ('open', 'resolved', 'dismissed'));
alter table public.creator_reports drop constraint if exists creator_reports_resolution_check;
alter table public.creator_reports add constraint creator_reports_resolution_check
  check ((status = 'open') = (resolved_at is null));
alter table public.creator_reports drop constraint if exists creator_reports_note_check;
alter table public.creator_reports add constraint creator_reports_note_check
  check (resolution_note is null or char_length(resolution_note) <= 1000);

create index if not exists creator_reports_reason_idx
  on public.creator_reports (reason, status, created_at desc);

-- Who resolved a report and when come from the session, never the request.
-- What the fan reported is immutable; fan_id/token may only be cleared (fan
-- deletion sets fan_id null, privacy erasure scrubs the token).
create or replace function public.creator_reports_review_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.id := old.id;
  new.creator_id := old.creator_id;
  new.reason := old.reason;
  new.detail := old.detail;
  new.created_at := old.created_at;
  if new.fan_id is not null then new.fan_id := old.fan_id; end if;
  if new.token is not null then new.token := old.token; end if;
  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.resolved_at := null;
      new.resolved_by := null;
      new.resolution_note := null;
    else
      new.resolved_at := now();
      new.resolved_by := auth.uid();
    end if;
  else
    new.resolved_at := old.resolved_at;
    -- Only clearable: deleting the reviewing admin's profile sets it null.
    if new.resolved_by is not null then new.resolved_by := old.resolved_by; end if;
    if new.status = 'open' then new.resolution_note := old.resolution_note; end if;
  end if;
  return new;
end; $$;
revoke execute on function public.creator_reports_review_stamp() from public, anon, authenticated;
grant execute on function public.creator_reports_review_stamp() to service_role;
drop trigger if exists creator_reports_review_stamp on public.creator_reports;
create trigger creator_reports_review_stamp before update on public.creator_reports
  for each row execute function public.creator_reports_review_stamp();

-- ── A5: the fulfilment queue, server-side ──────────────────────────────────
create index if not exists redemptions_creator_status_created_idx
  on public.redemptions (creator_id, status, created_at desc, id desc);

-- SECURITY INVOKER: the caller's RLS applies to every table read here, and the
-- rows are further pinned to the caller's own creator id.
create or replace function public.creator_redemption_queue(
  p_status text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  status public.redemption_status,
  created_at timestamptz,
  notes text,
  due_at timestamptz,
  prize_label text,
  prize_rarity public.prize_rarity,
  fan_name text,
  pool_snapshot jsonb,
  fair_trace jsonb,
  reward_kind text,
  reward_views integer,
  reward_last_viewed_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as raw
  ), pattern as (
    select case when raw is null then null
      else '%' || replace(replace(replace(left(raw, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' end as p
    from q
  )
  select r.id, r.status, r.created_at, r.notes, r.due_at,
         s.prize_label, s.prize_rarity,
         coalesce(f.display_name, f.handle, 'Fan') as fan_name,
         s.pool_snapshot, s.fair_trace,
         sr.kind, sr.views, sr.last_viewed_at
    from public.redemptions r
    join public.spins s on s.id = r.spin_id
    left join public.fans f on f.id = s.fan_id
    left join public.spin_rewards sr on sr.spin_id = s.id
    cross join pattern
   where r.creator_id = auth.uid()
     and (p_status is null or r.status::text = p_status)
     and (pattern.p is null
          or s.prize_label ilike pattern.p
          or f.display_name ilike pattern.p
          or f.handle ilike pattern.p)
     and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke all on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer) to authenticated, service_role;

-- ── A13: inbox threads, server-side ────────────────────────────────────────
create index if not exists messages_creator_fan_created_idx
  on public.messages (creator_id, fan_id, created_at desc, id desc);
create index if not exists messages_creator_unread_idx
  on public.messages (creator_id, fan_id) where sender = 'fan' and read_at is null;

create or replace function public.creator_inbox_threads(
  p_before_at timestamptz default null,
  p_before_fan uuid default null,
  p_limit integer default 50
)
returns table (
  fan_id uuid,
  fan_name text,
  last_body text,
  last_sender public.message_sender,
  last_at timestamptz,
  unread integer
)
language sql stable security invoker set search_path = public as $$
  with latest as (
    select distinct on (m.fan_id) m.fan_id, m.body, m.sender, m.created_at
      from public.messages m
     where m.creator_id = auth.uid()
     order by m.fan_id, m.created_at desc, m.id desc
  )
  select l.fan_id,
         coalesce(f.display_name, f.handle, 'Fan') as fan_name,
         l.body, l.sender, l.created_at,
         (select count(*)::integer from public.messages u
           where u.creator_id = auth.uid() and u.fan_id = l.fan_id
             and u.sender = 'fan' and u.read_at is null) as unread
    from latest l
    left join public.fans f on f.id = l.fan_id
   where p_before_at is null or (l.created_at, l.fan_id) < (p_before_at, p_before_fan)
   order by l.created_at desc, l.fan_id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke all on function public.creator_inbox_threads(timestamptz, uuid, integer) from public, anon;
grant execute on function public.creator_inbox_threads(timestamptz, uuid, integer) to authenticated, service_role;

-- ── A16: webhooks ──────────────────────────────────────────────────────────
-- 'all' = every win; otherwise only that event. Unknown legacy values become
-- the old default, which is what the UI always created.
update public.webhooks set event = 'prize_pending'
 where event not in ('prize_pending', 'prize_delivered', 'all');
alter table public.webhooks drop constraint if exists webhooks_event_check;
alter table public.webhooks add constraint webhooks_event_check
  check (event in ('prize_pending', 'prize_delivered', 'all'));

-- At most 5 hooks per creator, however the row is inserted (route or REST).
create or replace function public.webhooks_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('webhooks:' || new.creator_id::text, 64));
  if (select count(*) from public.webhooks where creator_id = new.creator_id) >= 5 then
    raise exception 'webhook limit reached' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke execute on function public.webhooks_cap() from public, anon, authenticated;
grant execute on function public.webhooks_cap() to service_role;
drop trigger if exists webhooks_cap on public.webhooks;
create trigger webhooks_cap before insert on public.webhooks
  for each row execute function public.webhooks_cap();

-- The HMAC key for X-FanFunnel-Signature. Written and read only by the server
-- (service role) after the route checks can_act_for(creator, 'manage'); no
-- API role holds a table privilege, and the only policy is admin read.
create table if not exists public.webhook_secrets (
  creator_id uuid primary key references public.profiles(id) on delete cascade,
  secret     text not null check (secret ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
alter table public.webhook_secrets enable row level security;
drop policy if exists webhook_secrets_admin_read on public.webhook_secrets;
create policy webhook_secrets_admin_read on public.webhook_secrets for select
  using (public.is_admin());
revoke all on table public.webhook_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.webhook_secrets to service_role;
