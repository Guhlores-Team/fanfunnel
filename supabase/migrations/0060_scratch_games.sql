-- 0060: explicit game metadata and one atomic scratch play, on the0059 ledger.
-- Historical wheel snapshot bytes/RNG are unchanged. Bingo is refused here;
--0061 supplies its card/line transaction before that game can be enabled.
alter table public.wheels add column if not exists game_kind text not null default 'wheel';
alter table public.wheels add column if not exists game_config jsonb not null default '{}'::jsonb;
alter table public.wheels add column if not exists game_ready boolean not null default true;
alter table public.wheel_templates add column if not exists game_kind text not null default 'wheel';
alter table public.wheel_templates add column if not exists game_config jsonb not null default '{}'::jsonb;
alter table public.wheel_templates add column if not exists game_ready boolean not null default true;
alter table public.spins add column if not exists game_kind text not null default 'wheel';
alter table public.spins add column if not exists presentation jsonb;
alter table public.wheels drop constraint if exists wheels_game_kind_check;
alter table public.wheels add constraint wheels_game_kind_check check(game_kind in('wheel','scratch','bingo'));
alter table public.wheel_templates drop constraint if exists wheel_templates_game_kind_check;
alter table public.wheel_templates add constraint wheel_templates_game_kind_check check(game_kind in('wheel','scratch','bingo'));
alter table public.spins drop constraint if exists spins_game_kind_check;
alter table public.spins add constraint spins_game_kind_check check(game_kind in('wheel','scratch','bingo'));

create or replace function public._game_feature_allowed(p_creator uuid,p_kind text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')
   and (p_kind='wheel' or (p_kind='scratch' and features->'scratch'='true'::jsonb)));
$$;
revoke execute on function public._game_feature_allowed(uuid,text) from public,anon,authenticated,service_role;

-- Direct INSERT/UPDATE, duplicates, imports and stored templates share this
-- validation. Feature removal preserves existing paid links and same-kind edits.
create or replace function public._guard_game_settings()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed_kind boolean:=true;
begin
 if new.game_kind='bingo' then raise exception 'game_unavailable' using errcode='22023'; end if;
 if new.game_kind not in('wheel','scratch') or not new.game_ready
   or (new.game_kind='wheel' and new.game_config<>'{}'::jsonb)
   or (new.game_kind='scratch' and new.game_config<>'{"style":"classic"}'::jsonb) then
   raise exception 'invalid_game_config' using errcode='22023';
 end if;
 if tg_op='UPDATE' then
   if new.creator_id is distinct from old.creator_id then raise exception 'game_owner_immutable' using errcode='22023'; end if;
   changed_kind:=new.game_kind is distinct from old.game_kind;
   if changed_kind and tg_table_name='wheels' and exists(select 1 from public.spins where wheel_id=old.id) then
     raise exception 'game_kind_locked' using errcode='22023';
   end if;
 end if;
 if new.game_kind<>'wheel' and not exists(select 1 from public.profiles where id=new.creator_id and is_active and (approval_status='approved' or role='admin')) then
   raise exception 'creator_unavailable' using errcode='42501';
 end if;
 if new.game_kind<>'wheel' and (tg_op='INSERT' or changed_kind) and not public._game_feature_allowed(new.creator_id,new.game_kind) then
   raise exception 'feature_disabled' using errcode='42501';
 end if;
 return new;
end $$;
revoke execute on function public._guard_game_settings() from public,anon,authenticated,service_role;
drop trigger if exists aa_game_settings on public.wheels;
create trigger aa_game_settings before insert or update of game_kind,game_config,game_ready,creator_id on public.wheels for each row execute function public._guard_game_settings();
drop trigger if exists aa_game_settings on public.wheel_templates;
create trigger aa_game_settings before insert or update of game_kind,game_config,game_ready,creator_id on public.wheel_templates for each row execute function public._guard_game_settings();

