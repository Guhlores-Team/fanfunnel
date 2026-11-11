-- 0069: batch-4 integration hardening (orch/fixes: 0067 + 0068 with the QA,
-- seats, hardening and stress branches). Additive and idempotent. Redefines
-- set_fan_pass_game (0065's definition plus one check) and schema_version();
-- everything else is a new guard or a grant change.
--
--  (a) A game with fewer than 2 prizes can no longer be chosen anywhere a game
--      is pinned or scheduled. The resolver serves such a game but every play
--      on it is refused (no_prizes), so the 2026-11-04 QA pass stopped the
--      dashboard pickers offering one (MIN_WHEEL_PRIZES, the wheel editor's
--      own minimum). That was a UI guard only; the database now refuses it for
--      every role, next to the existing not-archived / game_ready / known-kind
--      rule:
--        - set_fan_pass_game answers game_not_playable (the answer it already
--          gives for an archived or draft game);
--        - campaigns.pinned_wheel_id (written under campaigns_write RLS, or by
--          any role) must be the campaign creator's own unarchived, ready game
--          of a known kind with at least 2 prizes: trigger aa_campaign_game,
--          errors 'campaign game belongs to another creator' (42501),
--          game_not_playable and game_needs_prizes (22023). Re-saving an
--          unchanged pin is not re-checked, so a campaign whose game lost its
--          prizes or was archived later still saves (and keeps resolving as
--          before). The TS pre-check (campaignPinError) mirrors the rule.
--        - a schedule (wheels.active_from / active_until) can only be set or
--          changed on a game with at least 2 prizes: trigger
--          ac_game_schedule_prizes, error game_needs_prizes. Clearing one, or
--          re-saving it unchanged, is always allowed; aa_game_settings (0061)
--          already refuses a schedule on a draft.
--      The resolvers (_creator_default_wheel, _resolved_spin_wheel) are not
--      changed: ranking stays what wheelResolutionInterplay.test.ts pins for
--      SQL and TS, and a game that loses prizes after it was chosen is served
--      and refused at play exactly as before.
--  (b) INSERT on public.redemptions is revoked from authenticated. Awards are
--      written by commit_spin_attempt (SECURITY DEFINER) and no session-client
--      path inserts a redemption (grep: every from("redemptions") in src is a
--      read, update or delete); with Supabase's default grants a signed-in
--      creator could insert an extra award row for its own spin. The
--      redemptions_write policy keeps UPDATE and DELETE for fulfilment, and
--      set_redemption_state (0067) stays the status write.
--  (c) schema_version() reports 69.
--
-- Lock order unchanged (fan -> pass -> wheel -> prize); the new triggers take
-- no row locks beyond the row being written.

-- ── (a) the minimum prize count, one place ──────────────────────────────────
-- The same count the dashboard shows (prizes(id) per game): every prize row
-- of the game, whatever its stock or delivery.
create or replace function public._game_has_min_prizes(p_wheel uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (select count(*) from public.prizes where wheel_id = p_wheel) >= 2
$$;
revoke execute on function public._game_has_min_prizes(uuid) from public, anon, authenticated, service_role;
comment on function public._game_has_min_prizes(uuid) is 'True when the game has at least 2 prizes, the minimum a pinned or scheduled game must have (0069).';

-- set_fan_pass_game: 0065's definition plus the prize-count check.
create or replace function public.set_fan_pass_game(p_context uuid,p_creator uuid,p_pass uuid,p_wheel uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=coalesce(p_actor,p_creator); v_fan uuid; p public.fan_passes%rowtype;
begin
 if not public._creator_actor_context_valid(p_context,actor,p_creator,'grant') then return jsonb_build_object('status','forbidden'); end if;
 select fan_id into v_fan from public.fan_passes where id=p_pass and creator_id=p_creator;
 if v_fan is null then return jsonb_build_object('status','not_found'); end if;
 -- Fan before pass: the order a credited play and a grant use.
 perform 1 from public.fans where id=v_fan and creator_id=p_creator for update;
 select * into p from public.fan_passes where id=p_pass and creator_id=p_creator and fan_id=v_fan for update;
 if p.id is null or not p.is_active or p.self_excluded_at is not null then return jsonb_build_object('status','not_found'); end if;
 if not public._creator_actor_grant_allowed(actor,p_creator,p_context) then return jsonb_build_object('status','forbidden'); end if;
 if p_wheel is not null then
   if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator) then return jsonb_build_object('status','not_found'); end if;
   if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch','bingo')) then
     return jsonb_build_object('status','game_not_playable');
   end if;
   -- 0069: a game without enough prizes refuses every play, so it cannot be chosen.
   if not public._game_has_min_prizes(p_wheel) then return jsonb_build_object('status','game_not_playable'); end if;
 end if;
 if p.pinned_wheel_id is distinct from p_wheel then
   perform set_config('fanfunnel.pass_game_write',p.id::text,true);
   update public.fan_passes set pinned_wheel_id=p_wheel where id=p.id;
   perform set_config('fanfunnel.pass_game_write','',true);
 end if;
 return jsonb_build_object('status','ok','passId',p.id,'pinnedWheelId',p_wheel,'playsWheelId',public._resolved_spin_wheel(p.id));
end $$;
revoke execute on function public.set_fan_pass_game(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_fan_pass_game(uuid,uuid,uuid,uuid,uuid) to service_role;

-- The campaign's chosen game: same creator, playable, enough prizes.
-- SECURITY DEFINER like the 0068 tenant guards: the check must see the game
-- whatever the caller's RLS view is, and refuse for every role.
create or replace function public._guard_campaign_game()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.pinned_wheel_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.pinned_wheel_id = old.pinned_wheel_id and new.creator_id = old.creator_id then return new; end if;
  if not exists (select 1 from public.wheels w where w.id = new.pinned_wheel_id and w.creator_id = new.creator_id) then
    raise exception 'campaign game belongs to another creator' using errcode = '42501';
  end if;
  if not exists (select 1 from public.wheels w where w.id = new.pinned_wheel_id and w.archived_at is null and w.game_ready and w.game_kind in ('wheel', 'scratch', 'bingo')) then
    raise exception 'game_not_playable' using errcode = '22023';
  end if;
  if not public._game_has_min_prizes(new.pinned_wheel_id) then
    raise exception 'game_needs_prizes' using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function public._guard_campaign_game() from public, anon, authenticated, service_role;
drop trigger if exists aa_campaign_game on public.campaigns;
create trigger aa_campaign_game before insert or update of pinned_wheel_id, creator_id on public.campaigns
  for each row execute function public._guard_campaign_game();

-- A schedule needs a playable pool behind it.
create or replace function public._guard_game_schedule_prizes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.active_from is not null or new.active_until is not null)
     and (new.active_from is distinct from old.active_from or new.active_until is distinct from old.active_until)
     and not public._game_has_min_prizes(new.id) then
    raise exception 'game_needs_prizes' using errcode = '22023';
  end if;
  return new;
end $$;
revoke execute on function public._guard_game_schedule_prizes() from public, anon, authenticated, service_role;
drop trigger if exists ac_game_schedule_prizes on public.wheels;
create trigger ac_game_schedule_prizes before update of active_from, active_until on public.wheels
  for each row execute function public._guard_game_schedule_prizes();

-- ── (b) awards are written by the award only ────────────────────────────────
revoke insert on public.redemptions from authenticated;

-- ── (c) the migration level this database was built to ────────────────────
create or replace function public.schema_version()
returns integer language sql immutable as $$ select 69 $$;
revoke execute on function public.schema_version() from public, anon, authenticated;
grant execute on function public.schema_version() to service_role;
comment on function public.schema_version() is 'Migration level of this database (0069). Every migration redefines it with its own number; the app flags a database behind its expected level.';
