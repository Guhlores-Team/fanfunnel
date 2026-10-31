-- 0066: agency seat scopes and the approval notice (audit #2: A19, A30).
-- Additive and idempotent. Redefines the two 0064 queue/inbox RPCs from their
-- 0064 definitions with one new trailing argument.
--
--  A19 A staff seat can do its job for the creators it is scoped to, and only
--      that job: creator_inbox_threads() and creator_redemption_queue() take an
--      optional p_creator. Without it (or with the caller's own id) they read
--      the caller's own rows exactly as before. With another creator's id they
--      return rows only when can_act_for(p_creator, 'chat') (inbox: owners,
--      managers, chatters scoped to that creator) or can_act_for(p_creator,
--      'fulfil') (queue: owners, managers, fulfillers scoped to that creator);
--      otherwise nothing. The inbox stays SECURITY INVOKER (messages RLS,
--      can_act_for 'view', applies on top). The queue joins spins, whose RLS
--      is creator-only, so it becomes SECURITY DEFINER and gates every row on
--      can_act_for itself: the caller's own queue needs can_act_for(self,
--      'view') exactly as the redemptions RLS did (enrolled MFA at aal1 reads
--      nothing), another creator's needs 'fulfil'. my_seat_creators() lists
--      the creators the caller may act for and which of the two jobs.
--  A30 creator_notices accepts a 'creator_approved' notice, left by the server
--      (service role) when an admin approves a creator.

-- ── A30: approval notice ──────────────────────────────────────────────────
alter table public.creator_notices drop constraint if exists creator_notices_kind_check;
alter table public.creator_notices add constraint creator_notices_kind_check
  check (kind in ('fan_deleted_data', 'creator_approved'));

-- ── A19: seat-scoped inbox ────────────────────────────────────────────────
drop function if exists public.creator_inbox_threads(timestamptz, uuid, integer);
create or replace function public.creator_inbox_threads(
  p_before_at timestamptz default null,
  p_before_fan uuid default null,
  p_limit integer default 50,
  p_creator uuid default null
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
  with target as (
    select coalesce(p_creator, auth.uid()) as id
     where p_creator is null or p_creator = auth.uid() or public.can_act_for(p_creator, 'chat')
  ), latest as (
    select distinct on (m.fan_id) m.fan_id, m.body, m.sender, m.created_at
      from public.messages m
      join target t on m.creator_id = t.id
     order by m.fan_id, m.created_at desc, m.id desc
  )
  select l.fan_id,
         coalesce(f.display_name, f.handle, 'Fan') as fan_name,
         l.body, l.sender, l.created_at,
         (select count(*)::integer from public.messages u, target t
           where u.creator_id = t.id and u.fan_id = l.fan_id
             and u.sender = 'fan' and u.read_at is null) as unread
    from latest l
    left join public.fans f on f.id = l.fan_id
   where p_before_at is null or (l.created_at, l.fan_id) < (p_before_at, p_before_fan)
   order by l.created_at desc, l.fan_id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke execute on function public.creator_inbox_threads(timestamptz, uuid, integer, uuid) from public, anon;
grant execute on function public.creator_inbox_threads(timestamptz, uuid, integer, uuid) to authenticated, service_role;

-- ── A19: seat-scoped fulfilment queue ─────────────────────────────────────
drop function if exists public.creator_redemption_queue(text, text, timestamptz, uuid, integer);
create or replace function public.creator_redemption_queue(
  p_status text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50,
  p_creator uuid default null
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
language sql stable security definer set search_path = public as $$
  with target as (
    select coalesce(p_creator, auth.uid()) as id
     where case when p_creator is null or p_creator = auth.uid()
                then public.can_act_for(auth.uid(), 'view')
                else public.can_act_for(p_creator, 'fulfil') end
  ), q as (
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
    join target t on r.creator_id = t.id
    join public.spins s on s.id = r.spin_id
    left join public.fans f on f.id = s.fan_id
    left join public.spin_rewards sr on sr.spin_id = s.id
    cross join pattern
   where (p_status is null or r.status::text = p_status)
     and (pattern.p is null
          or s.prize_label ilike pattern.p
          or f.display_name ilike pattern.p
          or f.handle ilike pattern.p)
     and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
revoke execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid) from public, anon;
grant execute on function public.creator_redemption_queue(text, text, timestamptz, uuid, integer, uuid) to authenticated, service_role;

-- ── A19: which creators a seat may act for ────────────────────────────────
-- Only the caller's own seats; each flag is can_act_for itself (MFA, activity,
-- approval and scope all apply). Creators the caller can do neither job for
-- are left out, as is the caller's own account.
create or replace function public.my_seat_creators()
returns table (creator_id uuid, display_name text, can_chat boolean, can_fulfil boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.display_name, c.can_chat, c.can_fulfil
    from (
      select distinct p.id, coalesce(p.display_name, 'Creator') as display_name,
             public.can_act_for(p.id, 'chat') as can_chat,
             public.can_act_for(p.id, 'fulfil') as can_fulfil
        from public.org_members m
        join public.profiles p on p.org_id = m.org_id
       where m.profile_id = auth.uid() and p.id <> auth.uid()
    ) c
   where c.can_chat or c.can_fulfil
   order by c.display_name, c.id
   limit 200;
$$;
revoke execute on function public.my_seat_creators() from public, anon;
grant execute on function public.my_seat_creators() to authenticated;