create or replace function public._scratch_visible(p_value text)
returns text language sql immutable strict set search_path=public as $$
 -- Match pinned JS identity without locale-specific case conversion.
 select translate(btrim(translate(normalize(p_value,NFKC),U&'\FE0E\FE0F\200D',''),
 U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),
 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
$$;
revoke execute on function public._scratch_visible(text) from public,anon,authenticated,service_role;

-- This validates the persisted face against the exact committed public pool.
-- The trusted service uses the versioned pure RNG/replay engine to derive its
-- precise order; SQL retains0059's service RNG boundary and validates economics.
create or replace function public._valid_scratch_presentation(p_snapshot jsonb,p_prize uuid,p_presentation jsonb)
returns boolean language plpgsql immutable set search_path=public as $$
declare c jsonb; winner jsonb; source jsonb; decoration jsonb; winning_emoji jsonb; wins integer:=0;
 ids text[]:=array[]::text[]; labels text[]:=array[]::text[]; symbols text[]:=array[]::text[]; label_key text; symbol_key text;
 decorations constant jsonb:='[["circle","Circle","●"],["square","Square","■"],["triangle","Triangle","▲"],["diamond","Diamond","◆"],["star","Star","★"],["flower","Flower","✿"],["crescent","Crescent","☾"],["sun","Sun","☀"],["heart","Heart","♥"],["cross","Cross","✚"],["hexagon","Hexagon","⬡"],["pentagon","Pentagon","⬟"],["outline-triangle","Outline triangle","△"],["outline-diamond","Outline diamond","◇"],["ring","Ring","○"],["clover","Clover","♣"],["spade","Spade","♠"],["lightning","Lightning","ϟ"],["note","Musical note","♪"],["infinity","Infinity","∞"]]'::jsonb;
begin
 if jsonb_typeof(p_presentation) is distinct from 'object' then return false; end if;
 if p_presentation->>'kind' is distinct from 'scratch' or (select count(*) from jsonb_object_keys(p_presentation))<>2
   or jsonb_typeof(p_presentation->'cells') is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_presentation->'cells')<>9 then return false; end if;
 select x into winner from jsonb_array_elements(p_snapshot->'prizes') x where x->>'id'=p_prize::text;
 if winner is null then return false; end if;
 winning_emoji:=case when coalesce(public._scratch_visible(winner->>'emoji'),'')<>'' then winner->'emoji' else 'null'::jsonb end;
 for c in select value from jsonb_array_elements(p_presentation->'cells') loop
   if jsonb_typeof(c) is distinct from 'object' then return false; end if;
   if (select count(*) from jsonb_object_keys(c))<>4 or exists(select 1 from jsonb_object_keys(c) k where k not in('kind','id','label','emoji'))
     or jsonb_typeof(c->'id') is distinct from 'string' or jsonb_typeof(c->'label') is distinct from 'string'
     or c->>'kind' not in('prize','decoration') or not(c ? 'emoji') then return false; end if;
   if c->>'id'=p_prize::text then
     if c->>'kind'<>'prize' or c->>'label' is distinct from winner->>'label' or c->'emoji' is distinct from winning_emoji then return false; end if;
     wins:=wins+1;
   elsif c->>'kind'='prize' then
     select x into source from jsonb_array_elements(p_snapshot->'prizes') x where x->>'id'=c->>'id';
     if source is null or c->>'label' is distinct from source->>'label' or c->'emoji' is distinct from source->'emoji' then return false; end if;
   else
     select x into decoration from jsonb_array_elements(decorations) x where 'scratch-v1:'||(x->>0)=c->>'id';
     if decoration is null or c->>'label' is distinct from 'Decorative '||translate(decoration->>1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') or c->>'emoji' is distinct from decoration->>2 then return false; end if;
   end if;
   if not(c->>'id'=p_prize::text and c->>'id'=any(ids)) then
     if c->>'id'=any(ids) then return false; end if;
     label_key:=public._scratch_visible(c->>'label');symbol_key:=public._scratch_visible(case when c->'emoji'='null'::jsonb then '◇' else c->>'emoji' end);
     if c->>'id'<>p_prize::text and (jsonb_typeof(c->'emoji') is distinct from 'string' or coalesce(symbol_key,'')='') then return false; end if;
     if label_key=any(labels) or symbol_key=any(symbols) then return false; end if;
     ids:=array_append(ids,c->>'id');labels:=array_append(labels,label_key);symbols:=array_append(symbols,symbol_key);
   end if;
 end loop;
 return wins=3 and cardinality(ids)=7;
end $$;
revoke execute on function public._valid_scratch_presentation(jsonb,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function public._guard_immutable_game_proof()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' then
   if new.game_kind is distinct from old.game_kind or new.presentation is distinct from old.presentation
     or (old.game_kind<>'wheel' and (new.pool_snapshot is distinct from old.pool_snapshot or new.pool_hash is distinct from old.pool_hash or new.fair_trace is distinct from old.fair_trace)) then
     raise exception 'game proof is immutable' using errcode='22023';
   end if;
 elsif new.game_kind<>'wheel' and (new.game_kind<>'scratch' or not public._valid_scratch_presentation(new.pool_snapshot,new.prize_id,new.presentation)) then
   raise exception 'invalid game presentation' using errcode='22023';
 elsif new.game_kind='wheel' and new.presentation is not null then
   raise exception 'unexpected wheel presentation' using errcode='22023';
 end if;
 return new;
end $$;
revoke execute on function public._guard_immutable_game_proof() from public,anon,authenticated,service_role;
drop trigger if exists ab_immutable_game_proof on public.spins;
create trigger ab_immutable_game_proof before insert or update of game_kind,presentation,pool_snapshot,pool_hash,fair_trace on public.spins for each row execute function public._guard_immutable_game_proof();

create or replace function public._resolved_spin_wheel(p_pass uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(
  (select w.id from public.campaigns c join public.wheels w on w.id=c.pinned_wheel_id
    where c.id=fp.campaign_id and w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch')),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch')
    and (w.active_from is not null or w.active_until is not null)
    and (w.active_from is null or w.active_from<=now()) and (w.active_until is null or w.active_until>now())
    order by w.active_from desc nulls last,w.created_at desc,w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch') and w.is_active order by w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch') order by w.created_at,w.id limit 1),
  (select w.id from public.wheels w where w.id=fp.wheel_id and w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch')))
 from public.fan_passes fp where fp.id=p_pass;
$$;

create or replace function public.prepare_spin_attempt(p_attempt uuid,p_token text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; a public.spin_attempts%rowtype; c jsonb; fresh boolean:=false;
begin
 if p_attempt is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid attempt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt;
 if found then
   if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 end if;
 select * into p from public.fan_passes where token=p_token;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 select * into f from public.fans where id=p.fan_id and creator_id=p.creator_id for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 select * into p from public.fan_passes where id=p.id for update;
 if not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then
   return jsonb_build_object('status','unavailable');
 end if;
 if a.id is null then
   insert into public.spin_attempts(id,creator_id,fan_id,fan_pass_id,token_hash,request_hash)
   values(p_attempt,p.creator_id,p.fan_id,p.id,encode(digest(p_token,'sha256'),'hex'),p_request_hash);
 end if;
 if f.break_until>now() or f.acked_at is null or f.acked_terms_version is distinct from '2026-10-27' or p.spins_remaining<=0 then
   update public.spin_attempts set state='declined',error=case when f.break_until>now() then 'on_break' when f.acked_at is null or f.acked_terms_version is distinct from '2026-10-27' then 'needs_ack' else 'no_spins' end,finished_at=now() where id=p_attempt;
   return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash);
 end if;
 if public._resolved_spin_wheel(p.id) is null then
   update public.spin_attempts set state='declined',error='no_wheel',finished_at=now() where id=p_attempt;
   return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash);
 end if;
 perform set_config('fanfunnel.economic_write','on',true);
 if p.next_server_seed is null or p.next_server_seed_hash is null then
   p.next_server_seed:=encode(gen_random_bytes(32),'hex');
   update public.fan_passes set next_server_seed=p.next_server_seed,next_server_seed_hash=encode(digest(p.next_server_seed,'sha256'),'hex') where id=p.id;
   fresh:=true;
 end if;
 perform 1 from public.fan_focus where fan_id=p.fan_id and status in('active','paused') for update;
 c:=public._spin_attempt_context(p.id);
 c:=c||jsonb_build_object('commitment',case when fresh or (a.context->>'serverSeed'=c->>'serverSeed' and a.context->>'commitment'='fresh') then 'fresh' else 'stored' end);
 update public.spin_attempts set context=c where id=p_attempt;
 return jsonb_build_object('status','ready','context',c,'balance',p.spins_remaining);
end $$;

create or replace function public.commit_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_context jsonb,p_spin jsonb,p_expected_reward jsonb,p_next_seed jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare a public.spin_attempts%rowtype; p public.fan_passes%rowtype; f public.fans%rowtype; ff public.fan_focus%rowtype;
 r public.chase_reservations%rowtype; pr public.prizes%rowtype; target public.prizes%rowtype;
 code public.prize_reward_codes%rowtype; reward public.prize_rewards%rowtype; s public.spins%rowtype;
 current_context jsonb; snapshot jsonb; proof jsonb; mod_focus jsonb; mod_chase jsonb; row_proof jsonb;
 hh numeric; factor numeric; effective numeric; applied boolean:=false; eligible boolean:=false; target_available boolean:=false;
 pity_due boolean; focus_consumed boolean:=false; chase_due boolean:=false; chase_complete boolean:=false; has_rare boolean; v_stock_after integer;
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
 if s.game_kind is distinct from current_context#>>'{wheel,game_kind}' or s.game_kind not in('wheel','scratch') or current_context#>'{wheel,game_ready}' is distinct from 'true'::jsonb then raise exception 'game context mismatch' using errcode='22023'; end if;
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
   or exists(select 1 from jsonb_object_keys(snapshot) k where k not in('v','rules','game','prizes','modifiers') and not(s.game_kind='scratch' and k in('gameRules','gameConfig')))
   or exists(select 1 from jsonb_object_keys(snapshot->'modifiers') k where k not in('happyHour','pity','focus','chase'))
   or s.fair_trace->>'won' is distinct from s.prize_id::text then raise exception 'invalid proof envelope' using errcode='22023'; end if;
 if s.game_kind='scratch' then
   if snapshot->>'gameRules' is distinct from 'scratch-v1' or snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'
     or not public._valid_scratch_presentation(snapshot,s.prize_id,s.presentation)
     or s.fair_trace->'bonuses' is distinct from '[]'::jsonb
     or (select count(*) from jsonb_object_keys(s.fair_trace))<>3 then raise exception 'invalid scratch proof' using errcode='22023'; end if;
 elsif s.presentation is not null then raise exception 'unexpected wheel presentation' using errcode='22023'; end if;
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
     or (s.game_kind='scratch' and row_proof->'emoji' is distinct from coalesce(to_jsonb(pr.emoji),'null'::jsonb))
     or (row_proof->>'baseW')::numeric is distinct from pr.weight::numeric then raise exception 'pool base mismatch' using errcode='22023'; end if;
   factor:=case when pr.rarity in('rare','epic','legendary') then hh else 1 end;
   if applied and pr.id=ff.prize_id then factor:=least(5,factor*ff.multiplier); end if;
   effective:=case when pr.weight=0 then 0 else greatest(1,floor(pr.weight*factor+0.5)) end;
   if (row_proof->>'w')::numeric is distinct from effective then raise exception 'pool effective weight mismatch' using errcode='22023'; end if;
 end loop;
 select * into pr from public.prizes where id=s.prize_id and wheel_id=s.wheel_id;
 if not found then return jsonb_build_object('status','sold_out'); end if;
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
 if pr.delivery is distinct from p_expected_reward->>'delivery' then return jsonb_build_object('status','changed'); end if;
 is_held:=r.state='held' and r.prize_id=pr.id and eligible;
 if pr.delivery='codes' then
   select * into code from public.prize_reward_codes where id=(p_expected_reward->>'codeId')::uuid and prize_id=pr.id and spin_id is null for update;
   if code.id is null or (is_held and code.id is distinct from r.code_id) or (not is_held and code.reserved_focus_id is not null) then
     if is_held or exists(select 1 from public.prize_reward_codes where prize_id=pr.id and spin_id is null and reserved_focus_id is null) then return jsonb_build_object('status','changed'); end if;
     return jsonb_build_object('status','sold_out');
   end if;
   if code.cipher is distinct from p_expected_reward->>'cipher' or code.iv is distinct from p_expected_reward->>'iv'
     or code.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed'); end if;
 elsif pr.delivery in('link','text') then
   select * into reward from public.prize_rewards where prize_id=pr.id;
   if reward.kind is distinct from pr.delivery or reward.cipher is distinct from p_expected_reward->>'cipher'
     or reward.iv is distinct from p_expected_reward->>'iv' or reward.key_version is distinct from (p_expected_reward->>'keyVersion')::smallint then return jsonb_build_object('status','changed'); end if;
 end if;
 if not is_held and pr.stock is not null and pr.stock<=0 then return jsonb_build_object('status','sold_out'); end if;
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
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end);
 if is_held then update public.chase_reservations set state='consumed',consumed_spin_id=s.id,ended_at=now() where id=r.id and state='held'; end if;
 if ff.id is not null then
   update public.fan_focus set spins_left=coalesce(next_focus,spins_left),chase_counter=coalesce(next_chase,chase_counter),version=version+1,
     status=case when chase_complete or next_focus=0 then 'done' else 'active' end,
     ended_at=case when chase_complete or next_focus=0 then now() else null end where id=ff.id;
 end if;
 select stock into v_stock_after from public.prizes where id=pr.id;
 update public.spin_rewards set stock_after=v_stock_after where spin_id=s.id;
 update public.spin_attempts set state='committed',spin_id=s.id,finished_at=now(),result=jsonb_build_object(
   'id',s.id,'shareId',s.share_id,'spin',to_jsonb(s),'createdAt',s.created_at,'stockAfter',v_stock_after,
   'gameKind',s.game_kind,'presentation',s.presentation,'bonusWins','[]'::jsonb,
   'originalNextServerSeedHash',p_next_seed->>'hash','pityAwarded',pity_due,'chaseAwarded',chase_due,'chaseCompleted',chase_complete,
   'focusConsumed',focus_consumed,'chaseConsumed',eligible,
   'prize',p_spin->'response_prize','prizeIndex',(p_spin->>'response_prize_index')::int,'showStock',(p_spin->>'response_show_stock')::boolean) where id=p_attempt;
 return public._spin_attempt_receipt(p_attempt,false);
end $$;

create or replace function public._create_pass_grant_core(p_request uuid,p_creator uuid,p_fan uuid,p_wheel uuid,p_name text,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid,p_referral_code text default null,p_pack uuid default null,p_pack_units integer default 1)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare f public.fans%rowtype; p public.fan_passes%rowtype; g public.grants%rowtype; ref uuid; h text; outcome jsonb; pack public.campaign_packs%rowtype;
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
 if p_wheel is null then
   select w.id into p_wheel from public.campaigns c join public.wheels w on w.id=c.pinned_wheel_id
     where c.id=p_campaign and c.creator_id=p_creator and w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch');
   if p_wheel is null then select id into p_wheel from public.wheels where creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch') and is_active order by created_at,id limit 1; end if;
   if p_wheel is null then select id into p_wheel from public.wheels where creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch') order by created_at,id limit 1; end if;
 end if;
 if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch')) then return jsonb_build_object('status','invalid','error','no_wheel'); end if;
 if p_fan is null then
   insert into public.fans(creator_id,display_name) values(p_creator,left(p_name,200)) returning * into f;
 else
   select * into f from public.fans where id=p_fan and creator_id=p_creator for update;
   if not found then return jsonb_build_object('status','invalid','error','fan_not_found'); end if;
   if f.break_until>now() then return jsonb_build_object('status','unavailable','error','on_break'); end if;
   if f.blocked_at is not null or exists(select 1 from public.fan_passes where fan_id=p_fan and self_excluded_at is not null) then return jsonb_build_object('status','unavailable','error','blocked'); end if;
 end if;
 select * into p from public.fan_passes where fan_id=f.id and creator_id=p_creator and wheel_id=p_wheel and is_active and self_excluded_at is null order by created_at,id limit 1 for update;
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

revoke execute on function public._resolved_spin_wheel(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._create_pass_grant_core(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer) from public,anon,authenticated,service_role;
revoke execute on function public.prepare_spin_attempt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.prepare_spin_attempt(uuid,text,text) to service_role;
revoke execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;
