-- 0067: cancelled-prize stock and a runtime schema version
-- (audit #2: A42, A39 residual). Additive and idempotent. Adds one column, one
-- trigger and two functions; redefines nothing.
--
--  A42 Cancelling a won prize only changed redemptions.status, so a limited
--      unit the win consumed was never returned and a creator who cancelled
--      and substituted lost it. Now every award records whether it holds a
--      unit (redemptions.stock_unit), and the unit moves exactly once per
--      transition:
--        'held'      the award consumed a finite unit of a manually delivered
--                    prize (a plain decrement, or a Chase-held unit converted).
--                    Written only inside the award transaction (the same
--                    fanfunnel.reward_finalization marker the 0065 award cost
--                    uses), computed from the prize there, never from input.
--        'returned'  the redemption was cancelled and the unit went back to
--                    prizes.stock (+1).
--        null        nothing to account: unlimited prizes, instant rewards
--                    (they are delivered and cannot be cancelled, 0057),
--                    code-list prizes (stock is the unused-code count), and
--                    awards older than 0067 that cannot be proven (below).
--      set_redemption_state() is the one write path for a status, note and
--      due-date patch. Cancelling a 'held' redemption returns the unit;
--      reopening a 'returned' one takes a unit again, or answers sold_out and
--      changes nothing when none is left. A repeat cancel or reopen is not a
--      transition and moves nothing. A prize made unlimited, deleted or turned
--      into a code list since the award is not touched (its unit is simply no
--      longer tracked). Bingo cells are always unlimited on an active card
--      (0061), so only a finite line prize can move, and the 0061 card guard
--      still applies to that write.
--      Lock order: wheel -> prize -> redemption, the suffix of the global
--      fan -> pass -> wheel -> prize order every award and wheel save takes,
--      so a cancel serialises with plays and with save_wheel_prizes. A save
--      already applies its edit as a delta over the live stock when it sends
--      expected_stock (0061), so a unit returned while the creator was editing
--      is kept, never overwritten.
--      Authorization: the RPC is callable by `authenticated` because it is
--      the same write the redemptions RLS already allowed (FOR ALL with
--      can_act_for(creator_id, 'fulfil') or is_admin()); it checks exactly
--      that, on auth.uid(), before reading anything. The guard trigger keeps
--      the bookkeeping honest for every role: stock_unit is written only by
--      the award and this RPC; a cancel or reopen of a unit-holding row must
--      go through the RPC; a redemption's spin and creator are immutable; an
--      insert must name its own spin's creator.
--      Backfill (once, when the column is added): a pending/in-progress/
--      fulfilled award is marked 'held' only when the play's own recorded
--      context shows the prize was finite at play time and it still is now,
--      it is manual and has no instant reward. Already-cancelled legacy
--      awards are left untracked: whether the creator restocked by hand is
--      unknowable, and returning a unit twice would oversell.
--  A39 schema_version() reports the migration level this database was built
--      to (67). Every later migration redefines it with its own number
--      (src/lib/operations/schemaVersion.test.ts enforces it), so it cannot
--      fall behind the files. Service role only (the server reads it with the
--      service client; no browser role needs it). Admin > System health and
--      the operational checks (manual and the daily maintenance cron) flag a
--      database that is behind the code's expected level.

-- ── A42: which awards hold a stock unit ───────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'redemptions' and column_name = 'stock_unit') then
    alter table public.redemptions add column stock_unit text;
    update public.redemptions r set stock_unit = 'held'
      from public.spins s
      join public.prizes p on p.id = s.prize_id
     where s.id = r.spin_id and s.creator_id = r.creator_id
       and r.status <> 'cancelled' and p.delivery = 'manual' and p.stock is not null
       and not exists (select 1 from public.spin_rewards w where w.spin_id = s.id)
       and r.id = (select r2.id from public.redemptions r2 where r2.spin_id = r.spin_id order by r2.created_at, r2.id limit 1)
       and exists (
         select 1 from public.spin_attempts a,
                jsonb_array_elements(case when jsonb_typeof(a.context->'prizes') = 'array' then a.context->'prizes' else '[]'::jsonb end) x
          where (a.id = coalesce(s.parent_spin_id, s.id) or a.spin_id = coalesce(s.parent_spin_id, s.id))
            and x->>'id' = p.id::text and jsonb_typeof(x->'stock') = 'number');
  end if;
end $$;
alter table public.redemptions drop constraint if exists redemptions_stock_unit_check;
alter table public.redemptions add constraint redemptions_stock_unit_check
  check (stock_unit is null or stock_unit in ('held', 'returned'));
comment on column public.redemptions.stock_unit is 'Finite prize unit this award accounts for (0067): held = consumed by the award, returned = given back to stock on cancel, null = none tracked. Written only by the award and set_redemption_state().';

