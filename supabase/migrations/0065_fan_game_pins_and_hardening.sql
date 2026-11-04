-- 0065: per-fan game pins and batch-3 hardening (audit #2: A11, A12, A17,
-- A35, A44; the 0063 initializer race). Additive and idempotent.
--
--  Pin   fan_passes.pinned_wheel_id: one fan link can be set to play one game
--        ("Change game for this fan only"). Resolution order, shared by
--        issuance and play through _creator_default_wheel: link pin ->
--        campaign pin -> open schedule -> is_active -> oldest (then the link's
--        stored game as the last fallback). Set only through the service RPC
--        set_fan_pass_game (0062 actor context, 'grant' scope); the pass guard
--        refuses another creator's game. Mirrored in src/lib/games/liveGame.ts.
--  A12   indexes on the spin_attempts foreign keys.
--  A11   run_retention_cleanup also trims visit check-ins, finished attempt
--        contexts, declined attempts, settled request journals, request
--        cancellation fences and old import batches.
--  A17   bootstrap_first_admin: the first-admin claim is one transaction under
--        the 0062 active-admin fence and needs the account's confirmed email.
--  A35   redemptions.cost_cents_at_award, captured in the commit transaction
--        and immutable afterwards; sessions can no longer delete a redemption.
--  A44   archive_wheel / delete_wheel take the game's Focus/Chase fans (and
--        the fans whose links are set to it) before the wheel row, the order a
--        credited play uses (fan -> pass -> ... -> wheel -> prize). delete_wheel
--        also refuses a game any fan link is stored on (the cascade would erase
--        that link and its balance).
--  0063  initialize_reward_crypto_canary starts its lock timeout after the
--        serializing advisory waits and answers an existing anchor before the
--        inventory fence, so a queued initializer never times out or reports
--        busy behind its predecessor's commit.
-- ── Per-fan game pin ───────────────────────────────────────────────────────
alter table public.fan_passes add column if not exists pinned_wheel_id uuid references public.wheels(id) on delete set null;
create index if not exists fan_passes_pinned_wheel_idx on public.fan_passes(pinned_wheel_id) where pinned_wheel_id is not null;
-- 0059 keeps authenticated reads to named columns (seeds stay private).
grant select(pinned_wheel_id) on public.fan_passes to authenticated;
comment on column public.fan_passes.pinned_wheel_id is 'The game this one fan link plays, before its campaign''s game and the live game (0065). Set via set_fan_pass_game.';

-- A link may only be set to its own creator's game. The resolver also ignores
-- a foreign or unplayable pin, but this refuses it for every role. The link's
-- own game is written only by set_fan_pass_game (which marks the pass it may
-- write in a transaction-local setting, like fanfunnel.economic_write): a
-- direct UPDATE (a team seat's PostgREST PATCH under fan_passes_write) would
-- skip the actor context, the MFA step-up and the playable check. The one
-- other writer is the pinned_wheel_id ON DELETE SET NULL of a deleted game.
create or replace function public.guard_atomic_pass_economy()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.fans where id=new.fan_id and creator_id=new.creator_id)
   or not exists(select 1 from public.wheels where id=new.wheel_id and creator_id=new.creator_id)
   or (new.campaign_id is not null and not exists(select 1 from public.campaigns where id=new.campaign_id and creator_id=new.creator_id))
   or (new.pinned_wheel_id is not null and not exists(select 1 from public.wheels where id=new.pinned_wheel_id and creator_id=new.creator_id)) then
   raise exception 'pass references another creator' using errcode='42501';
 end if;
 if ((tg_op='INSERT' and new.pinned_wheel_id is not null) or (tg_op='UPDATE' and new.pinned_wheel_id is distinct from old.pinned_wheel_id))
   and current_setting('fanfunnel.pass_game_write',true) is distinct from new.id::text
   and not (tg_op='UPDATE' and new.pinned_wheel_id is null and not exists(select 1 from public.wheels where id=old.pinned_wheel_id)) then
   raise exception 'use set_fan_pass_game' using errcode='42501';
 end if;
 if tg_op='UPDATE' and (new.fan_id is distinct from old.fan_id or new.creator_id is distinct from old.creator_id) then
   raise exception 'pass identity is immutable' using errcode='42501';
 end if;
 if current_setting('fanfunnel.economic_write',true) is distinct from 'on' then
   if tg_op='INSERT' then
     if new.spins_remaining<>0 or new.spins_granted_total<>0 or new.next_spin_nonce<>0 or new.next_server_seed is not null or new.next_server_seed_hash is not null then raise exception 'use atomic grant RPC' using errcode='42501'; end if;
   elsif new.spins_remaining is distinct from old.spins_remaining or new.spins_granted_total is distinct from old.spins_granted_total
      or new.next_server_seed is distinct from old.next_server_seed or new.next_server_seed_hash is distinct from old.next_server_seed_hash
      or new.next_spin_nonce is distinct from old.next_spin_nonce then raise exception 'use atomic attempt or grant RPC' using errcode='42501'; end if;
 end if;
 return new;
