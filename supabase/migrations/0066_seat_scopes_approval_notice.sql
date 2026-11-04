-- 0066: agency seat scopes, the approval notice and alert-slot release
-- (audit #2: A19, A30, A27), and the last legacy spin RPC retired (A20). Additive and idempotent. Redefines the two 0064
-- queue/inbox RPCs from their 0064 definitions with one new trailing argument,
-- and claim_app_error_alert from its 0053 definition (same signature).
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
--  A27 claim_app_error_alert() took the hourly slot and cleared the pending
--      flags before the e-mail was sent, so a refused send lost the alert. The
--      claim now records which errors it covers and returns its alert_id;
--      release_app_error_alert(alert_id) (service role only) gives the slot
--      back and re-queues those errors for the next digest.
--  A20 rollback_claimed_spin (0038, pre-0059 spin path) was revoked from the
--      browser roles only; 0059 retired the rest of that path from service_role
--      too but missed it. It has no caller; it is now retired for every role.

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

-- ── A27: give an alert slot back when its e-mail was not accepted ─────────
alter table public.app_error_alerts add column if not exists requeue uuid[] not null default '{}';

create or replace function public.claim_app_error_alert(
  p_limit integer,
  p_error_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sent integer;
  v_pending integer;
  v_cleared uuid[];
  v_alert uuid;
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
  with cleared as (
    update public.app_errors set alert_pending = false where alert_pending returning id
  )
  select coalesce(array_agg(id), '{}') into v_cleared from cleared;

  insert into public.app_error_alerts (kind, errors, requeue)
  values (case when p_error_id is null then 'digest' else 'error' end,
          greatest(v_pending + case when p_error_id is null then 0 else 1 end, 1),
          case when p_error_id is null then v_cleared else array_append(array_remove(v_cleared, p_error_id), p_error_id) end)
  returning id into v_alert;
  return jsonb_build_object('send', true, 'pending', v_pending, 'alert_id', v_alert);
end;
$$;
revoke execute on function public.claim_app_error_alert(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_app_error_alert(integer, uuid) to service_role;

-- The e-mail for a claimed slot was refused or never reached Resend: drop the
-- slot (it no longer counts against the hourly budget) and mark the errors it
-- covered pending again, so the next digest reports them. False when the slot
-- is unknown (already released, or pruned after a day).
create or replace function public.release_app_error_alert(p_alert uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_requeue uuid[];
begin
  if p_alert is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('public.app_error_alerts'));
  delete from public.app_error_alerts where id = p_alert returning requeue into v_requeue;
  if not found then
    return false;
  end if;
  update public.app_errors set alert_pending = true
   where id = any(coalesce(v_requeue, '{}')) and not resolved;
  return true;
end;
$$;
revoke execute on function public.release_app_error_alert(uuid) from public, anon, authenticated;
grant execute on function public.release_app_error_alert(uuid) to service_role;

-- ── A20: retire the last pre-0059 spin RPC for the service role too ───────
revoke execute on function public.rollback_claimed_spin(text, uuid) from public, anon, authenticated, service_role;