create or replace function public._guard_redemption_stock_unit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_unit text;
begin
  if tg_op = 'INSERT' then
    select s.creator_id, case when p.stock is not null and p.delivery = 'manual' then 'held' end
      into v_creator, v_unit
      from public.spins s left join public.prizes p on p.id = s.prize_id
     where s.id = new.spin_id;
    if v_creator is distinct from new.creator_id then
      raise exception 'a redemption belongs to its spin''s creator' using errcode = '42501';
    end if;
    if current_setting('fanfunnel.reward_finalization', true) = new.spin_id::text then
      new.stock_unit := v_unit;
    elsif new.stock_unit is not null then
      raise exception 'a stock unit is recorded only by the award' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.spin_id is distinct from old.spin_id or new.creator_id is distinct from old.creator_id then
    raise exception 'a redemption''s spin and creator are immutable' using errcode = '42501';
  end if;
  if current_setting('fanfunnel.redemption_write', true) is distinct from new.id::text then
    if new.stock_unit is distinct from old.stock_unit then
      raise exception 'a stock unit is moved only by set_redemption_state' using errcode = '42501';
    end if;
    if old.stock_unit is not null and (new.status = 'cancelled') <> (old.status = 'cancelled') then
      raise exception 'cancel or reopen this prize through set_redemption_state' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._guard_redemption_stock_unit() from public, anon, authenticated;
drop trigger if exists redemptions_stock_unit_guard on public.redemptions;
create trigger redemptions_stock_unit_guard before insert or update on public.redemptions
  for each row execute function public._guard_redemption_stock_unit();

create or replace function public.set_redemption_state(p_redemption uuid, p_creator uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.redemptions%rowtype; s public.spins%rowtype; pr public.prizes%rowtype;
  v_status public.redemption_status; v_due timestamptz; v_unit text; v_stock text := 'none';
begin
  if auth.uid() is null then raise exception 'authenticated session required' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('status', 'notes', 'due_at'))
     or (p_patch ? 'status' and jsonb_typeof(p_patch->'status') <> 'string')
     or (p_patch ? 'notes' and jsonb_typeof(p_patch->'notes') not in ('string', 'null'))
     or (p_patch ? 'due_at' and jsonb_typeof(p_patch->'due_at') not in ('string', 'null'))
     or char_length(coalesce(p_patch->>'notes', '')) > 2000 then
    raise exception 'invalid redemption patch' using errcode = '22023';
  end if;
  v_status := (p_patch->>'status')::public.redemption_status;
  v_due := (p_patch->>'due_at')::timestamptz;
  -- The redemptions RLS predicate, on the caller, before any row is read.
  if p_creator is null or not (public.can_act_for(p_creator, 'fulfil') or public.is_admin()) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select s0.* into s from public.redemptions r0 join public.spins s0 on s0.id = r0.spin_id
   where r0.id = p_redemption and r0.creator_id = p_creator and s0.creator_id = p_creator;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  -- Wheel -> prize -> redemption: the suffix of every award's lock order.
  perform 1 from public.wheels where id = s.wheel_id and creator_id = p_creator for update;
  select p.* into pr from public.prizes p join public.spins s1 on s1.prize_id = p.id
   where s1.id = s.id and p.wheel_id = s.wheel_id for update of p;
  select * into r from public.redemptions where id = p_redemption and creator_id = p_creator for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  v_unit := r.stock_unit;
  if v_status is not null and (v_status = 'cancelled') <> (r.status = 'cancelled') then
    if v_status = 'cancelled' and r.stock_unit = 'held' then
      if pr.id is not null and pr.stock is not null and pr.delivery <> 'codes' then
        update public.prizes set stock = stock + 1 where id = pr.id;
        v_unit := 'returned'; v_stock := 'returned';
      else
        v_unit := null;
      end if;
    elsif v_status <> 'cancelled' and r.stock_unit = 'returned' then
      if pr.id is not null and pr.stock is not null and pr.delivery <> 'codes' then
        if pr.stock <= 0 then return jsonb_build_object('status', 'sold_out'); end if;
        update public.prizes set stock = stock - 1 where id = pr.id;
        v_unit := 'held'; v_stock := 'taken';
      else
        v_unit := null;
      end if;
    end if;
  end if;
  perform set_config('fanfunnel.redemption_write', r.id::text, true);
  update public.redemptions set
    status = coalesce(v_status, status),
    fulfilled_at = case when v_status is null then fulfilled_at when v_status = 'fulfilled' then now() else null end,
    notes = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    due_at = case when p_patch ? 'due_at' then v_due else due_at end,
    stock_unit = v_unit
   where id = r.id;
  perform set_config('fanfunnel.redemption_write', '', true);
  return jsonb_build_object('status', 'ok', 'stock', v_stock);
end $$;
revoke execute on function public.set_redemption_state(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_redemption_state(uuid, uuid, jsonb) to authenticated;
comment on function public.set_redemption_state(uuid, uuid, jsonb) is 'Patch a won prize (status, notes, due_at) and move its stock unit exactly once on cancel/reopen (0067). Checks can_act_for(creator, fulfil) or is_admin() on the caller.';

-- ── A39: the migration level this database was built to ───────────────────
create or replace function public.schema_version()
returns integer language sql immutable as $$ select 67 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0067). Every migration redefines it with its own number; the app flags a database behind its expected level.';