end $$;
-- The one ranking every path uses, now with the link's own pin first. The
-- two-argument form (0061) is unchanged and remains the no-pin ranking.
create or replace function public._creator_default_wheel(p_creator uuid,p_campaign uuid,p_pinned uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(
  (select w.id from public.wheels w where w.id=p_pinned and w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')),
  public._creator_default_wheel(p_creator,p_campaign));
$$;
revoke execute on function public._creator_default_wheel(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public._resolved_spin_wheel(p_pass uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(public._creator_default_wheel(fp.creator_id,fp.campaign_id,fp.pinned_wheel_id),
  (select w.id from public.wheels w where w.id=fp.wheel_id and w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')))
 from public.fan_passes fp where fp.id=p_pass;
$$;
create or replace function public._create_pass_grant_core(p_request uuid,p_creator uuid,p_fan uuid,p_wheel uuid,p_name text,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid,p_referral_code text default null,p_pack uuid default null,p_pack_units integer default 1)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare f public.fans%rowtype; p public.fan_passes%rowtype; g public.grants%rowtype; ref uuid; h text; outcome jsonb; pack public.campaign_packs%rowtype; v_auto boolean; v_pin uuid;
begin
 if p_pack is null and p_pack_units is distinct from 1 then return jsonb_build_object('status','invalid','error','invalid_pack'); end if;
 if p_request is null or (p_pack is null and (p_spins is null or p_bonus is null or p_amount is null or p_spins<0 or p_bonus<0 or p_bonus>p_spins or p_amount<0 or p_spins>1000000)) then raise exception 'invalid grant intent' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 h:=encode(digest(jsonb_build_array('create-pass-v1',p_creator,p_fan,p_wheel,p_name,case when p_pack is null then p_spins else null end,case when p_pack is null then p_bonus else null end,case when p_pack is null then p_amount else null end,p_campaign,p_referral_code,p_pack,p_pack_units)::text,'sha256'),'hex');
 if not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 select * into g from public.grants where id=p_request;
 if found then
   if g.request_hash is distinct from h or g.creator_id<>p_creator then return jsonb_build_object('status','conflict'); end if;
   select * into p from public.fan_passes where id=g.fan_pass_id and creator_id=p_creator;
   if p.id is null then return jsonb_build_object('status','unavailable'); end if;
   return jsonb_build_object('status','granted','token',p.token,'fanId',p.fan_id,'passId',p.id,'grantId',g.id,'balance',p.spins_remaining,'replayed',true);
 end if;
 if p_pack is not null then
   select * into pack from public.campaign_packs where id=p_pack and creator_id=p_creator for share;
   if pack.id is null or (pack.campaign_id is not null and pack.campaign_id is distinct from p_campaign) then return jsonb_build_object('status','invalid','error','pack_not_found'); end if;
   if pack.pack_kind<>'spins' then return jsonb_build_object('status','invalid','error','invalid_pack'); end if;
   if p_pack_units is null or p_pack_units<1 or p_pack_units>1000000
     or (pack.spins::bigint+pack.bonus_spins)*p_pack_units>1000000
     or pack.amount_cents::bigint*p_pack_units>100000000 then return jsonb_build_object('status','invalid','error','invalid_pack'); end if;
   p_spins:=((pack.spins::bigint+pack.bonus_spins)*p_pack_units)::int;
   p_bonus:=(pack.bonus_spins::bigint*p_pack_units)::int;p_amount:=(pack.amount_cents::bigint*p_pack_units)::int;
 end if;
 if p_campaign is not null and not exists(select 1 from public.campaigns where id=p_campaign and creator_id=p_creator) then return jsonb_build_object('status','invalid','error','campaign_not_found'); end if;
 -- Same ranking as spin time (link pin, campaign pin, open window, active flag,
 -- oldest), so the link is minted for the game the fan will actually play.
 v_auto:=p_wheel is null;
 if v_auto then p_wheel:=public._creator_default_wheel(p_creator,p_campaign); end if;
 if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch','bingo')) then return jsonb_build_object('status','invalid','error','no_wheel'); end if;
 if p_fan is null then
   insert into public.fans(creator_id,display_name) values(p_creator,left(p_name,200)) returning * into f;
 else
   select * into f from public.fans where id=p_fan and creator_id=p_creator for update;
   if not found then return jsonb_build_object('status','invalid','error','fan_not_found'); end if;
   if f.break_until>now() then return jsonb_build_object('status','unavailable','error','on_break'); end if;
   if f.blocked_at is not null or exists(select 1 from public.fan_passes where fan_id=p_fan and self_excluded_at is not null) then return jsonb_build_object('status','unavailable','error','blocked'); end if;
   -- 0065: a link set to its own playable game is the game this fan plays, so an
   -- automatic top-up lands on that link (read under the fan lock, oldest first).
   if v_auto then
     select fp.pinned_wheel_id into v_pin from public.fan_passes fp join public.wheels w on w.id=fp.pinned_wheel_id
      where fp.fan_id=f.id and fp.creator_id=p_creator and fp.is_active and fp.self_excluded_at is null
        and w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')
      order by fp.created_at,fp.id limit 1;
     if v_pin is not null then p_wheel:=v_pin; end if;
   end if;
 end if;
 if v_pin is not null then
   select * into p from public.fan_passes where fan_id=f.id and creator_id=p_creator and pinned_wheel_id=v_pin and is_active and self_excluded_at is null order by created_at,id limit 1 for update;
 else
   select * into p from public.fan_passes where fan_id=f.id and creator_id=p_creator and wheel_id=p_wheel and is_active and self_excluded_at is null order by created_at,id limit 1 for update;
 end if;
 if not found then
   insert into public.fan_passes(token,creator_id,wheel_id,fan_id,campaign_id)
   values(encode(gen_random_bytes(24),'hex'),p_creator,p_wheel,f.id,p_campaign) returning * into p;
 elsif p_campaign is not null then
   update public.fan_passes set campaign_id=p_campaign where id=p.id returning * into p;
 end if;
 if p_fan is null and p_referral_code is not null then
   select id into ref from public.fans where creator_id=p_creator and referral_code=p_referral_code and id<>f.id;
   if ref is not null then
     update public.fans set referred_by_fan_id=ref where id=f.id;
     insert into public.referrals(creator_id,referrer_fan_id,referred_fan_id,bonus_spins) values(p_creator,ref,f.id,3);
   end if;
 end if;
 outcome:=public._grant_pass_spins_core(p_request,p_creator,f.id,p.id,p_spins,p_bonus,p_amount,p_campaign);
 if outcome->>'status'<>'granted' then raise exception 'atomic bootstrap grant refused' using errcode='22023'; end if;
 update public.grants set request_hash=h where id=p_request;
 return outcome||jsonb_build_object('token',p.token,'fanId',f.id,'passId',p.id);
end $$;
-- The one writer of a link's own game. Service-only behind the 0062 actor
-- context ('grant', the fan_passes_write permission), rechecked after the row
-- locks. The game must be the creator's own and playable (campaignPinError's
-- test); null follows the campaign and the live game again.
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
-- ── A12: spin_attempts foreign keys ────────────────────────────────────────
-- Fan deletion (SET NULL), pass deletion, account close (CASCADE) and the
-- privacy export all filter spin_attempts by these columns.
create index if not exists spin_attempts_fan_idx on public.spin_attempts(fan_id) where fan_id is not null;
create index if not exists spin_attempts_fan_pass_idx on public.spin_attempts(fan_pass_id) where fan_pass_id is not null;
create index if not exists spin_attempts_creator_created_idx on public.spin_attempts(creator_id, created_at);
-- ── A35: prize cost at award time ──────────────────────────────────────────
alter table public.redemptions add column if not exists cost_cents_at_award integer;
alter table public.redemptions drop constraint if exists redemptions_cost_cents_at_award_check;
alter table public.redemptions add constraint redemptions_cost_cents_at_award_check check (cost_cents_at_award is null or cost_cents_at_award >= 0);
comment on column public.redemptions.cost_cents_at_award is 'The prize cost when it was awarded (0065), set in the commit transaction; null for older awards and unknown costs.';
-- Written once, by the award itself: a later cost edit (or a fulfilment
-- update) can never rewrite history.
create or replace function public._guard_award_cost_snapshot()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='UPDATE' then
   if new.cost_cents_at_award is distinct from old.cost_cents_at_award then raise exception 'award cost is immutable' using errcode='42501'; end if;
 elsif new.cost_cents_at_award is not null and current_setting('fanfunnel.reward_finalization',true) is distinct from new.spin_id::text then
   raise exception 'award cost is recorded only by the award' using errcode='42501';
 end if;
 return new;
end $$;
revoke execute on function public._guard_award_cost_snapshot() from public,anon,authenticated;
-- Nor can the award (and its recorded cost) be erased from a session: no app
-- path deletes a redemption (they go with their spin, fan or account, through
-- service-role work and foreign-key cascades, which this does not affect), but
-- redemptions_write is FOR ALL and Supabase grants DELETE to authenticated.
revoke delete on table public.redemptions from public,anon,authenticated;
drop trigger if exists redemptions_award_cost_snapshot on public.redemptions;
create trigger redemptions_award_cost_snapshot before insert or update of cost_cents_at_award on public.redemptions
 for each row execute function public._guard_award_cost_snapshot();
create or replace function public._commit_bingo_bonus(p_parent_id uuid,p_bonus jsonb,p_line integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p_parent public.spins%rowtype; pr public.prizes%rowtype; code public.prize_reward_codes%rowtype; reward public.prize_rewards%rowtype; s public.spins%rowtype; expected jsonb; failure jsonb; v_stock_after integer;
begin
 select * into p_parent from public.spins where id=p_parent_id and kind='play' and game_kind='bingo';
 if not found then raise exception 'invalid bingo parent' using errcode='42501';end if;
 failure:=jsonb_build_object('prizeId',p_bonus->>'prize_id','line',p_line);
 if jsonb_typeof(p_bonus) is distinct from 'object' or p_bonus->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or(p_bonus->>'line')::integer is distinct from p_line or p_bonus->>'id'=p_parent.id::text then raise exception 'invalid bingo bonus' using errcode='22023';end if;
 select * into pr from public.prizes where id=(p_bonus->>'prize_id')::uuid and wheel_id=p_parent.wheel_id;
 if not found then raise exception using errcode='P0061',message=(failure||jsonb_build_object('status','sold_out'))::text;end if;
 if p_bonus->>'prize_label' is distinct from pr.label or p_bonus->>'prize_rarity' is distinct from pr.rarity::text or p_bonus->>'prize_image_url' is distinct from pr.image_url
  or p_bonus#>>'{response_prize,id}' is distinct from pr.id::text or p_bonus#>>'{response_prize,label}' is distinct from pr.label or p_bonus#>>'{response_prize,rarity}' is distinct from pr.rarity::text
  or exists(select 1 from jsonb_object_keys(p_bonus->'response_prize') k where k not in('id','label','description','rarity','weight','color','emoji','imageUrl','stock')) then raise exception 'invalid bingo bonus metadata' using errcode='22023';end if;
 expected:=p_bonus->'expected_reward';
 if expected->>'delivery' is distinct from pr.delivery then raise exception using errcode='P0061',message=(failure||jsonb_build_object('status','changed'))::text;end if;
 if pr.delivery='codes' then
  select * into code from public.prize_reward_codes where id=(expected->>'codeId')::uuid and prize_id=pr.id and spin_id is null and reserved_focus_id is null for update;
  if not found then
   raise exception using errcode='P0061',message=(failure||jsonb_build_object('status',case when exists(select 1 from public.prize_reward_codes where prize_id=pr.id and spin_id is null and reserved_focus_id is null) then 'changed' else 'sold_out' end))::text;
  end if;
  if code.cipher is distinct from expected->>'cipher' or code.iv is distinct from expected->>'iv' or code.key_version is distinct from(expected->>'keyVersion')::smallint then raise exception using errcode='P0061',message=(failure||jsonb_build_object('status','changed'))::text;end if;
 elsif pr.delivery in('text','link') then
  select * into reward from public.prize_rewards where prize_id=pr.id;
  if reward.kind is distinct from pr.delivery or reward.cipher is distinct from expected->>'cipher' or reward.iv is distinct from expected->>'iv' or reward.key_version is distinct from(expected->>'keyVersion')::smallint then raise exception using errcode='P0061',message=(failure||jsonb_build_object('status','changed'))::text;end if;
 end if;
 if pr.stock is not null and pr.stock<=0 then raise exception using errcode='P0061',message=(failure||jsonb_build_object('status','sold_out'))::text;end if;
 perform set_config('fanfunnel.reward_finalization',p_bonus->>'id',true);
 if pr.delivery='codes' then update public.prize_reward_codes set spin_id=(p_bonus->>'id')::uuid,assigned_at=now() where id=code.id;update public.prizes set stock=stock where id=pr.id;
 elsif pr.stock is not null then update public.prizes set stock=stock-1 where id=pr.id;end if;
 insert into public.spins(id,fan_pass_id,creator_id,wheel_id,fan_id,prize_id,prize_label,prize_rarity,prize_image_url,campaign_id,fair_version,game_kind,kind,parent_spin_id,bingo_line)
 values((p_bonus->>'id')::uuid,p_parent.fan_pass_id,p_parent.creator_id,p_parent.wheel_id,p_parent.fan_id,pr.id,pr.label,pr.rarity,pr.image_url,p_parent.campaign_id,null,'bingo','bonus',p_parent.id,p_line) returning * into s;
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at,cost_cents_at_award) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end,case when pr.cost_cents>=0 then pr.cost_cents end);
 select stock into v_stock_after from public.prizes where id=pr.id;update public.spin_rewards set stock_after=v_stock_after where spin_id=s.id;
 return jsonb_build_object('line',p_line,'shareId',s.share_id,'prize',p_bonus->'response_prize','spin',to_jsonb(s)-'fan_id'-'fan_pass_id','stockAfter',v_stock_after);
end $$;
create or replace function public.commit_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_context jsonb,p_spin jsonb,p_expected_reward jsonb,p_next_seed jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a public.spin_attempts%rowtype; p public.fan_passes%rowtype; f public.fans%rowtype; ff public.fan_focus%rowtype;
 r public.chase_reservations%rowtype; pr public.prizes%rowtype; target public.prizes%rowtype;
 code public.prize_reward_codes%rowtype; reward public.prize_rewards%rowtype; s public.spins%rowtype;
 current_context jsonb; snapshot jsonb; proof jsonb; mod_focus jsonb; mod_chase jsonb; row_proof jsonb;
 hh numeric; factor numeric; effective numeric; applied boolean:=false; eligible boolean:=false; target_available boolean:=false;
 pity_due boolean; focus_consumed boolean:=false; chase_due boolean:=false; chase_complete boolean:=false; has_rare boolean; v_stock_after integer;
 card public.bingo_cards%rowtype; before_state jsonb; after_state jsonb; bonus jsonb; trace_bonus jsonb; bonus_receipt jsonb; bonuses jsonb:='[]'::jsonb; line_number integer; bonus_index integer; card_id uuid; excluded_id text; excluded_all jsonb; selected_id text; expected_lines jsonb;
 next_pity integer; next_focus integer; next_chase integer; v_error text; balance integer; is_held boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
 if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 select * into f from public.fans where id=a.fan_id for update;
 select * into p from public.fan_passes where id=a.fan_pass_id and token=p_token for update;
 if p.id is null or f.id is null or f.creator_id is distinct from p.creator_id or p.fan_id<>f.id or not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=a.creator_id and is_active and (approval_status='approved' or role='admin')) then
   return jsonb_build_object('status','unavailable');
 end if;
 if f.break_until>now() then v_error:='on_break';
 elsif f.acked_at is null or f.acked_terms_version is distinct from '2026-10-27' then v_error:='needs_ack';
 elsif p.spins_remaining<=0 then v_error:='no_spins';
 elsif f.rl_window_start>now()-interval '10 seconds' and f.rl_count>=8 then v_error:='rate_limited'; end if;
 if v_error is not null then
   update public.spin_attempts set state='declined',error=v_error,finished_at=now() where id=p_attempt;
   return jsonb_build_object('status','declined','error',v_error);
 end if;
 select * into ff from public.fan_focus where fan_id=f.id and status in('active','paused') for update;
 select * into r from public.chase_reservations where focus_id=ff.id for update;
 select * into card from public.bingo_cards where fan_id=f.id and wheel_id=public._resolved_spin_wheel(p.id) order by(status='active') desc,created_at desc,id desc limit 1 for update;
 -- Serialize game-kind/config edits against this credited play.
 perform 1 from public.wheels where id=public._resolved_spin_wheel(p.id) for update;
 -- Stable lock ordering for every candidate and reservation target.
 perform 1 from public.prizes where wheel_id=public._resolved_spin_wheel(p.id) or id=r.prize_id order by id for update;
 current_context:=public._spin_attempt_context(p.id);
 if p_context->>'contextHash' is distinct from current_context->>'contextHash'
   or a.context->>'contextHash' is distinct from current_context->>'contextHash' then
   return jsonb_build_object('status','retry_context');
 end if;
 select * into s from jsonb_populate_record(null::public.spins,p_spin);
 s.game_kind:=coalesce(s.game_kind,'wheel');
 if s.game_kind is distinct from current_context#>>'{wheel,game_kind}' or s.game_kind not in('wheel','scratch','bingo') or current_context#>'{wheel,game_ready}' is distinct from 'true'::jsonb then raise exception 'game context mismatch' using errcode='22023'; end if;
 if s.id is distinct from p_attempt or s.fan_id is distinct from f.id or s.fan_pass_id is distinct from p.id
   or s.creator_id is distinct from p.creator_id or s.wheel_id is distinct from (current_context->>'wheelId')::uuid
   or s.campaign_id is distinct from p.campaign_id or s.server_seed is distinct from p.next_server_seed
   or s.server_seed_hash is distinct from p.next_server_seed_hash or s.nonce is distinct from p.next_spin_nonce
   or s.fair_version is distinct from 3 or (p_next_seed->>'seed') !~ '^[a-f0-9]{64}$'
   or p_next_seed->>'hash' is distinct from encode(digest(p_next_seed->>'seed','sha256'),'hex')
   or p_next_seed->>'seed'=p.next_server_seed then
   raise exception 'spin context mismatch' using errcode='22023';
 end if;
 snapshot:=s.pool_snapshot;
 if snapshot->>'game' is distinct from s.game_kind or snapshot->>'v' is distinct from '3'
   or exists(select 1 from jsonb_object_keys(snapshot) k where k not in('v','rules','game','prizes','modifiers') and not(s.game_kind in('scratch','bingo') and k in('gameRules','gameConfig')) and not(s.game_kind='bingo' and k='bingo'))
   or exists(select 1 from jsonb_object_keys(snapshot->'modifiers') k where k not in('happyHour','pity','focus','chase'))
   or s.fair_trace->>'won' is distinct from s.prize_id::text then raise exception 'invalid proof envelope' using errcode='22023'; end if;
 if s.game_kind='scratch' then
   if snapshot->>'gameRules' is distinct from 'scratch-v1' or snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'
     or not public._valid_scratch_presentation(snapshot,s.prize_id,s.presentation)
     or s.fair_trace->'bonuses' is distinct from '[]'::jsonb
     or (select count(*) from jsonb_object_keys(s.fair_trace))<>3 then raise exception 'invalid scratch proof' using errcode='22023'; end if;
 elsif s.game_kind='bingo' then
   before_state:=case when card.id is null then null else public._bingo_public_state(to_jsonb(card)) end;
   if coalesce(p_context->'cardId','null'::jsonb) is distinct from coalesce(to_jsonb(card.id),'null'::jsonb)
    or coalesce(p_context->'cardVersion','null'::jsonb) is distinct from coalesce(to_jsonb(card.version),'null'::jsonb) then return jsonb_build_object('status','retry_context');end if;
   if snapshot->>'gameRules' is distinct from 'bingo-v1' or snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'
    or not public._validate_bingo_snapshot(snapshot,a.context,before_state) or not public._validate_bingo_presentation(snapshot,before_state,s.presentation,s.prize_id)
    or jsonb_typeof(s.fair_trace->'bonuses') is distinct from 'array' or(select count(*) from jsonb_object_keys(s.fair_trace))<>3
    or jsonb_typeof(p_spin->'bonuses') is distinct from 'array' then raise exception 'invalid bingo proof' using errcode='22023';end if;
   expected_lines:=s.presentation->'newLines';
   if jsonb_array_length(s.fair_trace->'bonuses')<>jsonb_array_length(expected_lines) or jsonb_array_length(p_spin->'bonuses')<>jsonb_array_length(expected_lines)
    or jsonb_array_length(expected_lines)>4 then raise exception 'missing or extra bingo bonuses' using errcode='22023';end if;
 elsif s.presentation is not null then raise exception 'unexpected wheel presentation' using errcode='22023'; end if;
 if s.game_kind<>'bingo' and coalesce(p_spin->'bonuses','[]'::jsonb)<>'[]'::jsonb then raise exception 'unexpected bonuses' using errcode='22023';end if;
 if snapshot->>'rules' is distinct from 'focus-v1' or snapshot#>>'{modifiers,pity,counter}' is distinct from f.pity_counter::text
   or snapshot#>>'{modifiers,pity,threshold}' is distinct from '10'
   or s.pool_hash is distinct from encode(digest(public._canonical_proof_json(snapshot),'sha256'),'hex') then
   raise exception 'invalid proof context' using errcode='22023';
 end if;
 hh:=(current_context->>'happyHourMultiplier')::numeric;
 if coalesce((snapshot#>>'{modifiers,happyHour,multiplier}')::numeric,1)<>hh then raise exception 'happy hour mismatch' using errcode='22023'; end if;
 mod_focus:=nullif(snapshot#>'{modifiers,focus}','null'::jsonb);
 mod_chase:=nullif(snapshot#>'{modifiers,chase}','null'::jsonb);
 select * into target from public.prizes where id=ff.prize_id;
 if ff.kind='focus' and target.wheel_id=s.wheel_id and
   ((select coalesce((x->>'stock')::int,1)>0 from jsonb_array_elements(a.context->'prizes') x where x->>'id'=ff.prize_id::text)
      is distinct from (target.stock is null or target.stock>0)) then return jsonb_build_object('status','retry_context'); end if;
 target_available:=target.id is not null and target.wheel_id=s.wheel_id and (target.stock is null or target.stock>0 or (r.state='held' and r.prize_id=target.id));
 if ff.id is null then
   if mod_focus is not null or mod_chase is not null then raise exception 'ungranted focus' using errcode='22023'; end if;
 elsif ff.kind='focus' then
   if mod_focus is null or mod_chase is not null or mod_focus->>'prizeId' is distinct from ff.prize_id::text
     or (mod_focus->>'multiplier')::numeric is distinct from ff.multiplier
     or (mod_focus->>'spinsLeft')::int is distinct from ff.spins_left
     or (mod_focus->>'totalSpins')::int is distinct from ff.total_spins then raise exception 'focus terms mismatch' using errcode='22023'; end if;
   applied:=coalesce((mod_focus->>'applied')::boolean,false);
   if applied is distinct from (target_available and public._focus_odds_increased(snapshot,'[]'::jsonb)) then raise exception 'focus odds eligibility mismatch' using errcode='22023'; end if;
   factor:=case when target.wheel_id=s.wheel_id and target.rarity in('rare','epic','legendary') then hh else 1 end;
   if applied and (not target_available or (mod_focus->>'effectiveMultiplier')::numeric is distinct from least(5,factor*ff.multiplier)) then
     raise exception 'ineligible focus' using errcode='22023';
   end if;
   if not applied and (mod_focus->>'effectiveMultiplier')::numeric is distinct from factor then raise exception 'paused focus weight' using errcode='22023'; end if;
 else
   if mod_chase is null or mod_focus is not null or mod_chase->>'prizeId' is distinct from ff.prize_id::text
     or (mod_chase->>'counter')::int is distinct from ff.chase_counter or (mod_chase->>'within')::int is distinct from ff.total_spins
     or coalesce((mod_chase->>'reserved')::boolean,false) is distinct from (r.state='held') then raise exception 'chase terms mismatch' using errcode='22023'; end if;
   eligible:=coalesce((mod_chase->>'eligible')::boolean,false);
   if eligible is distinct from target_available then raise exception 'chase eligibility mismatch' using errcode='22023'; end if;
   if eligible and coalesce(s.fair_trace->'excluded','[]'::jsonb) ? ff.prize_id::text then raise exception 'reserved chase target excluded' using errcode='22023'; end if;
   chase_due:=eligible and ff.chase_counter+1>=ff.total_spins;
   chase_complete:=eligible and s.prize_id=ff.prize_id;
   if chase_due and not chase_complete then raise exception 'chase guarantee violated' using errcode='22023'; end if;
 end if;
 -- Compare every published base/effective ticket count with current locked rows.
 -- Sold-out exclusions stay in the immutable trace; SQL does not reroll RNG.
 for row_proof in select value from jsonb_array_elements(snapshot->'prizes') loop
   if exists(select 1 from jsonb_object_keys(row_proof) k where k not in('id','label','emoji','rarity','w','baseW')) then raise exception 'invalid proof prize' using errcode='22023'; end if;
   select * into pr from public.prizes where id=(row_proof->>'id')::uuid and wheel_id=s.wheel_id;
   if not found or row_proof->>'label' is distinct from pr.label or row_proof->>'rarity' is distinct from pr.rarity::text
     or (s.game_kind in('scratch','bingo') and row_proof->'emoji' is distinct from coalesce(to_jsonb(pr.emoji),'null'::jsonb))
     or (row_proof->>'baseW')::numeric is distinct from pr.weight::numeric then raise exception 'pool base mismatch' using errcode='22023'; end if;
   factor:=case when pr.rarity in('rare','epic','legendary') then hh else 1 end;
   if applied and pr.id=ff.prize_id then factor:=least(5,factor*ff.multiplier); end if;
   effective:=case when pr.weight=0 then 0 else greatest(1,floor(pr.weight*factor+0.5)) end;
   if (row_proof->>'w')::numeric is distinct from effective then raise exception 'pool effective weight mismatch' using errcode='22023'; end if;
 end loop;
 select * into pr from public.prizes where id=s.prize_id and wheel_id=s.wheel_id;
 if not found then return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null); end if;
 if p_spin#>>'{response_prize,id}' is distinct from pr.id::text or p_spin#>>'{response_prize,label}' is distinct from pr.label
   or p_spin#>>'{response_prize,rarity}' is distinct from pr.rarity::text
   or exists(select 1 from jsonb_object_keys(p_spin->'response_prize') k where k not in('id','label','description','rarity','weight','color','emoji','imageUrl','stock'))
   or (p_spin->>'response_prize_index')::int not between 0 and 49
   or (p_spin->>'response_show_stock')::boolean is distinct from coalesce((current_context#>>'{wheel,show_stock}')::boolean,false) then
   raise exception 'response metadata mismatch' using errcode='22023'; end if;
 if pr.label is distinct from s.prize_label or pr.rarity is distinct from s.prize_rarity or pr.image_url is distinct from s.prize_image_url
   or not exists(select 1 from jsonb_array_elements(snapshot->'prizes') x where x->>'id'=pr.id::text) then raise exception 'selected prize mismatch' using errcode='22023'; end if;
 select exists(select 1 from jsonb_array_elements(snapshot->'prizes') x where x->>'rarity' in('rare','epic','legendary')
   and not (coalesce(s.fair_trace->'excluded','[]'::jsonb) ? (x->>'id'))) into has_rare;
 pity_due:=not chase_due and f.pity_counter+1>=10 and has_rare;
 if pity_due and pr.rarity not in('rare','epic','legendary') then raise exception 'pity guarantee violated' using errcode='22023'; end if;
 focus_consumed:=applied and public._focus_odds_increased(snapshot,coalesce(s.fair_trace->'excluded','[]'::jsonb));
 next_pity:=case when pr.rarity in('rare','epic','legendary') then 0 else f.pity_counter+1 end;
 next_focus:=case when ff.kind='focus' then ff.spins_left-case when focus_consumed then 1 else 0 end else null end;
 next_chase:=case when ff.kind='chase' then ff.chase_counter+case when eligible then 1 else 0 end else null end;
 if (p_spin->>'next_pity_counter')::int is distinct from next_pity
   or coalesce((p_spin->>'focus_consumed')::boolean,false) is distinct from focus_consumed
   or coalesce((p_spin->>'chase_consumed')::boolean,false) is distinct from eligible
   or coalesce((p_spin->>'chase_completed')::boolean,false) is distinct from chase_complete
   or (p_spin->>'next_focus_spins_left')::int is distinct from next_focus
   or (p_spin->>'next_chase_counter')::int is distinct from next_chase then raise exception 'counter transition mismatch' using errcode='22023'; end if;
 if pr.delivery is distinct from p_expected_reward->>'delivery' then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 is_held:=r.state='held' and r.prize_id=pr.id and eligible;
 if pr.delivery='codes' then
   select * into code from public.prize_reward_codes where id=(p_expected_reward->>'codeId')::uuid and prize_id=pr.id and spin_id is null for update;
   if code.id is null or (is_held and code.id is distinct from r.code_id) or (not is_held and code.reserved_focus_id is not null) then
     if is_held or exists(select 1 from public.prize_reward_codes where prize_id=pr.id and spin_id is null and reserved_focus_id is null) then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
     return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null);
   end if;
   if code.cipher is distinct from p_expected_reward->>'cipher' or code.iv is distinct from p_expected_reward->>'iv'
     or code.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 elsif pr.delivery in('link','text') then
   select * into reward from public.prize_rewards where prize_id=pr.id;
   if reward.kind is distinct from pr.delivery or reward.cipher is distinct from p_expected_reward->>'cipher'
     or reward.iv is distinct from p_expected_reward->>'iv' or reward.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed','prizeId',s.prize_id,'line',null); end if;
 end if;
 if not is_held and pr.stock is not null and pr.stock<=0 then return jsonb_build_object('status','sold_out','prizeId',s.prize_id,'line',null); end if;
 -- No mutation above this point consumes a credit, seed, stock, pity or promise.
 perform set_config('fanfunnel.economic_write','on',true);
 perform set_config('fanfunnel.reward_finalization',p_attempt::text,true);
 if pr.delivery='codes' then
   update public.prize_reward_codes set spin_id=p_attempt,assigned_at=now(),reserved_focus_id=null where id=code.id;
   update public.prizes set stock=stock where id=pr.id;
 elsif not is_held and pr.stock is not null then update public.prizes set stock=stock-1 where id=pr.id; end if;
 update public.fan_passes set spins_remaining=spins_remaining-1,next_server_seed=p_next_seed->>'seed',next_server_seed_hash=p_next_seed->>'hash',next_spin_nonce=next_spin_nonce+1,last_spin_at=now() where id=p.id returning spins_remaining into balance;
 update public.fans set pity_counter=next_pity,last_spin_at=now(),
   rl_count=case when rl_window_start is null or rl_window_start<=now()-interval '10 seconds' then 1 else rl_count+1 end,
   rl_window_start=case when rl_window_start is null or rl_window_start<=now()-interval '10 seconds' then now() else rl_window_start end where id=f.id;
 s.seed_commitment:=case when a.context->>'commitment'='fresh' then 'fresh' when p_context->>'publishedSeedHash'=p.next_server_seed_hash then 'published' else 'stored' end;
 insert into public.spins(id,fan_pass_id,creator_id,wheel_id,fan_id,prize_id,prize_label,prize_rarity,prize_image_url,campaign_id,server_seed,server_seed_hash,nonce,client_seed,seed_commitment,fair_version,pool_snapshot,pool_hash,fair_trace,game_kind,presentation)
 values(p_attempt,p.id,p.creator_id,s.wheel_id,f.id,pr.id,s.prize_label,s.prize_rarity,s.prize_image_url,p.campaign_id,s.server_seed,s.server_seed_hash,s.nonce,s.client_seed,s.seed_commitment,3,s.pool_snapshot,s.pool_hash,s.fair_trace,s.game_kind,s.presentation) returning * into s;
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at,cost_cents_at_award) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end,case when pr.cost_cents>=0 then pr.cost_cents end);
 if is_held then update public.chase_reservations set state='consumed',consumed_spin_id=s.id,ended_at=now() where id=r.id and state='held'; end if;
 if ff.id is not null then
   update public.fan_focus set spins_left=coalesce(next_focus,spins_left),chase_counter=coalesce(next_chase,chase_counter),version=version+1,
     status=case when chase_complete or next_focus=0 then 'done' else 'active' end,
     ended_at=case when chase_complete or next_focus=0 then now() else null end where id=ff.id;
 end if;
 if s.game_kind='bingo' then
  perform set_config('fanfunnel.bingo_write','on',true);
  after_state:=s.presentation->'after';
  if(s.presentation->>'newCard')::boolean then
   insert into public.bingo_cards(creator_id,fan_id,wheel_id,cells,marked_mask,awarded_lines_mask,version,status,completed_at)
   values(s.creator_id,s.fan_id,s.wheel_id,after_state->'cells',(after_state->>'markedMask')::integer,(after_state->>'awardedLinesMask')::integer,(after_state->>'version')::bigint,
    case when(after_state->>'markedMask')::integer=511 then 'complete' else 'active' end,case when(after_state->>'markedMask')::integer=511 then now() else null end) returning id into card_id;
  else
   update public.bingo_cards set marked_mask=(after_state->>'markedMask')::integer,awarded_lines_mask=(after_state->>'awardedLinesMask')::integer,version=(after_state->>'version')::bigint,
    status=case when(after_state->>'markedMask')::integer=511 then 'complete' else 'active' end,completed_at=case when(after_state->>'markedMask')::integer=511 then now() else null end where id=card.id and version=card.version returning id into card_id;
   if not found then raise exception using errcode='P0061',message='{"status":"retry_context"}';end if;
  end if;
  excluded_all:=coalesce(s.fair_trace->'excluded','[]'::jsonb);
  for bonus_index in 0..jsonb_array_length(expected_lines)-1 loop
   line_number:=(expected_lines->>bonus_index)::integer;bonus:=p_spin->'bonuses'->bonus_index;trace_bonus:=s.fair_trace->'bonuses'->bonus_index;
   if(trace_bonus->>'line')::integer is distinct from line_number or trace_bonus->>'won' is distinct from bonus->>'prize_id'
    or jsonb_typeof(trace_bonus->'excluded') is distinct from 'array' or(select count(*) from jsonb_object_keys(trace_bonus))<>3 then raise exception 'invalid bingo bonus trace' using errcode='22023';end if;
   for excluded_id in select jsonb_array_elements_text(trace_bonus->'excluded') loop
    if excluded_all ? excluded_id or not exists(select 1 from jsonb_array_elements((snapshot#>'{bingo,bonus,fallback}')||case when snapshot#>'{bingo,bonus,selected}'='null'::jsonb then '[]'::jsonb else jsonb_build_array(snapshot#>'{bingo,bonus,selected}') end) q where q->>'id'=excluded_id) then raise exception 'invalid bingo exclusion' using errcode='22023';end if;
    if exists(select 1 from public.prizes p2 where p2.id=excluded_id::uuid and p2.wheel_id=s.wheel_id and((p2.delivery<>'codes' and(p2.stock is null or p2.stock>0)) or(p2.delivery='codes' and exists(select 1 from public.prize_reward_codes where prize_id=p2.id and spin_id is null and reserved_focus_id is null)))) then raise exception 'available bingo candidate excluded' using errcode='22023';end if;
    excluded_all:=excluded_all||to_jsonb(excluded_id);
   end loop;
   selected_id:=snapshot#>>'{bingo,bonus,selected,id}';
   if excluded_all ? (bonus->>'prize_id') or(selected_id is not null and not(excluded_all ? selected_id) and bonus->>'prize_id'<>selected_id)
    or((selected_id is null or excluded_all ? selected_id) and not exists(select 1 from jsonb_array_elements(snapshot#>'{bingo,bonus,fallback}') q where q->>'id'=bonus->>'prize_id')) then raise exception 'invalid bingo bonus selection' using errcode='22023';end if;
   bonus_receipt:=public._commit_bingo_bonus(s.id,bonus,line_number);
   insert into public.bingo_line_awards(card_id,line_index,creator_id,fan_id,wheel_id,primary_spin_id,bonus_spin_id)
   values(card_id,line_number,s.creator_id,s.fan_id,s.wheel_id,s.id,(bonus_receipt#>>'{spin,id}')::uuid);
   bonuses:=bonuses||jsonb_build_array(bonus_receipt);
  end loop;
 end if;
 select stock into v_stock_after from public.prizes where id=pr.id;
 update public.spin_rewards set stock_after=v_stock_after where spin_id=s.id;
 update public.spin_attempts set state='committed',spin_id=s.id,finished_at=now(),result=jsonb_build_object(
   'id',s.id,'shareId',s.share_id,'spin',to_jsonb(s),'createdAt',s.created_at,'stockAfter',v_stock_after,
   'gameKind',s.game_kind,'presentation',s.presentation,'bonusWins',bonuses,
   'originalNextServerSeedHash',p_next_seed->>'hash','pityAwarded',pity_due,'chaseAwarded',chase_due,'chaseCompleted',chase_complete,
   'focusConsumed',focus_consumed,'chaseConsumed',eligible,
   'prize',p_spin->'response_prize','prizeIndex',(p_spin->>'response_prize_index')::int,'showStock',(p_spin->>'response_show_stock')::boolean) where id=p_attempt;
 return public._spin_attempt_receipt(p_attempt,false);
exception when sqlstate 'P0061' then return sqlerrm::jsonb;
end $$;
-- ── A11: bounded operational history ───────────────────────────────────────
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
  -- 0065 (A11): bounded operational history. Each constant matches
  -- RETENTION_DAYS in src/lib/privacy/retention.ts (retention.test.ts pins it).
  v_checkin_days constant integer := 90;
  v_attempt_days constant integer := 90;
  v_journal_days constant integer := 90;
  v_import_batch_days constant integer := 90;
  v_checkins integer := 0;
  v_attempt_contexts integer := 0;
  v_declined_attempts integer := 0;
  v_journal integer := 0;
  v_import_batches integer := 0;
  v_cancellations integer := 0;
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

  delete from public.creator_actor_contexts where expires_at<=clock_timestamp();
  delete from public.org_invites
   where (status in ('declined','revoked') and created_at<now()-make_interval(days=>p_closed_invite_days))
      or (status in ('expired','pending') and expires_at<now()-make_interval(days=>p_closed_invite_days));
  get diagnostics v_invites = row_count;

  -- Deterministic, global cleanup: no future notification or active account
  -- is needed for old deduplication history to expire.
  delete from public.push_log
   where sent_at < now() - make_interval(days => v_push_log_days);
  get diagnostics v_push_log = row_count;

  -- The visit glow reads back CHECKIN_READ_DAYS (59); older days are unused.
  delete from public.fan_checkins
   where day < current_date - v_checkin_days;
  get diagnostics v_checkins = row_count;

  -- A finished attempt keeps its short record (state, outcome, times, spin);
  -- the prepared context (seed, pool, reward hints) only serves a pending one.
  update public.spin_attempts set context = null
   where state <> 'pending' and context is not null
     and finished_at < now() - make_interval(days => v_attempt_days);
  get diagnostics v_attempt_contexts = row_count;
  -- A declined attempt moved no credit, stock or seed: nothing to keep.
  delete from public.spin_attempts
   where state = 'declined' and spin_id is null
     and finished_at < now() - make_interval(days => v_attempt_days);
  get diagnostics v_declined_attempts = row_count;

  -- Settled idempotency journals and import batches: a retry this old is not
  -- a retry. Grants and fans they created are business records and stay.
  delete from public.creator_request_journal
   where state <> 'pending'
     and finished_at < now() - make_interval(days => v_journal_days);
  get diagnostics v_journal = row_count;

  -- A cancelled request's fence (actor_request_cancellations) keeps a late
  -- retry of that request id from running; it lives as long as the journal
  -- (a creator's pending request only survives in that browser tab's session
  -- storage, so a retry this old is not a retry either).
  delete from public.actor_request_cancellations
   where created_at < now() - make_interval(days => v_journal_days);
  get diagnostics v_cancellations = row_count;

  -- An import batch is also the import's idempotency record: after this a
  -- re-sent import with the same request id is a new import.
  delete from public.fan_import_batches b
   where b.created_at < now() - make_interval(days => v_import_batch_days)
     and not exists(select 1 from public.creator_request_journal j where j.batch_id = b.id and j.state = 'pending');
  get diagnostics v_import_batches = row_count;

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
    'fan_checkins', v_checkins,
    'spin_attempt_contexts', v_attempt_contexts,
    'declined_spin_attempts', v_declined_attempts,
    'creator_request_journal', v_journal,
    'actor_request_cancellations', v_cancellations,
    'fan_import_batches', v_import_batches,
    'app_errors', case when v_has_app_errors then v_app_errors else null end
  );
end;
$$;
-- ── A17: atomic first-admin bootstrap ──────────────────────────────────────
-- The route still checks the ADMIN_EMAILS allow-list and the 0062 MFA step-up
-- first. Here the "no admin exists yet" check and the promotion are one
-- transaction under the 0062 active-admin fence (taken before any profile row
-- lock), so two racing claims give exactly one admin; the allow-listed
-- address must be the account's own confirmed address.
create or replace function public.bootstrap_first_admin(p_user uuid,p_email text)
returns text language plpgsql security definer set search_path=public as $$
declare v_updated uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0));
 if exists(select 1 from public.profiles where role='admin') then return 'already_bootstrapped'; end if;
 if p_user is null or nullif(trim(p_email),'') is null or not exists(
   select 1 from auth.users u where u.id=p_user and lower(u.email)=lower(trim(p_email)) and u.email_confirmed_at is not null
 ) then return 'email_unconfirmed'; end if;
 update public.profiles set role='admin',approval_status='approved',is_active=true where id=p_user returning id into v_updated;
 if v_updated is null then return 'not_found'; end if;
 return 'ok';
end $$;
revoke execute on function public.bootstrap_first_admin(uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_first_admin(uuid,text) to service_role;
-- ── A44: archive / delete in the play lock order ───────────────────────────
-- A credited play and a Focus grant lock fan -> pass -> ... -> wheel -> prize.
-- Archiving or deleting a game releases every Focus/Chase promise on it
-- (aa_focus_lifecycle -> _release_fan_focus, which locks each fan and its
-- passes), and deleting it also clears the links set to it (pinned_wheel_id
-- ON DELETE SET NULL updates those passes). A plain UPDATE/DELETE held the
-- wheel row first and then waited for those fans or passes: 40P01 against a
-- play. This takes those fans first, then the wheel. A promise granted (or a
-- link set to the game) in between is taken with NOWAIT (the wheel lock now
-- stops new ones: their foreign-key check needs it); if its fan is busy the
-- attempt rolls back its locks and starts again.
create or replace function public._lock_wheel_lifecycle(p_wheel uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_try integer;
begin
 for v_try in 1..20 loop
   begin
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
     perform 1 from public.wheels where id=p_wheel for update;
     perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
       union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update nowait;
     return;
   exception when lock_not_available then null;
   end;
 end loop;
 perform 1 from public.fans where id in(select fan_id from public.fan_focus where wheel_id=p_wheel and status in('active','paused')
   union select fan_id from public.fan_passes where pinned_wheel_id=p_wheel) order by id for update;
 perform 1 from public.wheels where id=p_wheel for update;
end $$;
revoke execute on function public._lock_wheel_lifecycle(uuid) from public,anon,authenticated,service_role;

-- Same authority as the wheels_write policy the direct UPDATE/DELETE used.
create or replace function public.archive_wheel(p_wheel uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_creator uuid;
begin
 select creator_id into v_creator from public.wheels where id=p_wheel;
 if v_creator is null or not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 perform public._lock_wheel_lifecycle(p_wheel);
 update public.wheels set archived_at=coalesce(archived_at,now()),is_active=false where id=p_wheel;
 return 'ok';
end $$;
revoke execute on function public.archive_wheel(uuid) from public,anon;
grant execute on function public.archive_wheel(uuid) to authenticated,service_role;

create or replace function public.delete_wheel(p_wheel uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_creator uuid;
begin
 select creator_id into v_creator from public.wheels where id=p_wheel;
 if v_creator is null or not (public.can_act_for(v_creator,'edit_wheel') or public.is_admin()) then return 'not_found'; end if;
 perform public._lock_wheel_lifecycle(p_wheel);
 -- A game with play history is archived, never deleted (spins and
 -- redemptions are revenue and analytics records), and so is a game any fan
 -- link is stored on: fan_passes.wheel_id cascades, so the delete would erase
 -- the link and its balance even when the link now plays another game. Under
 -- the wheel lock no new link can reference it (its foreign-key check waits).
 if exists(select 1 from public.spins where wheel_id=p_wheel)
   or exists(select 1 from public.fan_passes where wheel_id=p_wheel) then return 'has_history'; end if;
 delete from public.wheels where id=p_wheel;
 return 'ok';
end $$;
revoke execute on function public.delete_wheel(uuid) from public,anon;
grant execute on function public.delete_wheel(uuid) to authenticated,service_role;
-- ── 0063: a queued initializer serializes instead of timing out ────────────
create or replace function public.initialize_reward_crypto_canary(p_canary jsonb,p_inventory_digest text,p_actor uuid default null,p_context uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_existing jsonb; v_count integer; v_digest text;
begin
 --0062 admin/profile writes take this fence before row/storage/inventory locks.
 -- Preserve that order: an admitted request must not outlive admin revocation.
 if p_actor is not null then perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0)); end if;
 -- Concurrent initializers serialize here; no inventory writer takes this lock,
 -- so waiting on it never stalls a play, and the loser returns 'existing'.
 perform pg_advisory_xact_lock(hashtextextended('reward-crypto-canary-initializer',0));
 -- 0065: the lock timeout starts only after the serializing waits above. Set
 -- before them, a queued initializer failed with 55P03 whenever the first one
 -- held the initializer lock for more than 3s under load, instead of waiting
 -- and returning 'existing'. Transaction-local, not a function SET: direct-
 -- crypto functions keep exactly the pinned search_path config
 -- (scripts/db/cryptoNamespaceProbe.mjs).
 perform set_config('lock_timeout','3s',true);
 if p_actor is not null then
   if not public._creator_actor_allowed(p_context,p_actor,p_actor,'system_health','system_health') then return jsonb_build_object('status','forbidden');end if;
   perform 1 from public.profiles where id=p_actor and role='admin' and is_active;
   if not found then return jsonb_build_object('status','forbidden'); end if;
 end if;
 -- 0065: an existing anchor is answered before the inventory fence. Only an
 -- initializer writes the anchor and initializers serialize on the lock above,
 -- so a queued one sees its predecessor's committed anchor here. Checked after
 -- the try-lock below (as before 0065), a queued initializer woken by the
 -- predecessor's commit could find the inventory fence not yet released (a
 -- commit releases its advisory locks one by one) and answered inventory_busy.
 select public.read_reward_crypto_canary() into v_existing;
 if v_existing is not null then return jsonb_build_object('status','existing','canary',v_existing); end if;
 -- Never queue behind in-flight inventory writers: a waiting exclusive request
 -- would make later shared requests wait too, and an inventory writer that then
 -- waits for a fan row (set_prize_delivery -> prize lifecycle -> _release_fan_focus)
 -- could close a cycle with a credited play. Busy is a retryable outcome.
 if not pg_try_advisory_xact_lock(hashtextextended('reward-crypto-canary-initialize',0)) then
   return jsonb_build_object('status','inventory_busy');
 end if;
 if p_canary is null or jsonb_typeof(p_canary)<>'object' or
   (select count(*) from jsonb_object_keys(p_canary))<>4 or
   p_canary->>'cipher' is null or length(p_canary->>'cipher') not between 24 and 2048 or
   p_canary->>'iv' is null or length(p_canary->>'iv') not between 16 and 64 or
   coalesce(p_canary->>'keyVersion','')!~'^[1-9][0-9]{0,4}$' or (p_canary->>'keyVersion')::integer>32767 or
   coalesce(p_canary->>'fingerprint','')!~'^[a-f0-9]{64}$' or coalesce(p_inventory_digest,'')!~'^[a-f0-9]{64}$'
 then raise exception 'invalid key anchor' using errcode='22023'; end if;
 -- The exclusive fence blocks encrypted-inventory writers until this first
 -- anchor commits. A lost scan/racing insert cannot bless a different snapshot.
 if exists(select 1 from public.prize_reward_codes where erased_at is not null) then
   return jsonb_build_object('status','recovery_required');
 end if;
 select count(*) into v_count from (select 1 from public._reward_crypto_inventory() limit 25001) x;
 if v_count>25000 then return jsonb_build_object('status','inventory_limit'); end if;
 if p_actor is null and v_count>0 then return jsonb_build_object('status','initialization_required'); end if;
 select encode(digest(coalesce(string_agg(row_digest,'' order by cursor collate "C"),''),'sha256'),'hex') into v_digest from public._reward_crypto_inventory();
 if v_digest is distinct from p_inventory_digest then return jsonb_build_object('status','inventory_changed'); end if;
 insert into public.reward_crypto_canary(singleton,cipher,iv,key_version,fingerprint)
 values(true,p_canary->>'cipher',p_canary->>'iv',(p_canary->>'keyVersion')::smallint,p_canary->>'fingerprint');
 return jsonb_build_object('status','initialized','canary',public.read_reward_crypto_canary(),'inventoryRows',v_count);
end $$;
