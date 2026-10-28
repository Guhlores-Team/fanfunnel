-- 0059: one durable transaction owns every upgraded spin and paid focus grant.
-- Legacy fairness proofs are never rewritten. New traffic must not fall back
-- to the retired split claim/seed/pity/stock writers when this RPC is absent.
select set_config('fanfunnel.economic_write','on',false);
alter table public.prizes add column if not exists boostable boolean not null default false;
alter table public.fan_passes add column if not exists next_spin_nonce bigint not null default 0;
alter table public.fan_passes drop constraint if exists fan_passes_next_spin_nonce_check;
alter table public.fan_passes add constraint fan_passes_next_spin_nonce_check check (next_spin_nonce >= 0);
update public.fan_passes p set next_spin_nonce = greatest(p.next_spin_nonce,
  coalesce((select max(s.nonce) + 1 from public.spins s where s.fan_pass_id = p.id),0));
update public.happy_hours set multiplier = 5 where multiplier > 5;
alter table public.happy_hours drop constraint if exists happy_hours_multiplier_check;
alter table public.happy_hours add constraint happy_hours_multiplier_check check (multiplier between 1 and 5);
alter table public.campaign_packs add column if not exists pack_kind text not null default 'spins';
alter table public.campaign_packs add column if not exists focus_multiplier numeric not null default 3;
alter table public.campaign_packs add column if not exists focus_spins integer not null default 10;
alter table public.campaign_packs add column if not exists chase_within integer not null default 10;
alter table public.campaign_packs drop constraint if exists campaign_packs_focus_terms_check;
alter table public.campaign_packs add constraint campaign_packs_focus_terms_check check (
  pack_kind in ('spins','focus','chase') and focus_multiplier between 1.5 and 5
  and focus_spins between 5 and 50 and chase_within between 5 and 50);
alter table public.grants add column if not exists request_hash text;

create table if not exists public.focus_creator_config (
  creator_id uuid primary key references public.profiles(id) on delete cascade,
  focus_enabled boolean not null default true,
  chase_enabled boolean not null default false
);
create table if not exists public.fan_focus (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  fan_id uuid not null references public.fans(id) on delete cascade,
  fan_pass_id uuid references public.fan_passes(id) on delete set null,
  wheel_id uuid references public.wheels(id) on delete set null,
  prize_id uuid references public.prizes(id) on delete set null,
  prize_label text not null,
  grant_id uuid references public.grants(id) on delete set null,
  kind text not null check (kind in ('focus','chase')),
  multiplier numeric not null check (multiplier between 1.5 and 5),
  total_spins integer not null check (total_spins between 5 and 50),
  spins_left integer not null check (spins_left between 0 and 50),
  chase_counter integer not null default 0 check (chase_counter between 0 and 50),
  status text not null default 'active' check (status in ('active','paused','done','released')),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists fan_focus_one_live_idx on public.fan_focus(fan_id) where status in ('active','paused');
create table if not exists public.chase_reservations (
  id uuid primary key default gen_random_uuid(),
  focus_id uuid not null unique references public.fan_focus(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  prize_id uuid references public.prizes(id) on delete set null,
  kind text not null check (kind in ('stock','code','unlimited')),
  state text not null default 'held' check (state in ('held','consumed','released')),
  code_id uuid references public.prize_reward_codes(id) on delete set null,
  consumed_spin_id uuid unique references public.spins(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  check (kind <> 'code' or state <> 'held' or code_id is not null)
);
alter table public.chase_reservations drop constraint if exists chase_reservations_code_id_key;
create unique index if not exists chase_reservations_live_code_idx on public.chase_reservations(code_id) where state in('held','consumed');
alter table public.prize_reward_codes add column if not exists reserved_focus_id uuid references public.fan_focus(id) on delete set null;
create unique index if not exists prize_reward_codes_held_focus_idx on public.prize_reward_codes(reserved_focus_id) where reserved_focus_id is not null;
create table if not exists public.spin_attempts (
  id uuid primary key,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  fan_id uuid references public.fans(id) on delete set null,
  fan_pass_id uuid references public.fan_passes(id) on delete set null,
  token_hash text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending','committed','declined')),
  error text,
  context jsonb,
  result jsonb,
  spin_id uuid unique references public.spins(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((state='pending' and finished_at is null) or (state<>'pending' and finished_at is not null))
);

alter table public.focus_creator_config enable row level security;
alter table public.fan_focus enable row level security;
alter table public.chase_reservations enable row level security;
alter table public.spin_attempts enable row level security;
drop policy if exists focus_creator_config_select on public.focus_creator_config;
create policy focus_creator_config_select on public.focus_creator_config for select to authenticated
  using (public.can_act_for(creator_id,'view') or public.is_admin());
drop policy if exists fan_focus_select on public.fan_focus;
create policy fan_focus_select on public.fan_focus for select to authenticated
  using (public.can_act_for(creator_id,'view') or public.is_admin());
drop policy if exists chase_reservations_select on public.chase_reservations;
create policy chase_reservations_select on public.chase_reservations for select to authenticated
  using (public.can_act_for(creator_id,'view') or public.is_admin());
drop policy if exists spin_attempts_select on public.spin_attempts;
create policy spin_attempts_select on public.spin_attempts for select to authenticated
  using (public.can_act_for(creator_id,'view') or public.is_admin());
revoke all on public.focus_creator_config,public.fan_focus,public.chase_reservations,public.spin_attempts from public,anon,authenticated;
grant select on public.focus_creator_config,public.fan_focus to authenticated;
grant select(id,focus_id,creator_id,prize_id,kind,state,consumed_spin_id,created_at,ended_at) on public.chase_reservations to authenticated;
-- Context contains the next secret seed; it has no browser/creator privilege.
grant select(id,creator_id,fan_id,fan_pass_id,state,error,spin_id,created_at,finished_at) on public.spin_attempts to authenticated;
grant all on public.focus_creator_config,public.fan_focus,public.chase_reservations,public.spin_attempts to service_role;

create or replace function public.sync_code_prize_stock()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.delivery='codes' then
    select count(*) into new.stock from public.prize_reward_codes
      where prize_id=new.id and spin_id is null and reserved_focus_id is null;
  end if;
  return new;
end $$;

-- A private release is a CAS on the reservation, never a blind increment.
create or replace function public._release_fan_focus(p_fan uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f public.fan_focus%rowtype; r public.chase_reservations%rowtype;
begin
  perform 1 from public.fans where id=p_fan for update;
  perform 1 from public.fan_passes where fan_id=p_fan order by id for update;
  select * into f from public.fan_focus where fan_id=p_fan and status in('active','paused') for update;
  if not found then return null; end if;
  select * into r from public.chase_reservations where focus_id=f.id for update;
  if found and r.state='held' then
    perform 1 from public.prizes where id=r.prize_id for update;
    if r.kind='code' then
      update public.prize_reward_codes set reserved_focus_id=null where id=r.code_id and reserved_focus_id=f.id and spin_id is null;
      if current_setting('fanfunnel.focus_prize_lifecycle',true) is distinct from r.prize_id::text then update public.prizes set stock=stock where id=r.prize_id; end if;
    elsif r.kind='stock' then
      if current_setting('fanfunnel.focus_prize_lifecycle',true) is distinct from r.prize_id::text then update public.prizes set stock=stock+1 where id=r.prize_id and stock is not null; end if;
    end if;
    update public.chase_reservations set state='released',ended_at=now() where id=r.id and state='held';
  end if;
  update public.fan_focus set status='released',version=version+1,ended_at=now() where id=f.id returning * into f;
  return to_jsonb(f);
end $$;

create or replace function public._focus_lifecycle()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_fan uuid;
begin
  if tg_table_name='fans' then
    if tg_op='DELETE' or (new.blocked_at is not null and old.blocked_at is null) then
      perform public._release_fan_focus(old.id);
      if tg_op='DELETE' then
        update public.spin_attempts set context=null,result=case when result is null then null else jsonb_set(jsonb_set(result,'{spin,fan_id}','null'::jsonb),'{spin,fan_pass_id}','null'::jsonb) end where fan_id=old.id;
      end if;
    elsif new.break_until is distinct from old.break_until then
      update public.fan_focus set status=case when new.break_until>now() then 'paused' else 'active' end,version=version+1
        where fan_id=new.id and status in('active','paused');
    end if;
  elsif tg_table_name='fan_passes' then
    if tg_op='DELETE' or not new.is_active or new.self_excluded_at is not null then
      for v_fan in select distinct fan_id from public.fan_focus where fan_pass_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  elsif tg_table_name='prizes' then
    -- Changing delivery while a chase is held also invalidates that promise.
    if tg_op='DELETE' or new.delivery is distinct from old.delivery then
      perform set_config('fanfunnel.focus_prize_lifecycle',old.id::text,true);
      if tg_op<>'DELETE' and new.stock is not null then
        new.stock:=new.stock+(select count(*) from public.chase_reservations where prize_id=old.id and kind in('stock','code') and state='held');
      end if;
      for v_fan in select distinct fan_id from public.fan_focus where prize_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
      perform set_config('fanfunnel.focus_prize_lifecycle','',true);
    end if;
  elsif tg_table_name='wheels' then
    if tg_op='DELETE' or new.archived_at is not null then
      for v_fan in select distinct fan_id from public.fan_focus where wheel_id=old.id and status in('active','paused') loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  elsif tg_table_name='profiles' then
    if tg_op='DELETE' or not new.is_active then
      for v_fan in select fan_id from public.fan_focus where creator_id=old.id and status in('active','paused') order by fan_id loop
        perform public._release_fan_focus(v_fan);
      end loop;
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists aa_focus_lifecycle on public.fans;
create trigger aa_focus_lifecycle before delete or update of blocked_at,break_until on public.fans for each row execute function public._focus_lifecycle();
drop trigger if exists aa_focus_lifecycle on public.fan_passes;
create trigger aa_focus_lifecycle before delete or update of is_active,self_excluded_at on public.fan_passes for each row execute function public._focus_lifecycle();
drop trigger if exists aa_focus_lifecycle on public.prizes;
create trigger aa_focus_lifecycle before delete or update of delivery on public.prizes for each row execute function public._focus_lifecycle();
drop trigger if exists aa_focus_lifecycle on public.wheels;
create trigger aa_focus_lifecycle before delete or update of archived_at on public.wheels for each row execute function public._focus_lifecycle();
drop trigger if exists aa_focus_lifecycle on public.profiles;
create trigger aa_focus_lifecycle before delete or update of is_active on public.profiles for each row execute function public._focus_lifecycle();

create or replace function public._resolved_spin_wheel(p_pass uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(
  (select w.id from public.campaigns c join public.wheels w on w.id=c.pinned_wheel_id
    where c.id=fp.campaign_id and w.creator_id=fp.creator_id and w.archived_at is null),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null
    and (w.active_from is not null or w.active_until is not null)
    and (w.active_from is null or w.active_from<=now()) and (w.active_until is null or w.active_until>now())
    order by w.active_from desc nulls last,w.created_at desc,w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null and w.is_active order by w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=fp.creator_id and w.archived_at is null order by w.created_at,w.id limit 1),
  (select w.id from public.wheels w where w.id=fp.wheel_id and w.creator_id=fp.creator_id and w.archived_at is null))
 from public.fan_passes fp where fp.id=p_pass;
$$;

-- This function is private because context contains unrevealed seeds and codes.
create or replace function public._spin_attempt_context(p_pass uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; w public.wheels%rowtype;
 ff public.fan_focus%rowtype; r public.chase_reservations%rowtype; v_prizes jsonb; v_hash_prizes jsonb; v jsonb; hh numeric;
begin
 select * into p from public.fan_passes where id=p_pass;
 select * into f from public.fans where id=p.fan_id;
 select * into w from public.wheels where id=public._resolved_spin_wheel(p_pass);
 select * into ff from public.fan_focus where fan_id=p.fan_id and status in('active','paused');
 select * into r from public.chase_reservations where focus_id=ff.id and state='held';
 select coalesce(jsonb_agg(to_jsonb(pr) || jsonb_build_object('stock',case when r.prize_id=pr.id and r.state='held' and pr.stock is not null then pr.stock+1 else pr.stock end) order by pr.sort_order,pr.id),'[]'::jsonb)
   into v_prizes from public.prizes pr where pr.wheel_id=w.id;
 select coalesce(jsonb_agg(x-'stock' order by x->>'id'),'[]'::jsonb) into v_hash_prizes from jsonb_array_elements(v_prizes) x;
 select least(5,coalesce(max(multiplier),1)) into hh from public.happy_hours where wheel_id=w.id and starts_at<=now() and ends_at>now();
 v:=jsonb_build_object('fanId',p.fan_id,'passId',p.id,'creatorId',p.creator_id,'campaignId',p.campaign_id,
  'wheelId',w.id,'wheel',to_jsonb(w),'serverSeed',p.next_server_seed,'serverSeedHash',p.next_server_seed_hash,
  'nonce',p.next_spin_nonce,'pityCounter',f.pity_counter,'happyHourMultiplier',hh,
  'focus',case when ff.id is null then null else to_jsonb(ff) end,
  'reservation',case when r.id is null then null else to_jsonb(r) end);
 return v || jsonb_build_object('prizes',v_prizes,'contextHash',encode(digest((v||jsonb_build_object('prizes',v_hash_prizes))::text,'sha256'),'hex'));
end $$;

create or replace function public._spin_attempt_receipt(p_attempt uuid,p_replayed boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.spin_attempts%rowtype; r public.spin_rewards%rowtype; b integer; f jsonb; next_hash text;
begin
 select * into a from public.spin_attempts where id=p_attempt;
 select spins_remaining,next_server_seed_hash into b,next_hash from public.fan_passes where id=a.fan_pass_id;
 select to_jsonb(ff) into f from public.fan_focus ff where ff.fan_id=a.fan_id and ff.status in('active','paused');
 select * into r from public.spin_rewards where spin_id=a.spin_id and erased_at is null;
 return a.result || jsonb_build_object('status','committed','replayed',p_replayed,'balance',b,'focus',f,'nextServerSeedHash',next_hash,
  'reward',case when r.spin_id is null then null else jsonb_build_object('kind',r.kind,'cipher',r.cipher,'iv',r.iv,'keyVersion',r.key_version) end);
end $$;

create or replace function public.get_spin_attempt_status(p_attempt uuid,p_token text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.spin_attempts%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt;
 if not found then
   if not exists(select 1 from public.fan_passes p join public.fans f on f.id=p.fan_id join public.profiles c on c.id=p.creator_id
     where p.token=p_token and p.is_active and p.self_excluded_at is null and f.blocked_at is null and f.creator_id=p.creator_id and c.is_active) then
     return jsonb_build_object('status','unavailable');
   end if;
   return jsonb_build_object('status','absent');
 end if;
 if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
 if not exists(select 1 from public.fan_passes p join public.fans f on f.id=p.fan_id join public.profiles c on c.id=p.creator_id
   where p.id=a.fan_pass_id and p.token=p_token and p.fan_id=a.fan_id and p.is_active and p.self_excluded_at is null and f.blocked_at is null and f.creator_id=p.creator_id and c.is_active) then
   return jsonb_build_object('status','unavailable');
 end if;
 if a.state='committed' then return public._spin_attempt_receipt(p_attempt,true); end if;
 if a.state='declined' then return jsonb_build_object('status','declined','error',a.error); end if;
 return jsonb_build_object('status','pending');
end $$;

create or replace function public.prepare_spin_attempt(p_attempt uuid,p_token text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
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

create or replace function public._canonical_proof_json(v jsonb)
returns text language plpgsql immutable set search_path=public as $$
declare answer text;
begin
 case jsonb_typeof(v)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public._canonical_proof_json(value),',' order by key),'')||'}' into answer from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(public._canonical_proof_json(value),',' order by ord),'')||']' into answer from jsonb_array_elements(v) with ordinality a(value,ord);
 else answer:=v::text;
 end case;
 return answer;
end $$;

-- Compare actual target odds against the HH baseline on the final pool.
-- Pity restrictions and stock exclusions can remove every benefit of a focus.
create or replace function public._focus_odds_increased(p_snapshot jsonb,p_excluded jsonb)
returns boolean language sql immutable set search_path=public as $$
 with remaining as (
  select x from jsonb_array_elements(p_snapshot->'prizes') x where not (p_excluded ? (x->>'id'))
 ), eligible as (
  select x from remaining where not (
   (p_snapshot#>>'{modifiers,pity,counter}')::int+1 >= (p_snapshot#>>'{modifiers,pity,threshold}')::int
   and exists(select 1 from remaining where x->>'rarity' in('rare','epic','legendary')))
   or x->>'rarity' in('rare','epic','legendary')
 ), tickets as (
  select x->>'id' id,(x->>'baseW')::numeric base,
   case when x->>'rarity' in('rare','epic','legendary') then coalesce((p_snapshot#>>'{modifiers,happyHour,multiplier}')::numeric,1) else 1 end factor
   from eligible
 ), weights as (
  select id,case when base=0 then 0 else greatest(1,floor(base*factor+0.5)) end before,
   case when base=0 then 0 else greatest(1,floor(base*case when id=p_snapshot#>>'{modifiers,focus,prizeId}' then least(5,factor*(p_snapshot#>>'{modifiers,focus,multiplier}')::numeric) else factor end+0.5)) end after from tickets
 ) select coalesce(sum(after) filter(where id=p_snapshot#>>'{modifiers,focus,prizeId}') * sum(before)
   > sum(before) filter(where id=p_snapshot#>>'{modifiers,focus,prizeId}') * sum(after),false) from weights;
$$;

create or replace function public.commit_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_context jsonb,p_spin jsonb,p_expected_reward jsonb,p_next_seed jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
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
 -- Stable lock ordering for every candidate and reservation target.
 perform 1 from public.prizes where wheel_id=public._resolved_spin_wheel(p.id) or id=r.prize_id order by id for update;
 current_context:=public._spin_attempt_context(p.id);
 if p_context->>'contextHash' is distinct from current_context->>'contextHash'
   or a.context->>'contextHash' is distinct from current_context->>'contextHash' then
   return jsonb_build_object('status','retry_context');
 end if;
 select * into s from jsonb_populate_record(null::public.spins,p_spin);
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
 if snapshot->>'game' is distinct from 'wheel' or snapshot->>'v' is distinct from '3'
   or exists(select 1 from jsonb_object_keys(snapshot) k where k not in('v','rules','game','prizes','modifiers'))
   or exists(select 1 from jsonb_object_keys(snapshot->'modifiers') k where k not in('happyHour','pity','focus','chase'))
   or s.fair_trace->>'won' is distinct from s.prize_id::text then raise exception 'invalid proof envelope' using errcode='22023'; end if;
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
 insert into public.spins(id,fan_pass_id,creator_id,wheel_id,fan_id,prize_id,prize_label,prize_rarity,prize_image_url,campaign_id,server_seed,server_seed_hash,nonce,client_seed,seed_commitment,fair_version,pool_snapshot,pool_hash,fair_trace)
 values(p_attempt,p.id,p.creator_id,s.wheel_id,f.id,pr.id,s.prize_label,s.prize_rarity,s.prize_image_url,p.campaign_id,s.server_seed,s.server_seed_hash,s.nonce,s.client_seed,s.seed_commitment,3,s.pool_snapshot,s.pool_hash,s.fair_trace) returning * into s;
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
   'originalNextServerSeedHash',p_next_seed->>'hash','pityAwarded',pity_due,'chaseAwarded',chase_due,'chaseCompleted',chase_complete,
   'focusConsumed',focus_consumed,'chaseConsumed',eligible,
   'prize',p_spin->'response_prize','prizeIndex',(p_spin->>'response_prize_index')::int,'showStock',(p_spin->>'response_show_stock')::boolean) where id=p_attempt;
 return public._spin_attempt_receipt(p_attempt,false);
end $$;

create or replace function public._grant_pass_spins_core(p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; g public.grants%rowtype; h text; b integer;
begin
 if p_request is null or p_spins<0 or p_bonus<0 or p_bonus>p_spins or p_amount<0 or p_spins>1000000 then raise exception 'invalid grant' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_spins,p_bonus,p_amount,p_campaign)::text,'sha256'),'hex');
 select * into f from public.fans where id=p_fan and creator_id=p_creator for update;
 select * into p from public.fan_passes where id=p_pass and fan_id=p_fan and creator_id=p_creator for update;
 if f.id is null or p.id is null or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 select * into g from public.grants where id=p_request;
 if found then
   if g.request_hash is distinct from h then return jsonb_build_object('status','conflict'); end if;
   return jsonb_build_object('status','granted','grantId',g.id,'balance',p.spins_remaining,'replayed',true);
 end if;
 if f.id is null or p.id is null or not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null or f.break_until>now()
   or exists(select 1 from public.fan_passes where fan_id=p_fan and self_excluded_at is not null)
   or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin'))
   or (p_campaign is not null and not exists(select 1 from public.campaigns where id=p_campaign and creator_id=p_creator)) then return jsonb_build_object('status','unavailable'); end if;

 perform set_config('fanfunnel.economic_write','on',true);
 insert into public.grants(id,creator_id,fan_id,fan_pass_id,campaign_id,spins,bonus_spins,amount_cents,request_hash)
 values(p_request,p_creator,p_fan,p_pass,p_campaign,p_spins,p_bonus,p_amount,h);
 update public.fan_passes set spins_remaining=spins_remaining+p_spins,spins_granted_total=spins_granted_total+p_spins where id=p_pass returning spins_remaining into b;
 return jsonb_build_object('status','granted','grantId',p_request,'balance',b,'replayed',false);
end $$;

create or replace function public.edit_pass_grant(p_creator uuid,p_grant uuid,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid default null,p_update_campaign boolean default false,p_update_spins boolean default true,p_update_amount boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare g public.grants%rowtype; p public.fan_passes%rowtype; d integer; b integer;
begin
 if p_spins<0 or p_bonus<0 or p_bonus>p_spins or p_amount<0 or p_spins>1000000 then raise exception 'invalid grant' using errcode='22023'; end if;
 select * into g from public.grants where id=p_grant and creator_id=p_creator;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=g.fan_id for update;
 perform 1 from public.fan_passes where fan_id=g.fan_id and creator_id=p_creator order by id for update;
 select * into p from public.fan_passes where fan_id=g.fan_id and creator_id=p_creator and is_active and self_excluded_at is null
   order by (id=g.fan_pass_id) desc nulls last,created_at,id limit 1;
 select * into g from public.grants where id=p_grant and creator_id=p_creator for update;
 if not p_update_spins then p_spins:=g.spins; p_bonus:=g.bonus_spins; end if;
 if not p_update_amount then p_amount:=g.amount_cents; end if;
 d:=p_spins-g.spins;
 if p.id is null and d<>0 then return jsonb_build_object('status','invalid','error','no_active_pass'); end if;
 if p_update_campaign and p_campaign is not null and not exists(select 1 from public.campaigns where id=p_campaign and creator_id=p_creator) then return jsonb_build_object('status','invalid','error','campaign_not_found'); end if;
 if g.id is null or (p.id is not null and (not p.is_active or p.self_excluded_at is not null))
   or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 -- Purchased focus terms/credits cannot be silently rewritten through ordinary grant editing.
 if p_spins<>g.spins and exists(select 1 from public.fan_focus where grant_id=p_grant) then return jsonb_build_object('status','invalid'); end if;
 d:=p_spins-g.spins;
 if d<>0 and p.spins_remaining+d<0 then return jsonb_build_object('status','invalid','error','insufficient_spins'); end if;
 if d>0 and exists(select 1 from public.fans where id=g.fan_id and (blocked_at is not null or break_until>now())) then return jsonb_build_object('status','unavailable'); end if;
 perform set_config('fanfunnel.economic_write','on',true);
 if d<>0 then update public.fan_passes set spins_remaining=spins_remaining+d,spins_granted_total=greatest(0,spins_granted_total+d) where id=p.id returning spins_remaining into b; else b:=p.spins_remaining; end if;
 update public.grants set spins=p_spins,bonus_spins=p_bonus,amount_cents=p_amount,campaign_id=case when p_update_campaign then p_campaign else campaign_id end where id=g.id;
 return jsonb_build_object('status','updated','balance',b);
end $$;

create or replace function public._grant_focus_pack_core(p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_pack uuid,p_prize uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; pack public.campaign_packs%rowtype; pr public.prizes%rowtype;
 ff public.fan_focus%rowtype; code public.prize_reward_codes%rowtype; g public.grants%rowtype; h text; b integer; n integer;
begin
 if p_request is null then raise exception 'invalid request' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_pack,p_prize)::text,'sha256'),'hex');
 select * into f from public.fans where id=p_fan and creator_id=p_creator for update;
 select * into p from public.fan_passes where id=p_pass and fan_id=p_fan and creator_id=p_creator for update;
 if f.id is null or p.id is null or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 select * into g from public.grants where id=p_request;
 if found then
   if g.request_hash is distinct from h then return jsonb_build_object('status','conflict'); end if;
   select * into ff from public.fan_focus where grant_id=g.id;
   return jsonb_build_object('status','granted','focus',to_jsonb(ff),'balance',p.spins_remaining,'grantId',g.id,'replayed',true);
 end if;
 if f.id is null or p.id is null or not p.is_active or p.self_excluded_at is not null or f.blocked_at is not null or f.break_until>now()
   or exists(select 1 from public.fan_passes where fan_id=p_fan and self_excluded_at is not null)
   or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;

 select * into pack from public.campaign_packs where id=p_pack and creator_id=p_creator for share;
 if pack.id is null or pack.pack_kind not in('focus','chase') or (pack.campaign_id is not null and pack.campaign_id is distinct from p.campaign_id)
   or exists(select 1 from public.focus_creator_config where creator_id=p_creator and not focus_enabled)
   or (pack.pack_kind='chase' and not exists(select 1 from public.focus_creator_config where creator_id=p_creator and focus_enabled and chase_enabled)) then return jsonb_build_object('status','invalid_pack'); end if;
 n:=case when pack.pack_kind='focus' then pack.focus_spins else pack.chase_within end;
 if pack.spins+pack.bonus_spins<n then return jsonb_build_object('status','invalid_pack'); end if;
 if exists(select 1 from public.fan_focus where fan_id=p_fan and status in('active','paused')) then return jsonb_build_object('status','focus_exists'); end if;
 select * into pr from public.prizes where id=p_prize for update;
 if pr.id is null or not pr.boostable or pr.wheel_id is distinct from public._resolved_spin_wheel(p_pass)
   or not exists(select 1 from public.wheels where id=pr.wheel_id and creator_id=p_creator and archived_at is null)
   or (pack.pack_kind='focus' and pr.weight=0) then return jsonb_build_object('status','invalid_target'); end if;
 if pr.stock is not null and pr.stock<=0 then return jsonb_build_object('status','sold_out'); end if;
 if pack.pack_kind='chase' and pr.delivery='codes' then
   select * into code from public.prize_reward_codes where prize_id=pr.id and spin_id is null and reserved_focus_id is null order by created_at,id limit 1 for update;
   if not found then return jsonb_build_object('status','sold_out'); end if;
 end if;
 perform set_config('fanfunnel.economic_write','on',true);
 insert into public.grants(id,creator_id,fan_id,fan_pass_id,campaign_id,spins,bonus_spins,amount_cents,request_hash)
 values(p_request,p_creator,p_fan,p_pass,pack.campaign_id,pack.spins+pack.bonus_spins,pack.bonus_spins,pack.amount_cents,h);
 insert into public.fan_focus(creator_id,fan_id,fan_pass_id,wheel_id,prize_id,prize_label,grant_id,kind,multiplier,total_spins,spins_left)
 values(p_creator,p_fan,p_pass,pr.wheel_id,pr.id,pr.label,p_request,pack.pack_kind,pack.focus_multiplier,n,n) returning * into ff;
 if pack.pack_kind='chase' then
   insert into public.chase_reservations(focus_id,creator_id,prize_id,kind,code_id)
   values(ff.id,p_creator,pr.id,case when pr.delivery='codes' then 'code' when pr.stock is null then 'unlimited' else 'stock' end,code.id);
   if pr.delivery='codes' then
     update public.prize_reward_codes set reserved_focus_id=ff.id where id=code.id;
     update public.prizes set stock=stock where id=pr.id;
   elsif pr.stock is not null then update public.prizes set stock=stock-1 where id=pr.id; end if;
 end if;
 update public.fan_passes set spins_remaining=spins_remaining+pack.spins+pack.bonus_spins,
   spins_granted_total=spins_granted_total+pack.spins+pack.bonus_spins where id=p.id returning spins_remaining into b;
 return jsonb_build_object('status','granted','focus',to_jsonb(ff),'balance',b,'grantId',p_request,'replayed',false);
end $$;

create or replace function public.cancel_fan_focus(p_creator uuid,p_fan uuid,p_focus uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f jsonb;
begin
 if p_focus is null then raise exception 'expected focus id required' using errcode='22023'; end if;
 if not exists(select 1 from public.fans where id=p_fan and creator_id=p_creator) then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 if p_focus is not null and not exists(select 1 from public.fan_focus where id=p_focus and fan_id=p_fan and creator_id=p_creator and status in('active','paused')) then
   return jsonb_build_object('status','absent','focus',null);
 end if;
 f:=public._release_fan_focus(p_fan);
 return jsonb_build_object('status',case when f is null then 'absent' else 'released' end,'focus',f);
end $$;
create or replace function public.get_fan_focus_state(p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_fan uuid; v_pass uuid; ff jsonb; c jsonb;
begin
 select p.fan_id,p.id into v_fan,v_pass from public.fan_passes p join public.fans f on f.id=p.fan_id join public.profiles c on c.id=p.creator_id
 where p.token=p_token and p.is_active and p.self_excluded_at is null and f.blocked_at is null and f.creator_id=p.creator_id and c.is_active and (c.approval_status='approved' or c.role='admin');
 if v_fan is null then return jsonb_build_object('status','unavailable'); end if;
 select to_jsonb(x) into ff from public.fan_focus x where fan_id=v_fan and status in('active','paused');
 c:=public._spin_attempt_context(v_pass);
 return jsonb_build_object('status','ok','focus',ff,'context',jsonb_build_object('wheel',c->'wheel','prizes',c->'prizes','pityCounter',c->'pityCounter','happyHourMultiplier',c->'happyHourMultiplier','reserved',nullif(c->'reservation','null'::jsonb) is not null,'breakUntil',(select break_until from public.fans where id=v_fan)));
end $$;

-- Token holders can initialize a commitment without spending. No general seed
-- update privilege is required by the fan page or by old application traffic.
create or replace function public.ensure_pass_commitment(p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; seed text;
begin
 select * into p from public.fan_passes where token=p_token;
 if p.id is null then return null; end if;
 perform 1 from public.fans where id=p.fan_id and creator_id=p.creator_id and blocked_at is null for update;
 if not found then return null; end if;
 select * into p from public.fan_passes where id=p.id and is_active and self_excluded_at is null for update;
 if not found or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then return null; end if;
 if p.next_server_seed is null or p.next_server_seed_hash is null then
   seed:=encode(gen_random_bytes(32),'hex');
   perform set_config('fanfunnel.economic_write','on',true);
   update public.fan_passes set next_server_seed=seed,next_server_seed_hash=encode(digest(seed,'sha256'),'hex') where id=p.id returning * into p;
 end if;
 return jsonb_build_object('hash',p.next_server_seed_hash);
end $$;

create or replace function public.guard_atomic_pass_economy()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.fans where id=new.fan_id and creator_id=new.creator_id)
   or not exists(select 1 from public.wheels where id=new.wheel_id and creator_id=new.creator_id)
   or (new.campaign_id is not null and not exists(select 1 from public.campaigns where id=new.campaign_id and creator_id=new.creator_id)) then
   raise exception 'pass references another creator' using errcode='42501';
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
drop trigger if exists trg_atomic_pass_economy on public.fan_passes;
create trigger trg_atomic_pass_economy before insert or update on public.fan_passes for each row execute function public.guard_atomic_pass_economy();

-- OLD callers now fail closed. There is deliberately no conditional legacy
-- path when a paid promise exists: every upgraded play uses the same ledger.
create or replace function public.claim_spin(p_token text)
returns integer language plpgsql security definer set search_path=public as $$
begin raise exception 'spin client upgrade required' using errcode='42501'; end $$;
revoke execute on function public.claim_spin(text) from public,anon,authenticated,service_role;
revoke execute on function public.finalize_reward_spin(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.reserve_reward_code(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.release_reward_code(uuid) from public,anon,authenticated,service_role;
revoke execute on function public.credit_pass_spins(uuid,integer) from public,anon,authenticated,service_role;

-- New external RPCs are server-only; private/trigger helpers have no API role.
revoke execute on function public._release_fan_focus(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._focus_lifecycle() from public,anon,authenticated,service_role;
revoke execute on function public._resolved_spin_wheel(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._spin_attempt_context(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._spin_attempt_receipt(uuid,boolean) from public,anon,authenticated,service_role;
revoke execute on function public._canonical_proof_json(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public._focus_odds_increased(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.guard_atomic_pass_economy() from public,anon,authenticated,service_role;
revoke execute on function public.prepare_spin_attempt(uuid,text,text) from public,anon,authenticated;
revoke execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke execute on function public.get_spin_attempt_status(uuid,text,text) from public,anon,authenticated;
revoke execute on function public._grant_focus_pack_core(uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.get_fan_focus_state(text) from public,anon,authenticated;
revoke execute on function public._grant_pass_spins_core(uuid,uuid,uuid,uuid,integer,integer,integer,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.edit_pass_grant(uuid,uuid,integer,integer,integer,uuid,boolean,boolean,boolean) from public,anon,authenticated,service_role;
revoke execute on function public.ensure_pass_commitment(text) from public,anon,authenticated;
grant execute on function public.prepare_spin_attempt(uuid,text,text) to service_role;
grant execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.get_spin_attempt_status(uuid,text,text) to service_role;
grant execute on function public.cancel_fan_focus(uuid,uuid,uuid) to service_role;
grant execute on function public.get_fan_focus_state(text) to service_role;
grant execute on function public.ensure_pass_commitment(text) to service_role;

create or replace function public.save_wheel_prizes(p_wheel uuid, p_creator uuid, p_prizes jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_order integer := 0;
begin
  perform 1 from public.wheels where id = p_wheel and creator_id = p_creator for update;
  if not found then raise exception 'wheel not found' using errcode = 'P0002'; end if;
  if p_prizes is null or jsonb_typeof(p_prizes) <> 'array' or jsonb_array_length(p_prizes) not between 2 and 50 then
    raise exception 'invalid prize count' using errcode = '22023';
  end if;
  perform 1 from public.prizes where wheel_id = p_wheel order by id for update;
  for v_row in select * from jsonb_array_elements(p_prizes) loop
    v_id := null;
    if (v_row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into v_id from public.prizes where id = (v_row->>'id')::uuid and wheel_id = p_wheel;
    end if;
    if v_id is null then v_id := gen_random_uuid(); end if;
    if v_id = any(v_ids) then raise exception 'duplicate prize id' using errcode = '22023'; end if;
    insert into public.prizes (id,wheel_id,label,description,rarity,weight,color,emoji,image_url,cost_cents,stock,sort_order,boostable)
    values(v_id,p_wheel,v_row->>'label',v_row->>'description',(v_row->>'rarity')::public.prize_rarity,
      (v_row->>'weight')::integer,v_row->>'color',v_row->>'emoji',v_row->>'image_url',
      (v_row->>'cost_cents')::integer,(v_row->>'stock')::integer,v_order,coalesce((v_row->>'boostable')::boolean,false))
    on conflict(id) do update set label=excluded.label,description=excluded.description,rarity=excluded.rarity,
      weight=excluded.weight,color=excluded.color,emoji=excluded.emoji,image_url=excluded.image_url,
      cost_cents=excluded.cost_cents,stock=excluded.stock,sort_order=excluded.sort_order,boostable=excluded.boostable;
    v_ids := array_append(v_ids,v_id);
    v_order := v_order + 1;
  end loop;
  delete from public.prizes where wheel_id=p_wheel and not(id=any(v_ids));
end;
$$;
revoke execute on function public.save_wheel_prizes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_wheel_prizes(uuid, uuid, jsonb) to service_role;


create or replace function public.guard_atomic_fan_economy()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if current_setting('fanfunnel.economic_write',true) is distinct from 'on' then
   if tg_op='INSERT' then
     if new.pity_counter<>0 or new.spins_remaining<>0 or new.spins_granted_total<>0 then raise exception 'use atomic grant RPC' using errcode='42501'; end if;
   elsif new.pity_counter is distinct from old.pity_counter
     or ((new.spins_remaining is distinct from old.spins_remaining or new.spins_granted_total is distinct from old.spins_granted_total) and pg_trigger_depth()<2) then
     raise exception 'use atomic economic RPC' using errcode='42501';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists trg_atomic_fan_economy on public.fans;
create trigger trg_atomic_fan_economy before insert or update on public.fans for each row execute function public.guard_atomic_fan_economy();
revoke execute on function public.guard_atomic_fan_economy() from public,anon,authenticated,service_role;
select set_config('fanfunnel.economic_write','',false);

-- Unrevealed seeds cannot be read through authenticated table SELECT *.
revoke select on public.fan_passes from authenticated;
grant select(id,token,creator_id,wheel_id,fan_id,is_active,created_at,last_spin_at,campaign_id,
 spins_remaining,spins_granted_total,self_excluded_at,next_server_seed_hash,next_spin_nonce) on public.fan_passes to authenticated;

create or replace function public.award_fan_referral(p_creator uuid,p_fan uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare me public.fans%rowtype; ref public.fans%rowtype; mine uuid; theirs uuid; referral public.referrals%rowtype;
begin
 select * into me from public.fans where id=p_fan and creator_id=p_creator;
 if me.id is null or me.referred_by_fan_id is null or me.referred_by_fan_id=me.id then return jsonb_build_object('status','unavailable'); end if;
 -- One lock order is shared by both directions of a referral relationship.
 perform 1 from public.fans where id in(me.id,me.referred_by_fan_id) order by id for update;
 select * into me from public.fans where id=p_fan and creator_id=p_creator;
 select * into ref from public.fans where id=me.referred_by_fan_id and creator_id=p_creator;
 if ref.id is null then return jsonb_build_object('status','unavailable'); end if;
 if me.referral_credited then return jsonb_build_object('status','already_credited'); end if;
 if not exists(select 1 from public.grants where fan_id=me.id and creator_id=p_creator and amount_cents>0) then return jsonb_build_object('status','pending'); end if;
 if me.blocked_at is not null or ref.blocked_at is not null or me.break_until>now() or ref.break_until>now()
   or exists(select 1 from public.fan_passes where fan_id in(me.id,ref.id) and self_excluded_at is not null)
   or not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','pending'); end if;
 if (select count(*) from public.referrals where referrer_fan_id=ref.id and credited_at is not null)>=3 then return jsonb_build_object('status','capped'); end if;
 perform 1 from public.fan_passes where fan_id in(me.id,ref.id) order by id for update;
 select id into mine from public.fan_passes where fan_id=me.id and creator_id=p_creator and is_active and self_excluded_at is null order by created_at,id limit 1;
 select id into theirs from public.fan_passes where fan_id=ref.id and creator_id=p_creator and is_active and self_excluded_at is null order by created_at,id limit 1;
 if mine is null or theirs is null then return jsonb_build_object('status','pending'); end if;
 select * into referral from public.referrals where referred_fan_id=me.id and referrer_fan_id=ref.id and creator_id=p_creator for update;
 if not found then return jsonb_build_object('status','unavailable'); end if;
 if referral.credited_at is not null then return jsonb_build_object('status','already_credited'); end if;
 perform set_config('fanfunnel.economic_write','on',true);
 update public.fan_passes set spins_remaining=spins_remaining+3,spins_granted_total=spins_granted_total+3 where id in(mine,theirs);
 update public.fans set referral_credited=true where id=me.id;
 update public.referrals set credited_at=now(),bonus_spins=3 where id=referral.id;
 return jsonb_build_object('status','credited');
end $$;
revoke execute on function public.award_fan_referral(uuid,uuid) from public,anon,authenticated;
grant execute on function public.award_fan_referral(uuid,uuid) to service_role;

-- A new fan/link and its ordinary paid grant share one retry identity. Nothing
-- is allocated before checking an existing grant; a lost response can safely
-- be retried with the same request UUID and normalized input.
create or replace function public._create_pass_grant_core(p_request uuid,p_creator uuid,p_fan uuid,p_wheel uuid,p_name text,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid,p_referral_code text default null,p_pack uuid default null,p_pack_units integer default 1)
returns jsonb language plpgsql security definer set search_path=public as $$
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
     where c.id=p_campaign and c.creator_id=p_creator and w.creator_id=p_creator and w.archived_at is null;
   if p_wheel is null then select id into p_wheel from public.wheels where creator_id=p_creator and archived_at is null and is_active order by created_at,id limit 1; end if;
   if p_wheel is null then select id into p_wheel from public.wheels where creator_id=p_creator and archived_at is null order by created_at,id limit 1; end if;
 end if;
 if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator and archived_at is null) then return jsonb_build_object('status','invalid','error','no_wheel'); end if;
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
revoke execute on function public._create_pass_grant_core(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer) from public,anon,authenticated,service_role;

-- No split manual insert can bypass the ledger. PostgreSQL fixture owners can
-- still exercise the historical0057 helper on explicitly authorized test data.
create or replace function public.guard_atomic_spin_insert()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if current_setting('fanfunnel.economic_write',true) is distinct from 'on' then
   raise exception 'use atomic attempt RPC' using errcode='42501';
 end if;
 return new;
end $$;
drop trigger if exists aa_atomic_spin_insert on public.spins;
create trigger aa_atomic_spin_insert before insert on public.spins for each row execute function public.guard_atomic_spin_insert();
revoke execute on function public.guard_atomic_spin_insert() from public,anon,authenticated,service_role;

-- A terminal tombstone also covers an absent attempt: a delayed original
-- request can no longer arrive later and debit after the UI reports decline.
create or replace function public.cancel_spin_attempt(p_attempt uuid,p_token text,p_request_hash text,p_error text default 'no_prizes')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.spin_attempts%rowtype; p public.fan_passes%rowtype;
begin
 if p_attempt is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
   or p_error not in('no_prizes','reward_unavailable','cancelled') then raise exception 'invalid terminal attempt' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_attempt::text,59));
 select * into a from public.spin_attempts where id=p_attempt for update;
 if a.id is not null then
   if a.token_hash<>encode(digest(p_token,'sha256'),'hex') or a.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   if a.state<>'pending' then return public.get_spin_attempt_status(p_attempt,p_token,p_request_hash); end if;
 end if;
 select * into p from public.fan_passes where token=p_token;
 if p.id is null then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=p.fan_id for update;
 select * into p from public.fan_passes where id=p.id and token=p_token for update;
 if not found or not p.is_active or p.self_excluded_at is not null or not exists(select 1 from public.fans where id=p.fan_id and blocked_at is null)
   or not exists(select 1 from public.profiles where id=p.creator_id and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 insert into public.spin_attempts(id,creator_id,fan_id,fan_pass_id,token_hash,request_hash,state,error,finished_at)
 values(p_attempt,p.creator_id,p.fan_id,p.id,encode(digest(p_token,'sha256'),'hex'),p_request_hash,'declined',p_error,now())
 on conflict(id) do update set state='declined',error=p_error,finished_at=now() where public.spin_attempts.state='pending';
 return jsonb_build_object('status','declined','error',p_error);
end $$;
revoke execute on function public.cancel_spin_attempt(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.cancel_spin_attempt(uuid,text,text,text) to service_role;

create or replace function public.import_fans(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid := auth.uid();
begin
  if v_creator is null then
    raise exception 'unauthorized';
  end if;

  if not public.current_user_active() then
    raise exception 'account is not active or approved' using errcode = '42501';
  end if;

  -- SECURITY DEFINER bypasses RLS, so verify the caller owns every referenced
  -- wheel and campaign before inserting anything that points at them.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where not exists (
      select 1 from public.wheels w
       where w.id = (r->>'wheel_id')::uuid and w.creator_id = v_creator
    )
  ) then
    raise exception 'wheel_not_owned';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (r->>'campaign_id') is not null
      and not exists (
        select 1 from public.campaigns c
         where c.id = (r->>'campaign_id')::uuid and c.creator_id = v_creator
      )
  ) then
    raise exception 'campaign_not_owned';
  end if;

  perform set_config('fanfunnel.economic_write','on',true);

  insert into public.fans (id, creator_id, display_name, spins_remaining, spins_granted_total)
  select (r->>'fan_id')::uuid, v_creator,
         coalesce(nullif(r->>'name', ''), 'Fan'),
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.fan_passes
         (id, token, creator_id, wheel_id, fan_id, campaign_id, spins_remaining, spins_granted_total)
  select (r->>'pass_id')::uuid, r->>'token', v_creator,
         (r->>'wheel_id')::uuid, (r->>'fan_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'spins')::int
    from jsonb_array_elements(p_rows) r;

  insert into public.grants
         (creator_id, fan_id, fan_pass_id, campaign_id, spins, amount_cents, bonus_spins)
  select v_creator, (r->>'fan_id')::uuid, (r->>'pass_id')::uuid, (r->>'campaign_id')::uuid,
         (r->>'spins')::int, (r->>'amount_cents')::int, 0
    from jsonb_array_elements(p_rows) r;
end;
$$;


-- CSV replay stores only request bindings, ordinals and accounting references.
-- Names and bearer tokens live only in the ordinary fan/pass business records.
create table if not exists public.fan_import_batches (
 id uuid primary key,
 creator_id uuid not null references public.profiles(id) on delete cascade,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now()
);
create table if not exists public.fan_import_items (
 batch_id uuid not null references public.fan_import_batches(id) on delete cascade,
 ordinal integer not null check(ordinal between 0 and 499),
 creator_id uuid not null references public.profiles(id) on delete cascade,
 grant_id uuid unique references public.grants(id) on delete set null,
 error text check(error is null or error in('missing_name','invalid_spins','spins_too_large','invalid_amount','amount_too_large','no_wheel','campaign_not_found','invalid_pack','blocked','on_break','gone')),
 created_at timestamptz not null default now(),
 primary key(batch_id,ordinal)
);
alter table public.fan_import_batches enable row level security;
alter table public.fan_import_items enable row level security;
drop policy if exists fan_import_batches_select on public.fan_import_batches;
create policy fan_import_batches_select on public.fan_import_batches for select to authenticated
 using(public.can_act_for(creator_id,'view') or public.is_admin());
drop policy if exists fan_import_items_select on public.fan_import_items;
create policy fan_import_items_select on public.fan_import_items for select to authenticated
 using(public.can_act_for(creator_id,'view') or public.is_admin());
revoke all on public.fan_import_batches,public.fan_import_items from public,anon,authenticated;
grant select(id,creator_id,created_at) on public.fan_import_batches to authenticated;
grant select on public.fan_import_items to authenticated;
grant all on public.fan_import_batches,public.fan_import_items to service_role;

create or replace function public._fan_import_result(p_batch uuid,p_replayed boolean)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('status','imported','batchId',p_batch,'replayed',p_replayed,'items',coalesce(jsonb_agg(
  case when i.error is not null then jsonb_build_object('ordinal',i.ordinal,'error',i.error)
   when p.id is null or f.id is null then jsonb_build_object('ordinal',i.ordinal,'error','gone')
   else jsonb_build_object('ordinal',i.ordinal,'fanId',f.id,'passId',p.id,'grantId',g.id,'token',p.token) end order by i.ordinal),'[]'::jsonb))
 from public.fan_import_items i
 left join public.grants g on g.id=i.grant_id and g.creator_id=i.creator_id
 left join public.fan_passes p on p.id=g.fan_pass_id and p.creator_id=i.creator_id
 left join public.fans f on f.id=p.fan_id and f.creator_id=i.creator_id
 where i.batch_id=p_batch;
$$;
revoke execute on function public._fan_import_result(uuid,boolean) from public,anon,authenticated,service_role;

create or replace function public._import_fans_durable_core(p_batch uuid,p_creator uuid,p_request_hash text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.fan_import_batches%rowtype; row_input jsonb; n integer; error_code text; outcome jsonb;
 row_name text; row_spins numeric; row_amount numeric; row_campaign uuid; row_wheel uuid; request_id uuid;
begin
 if p_batch is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 500
   or p_request_hash is distinct from encode(digest(public._canonical_proof_json(jsonb_build_array('fan-import-v1',p_rows)),'sha256'),'hex') then
   raise exception 'invalid import intent' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_batch::text,59));
 if not exists(select 1 from public.profiles where id=p_creator and is_active and (approval_status='approved' or role='admin')) then return jsonb_build_object('status','unavailable'); end if;
 select * into b from public.fan_import_batches where id=p_batch;
 if found then
   if b.creator_id<>p_creator or b.request_hash<>p_request_hash then return jsonb_build_object('status','conflict'); end if;
   return public._fan_import_result(p_batch,true);
 end if;
 insert into public.fan_import_batches(id,creator_id,request_hash) values(p_batch,p_creator,p_request_hash);
 for row_input,n in select value,(ordinality-1)::int from jsonb_array_elements(p_rows) with ordinality loop
   error_code:=nullif(row_input->>'error','');
   row_name:=left(btrim(coalesce(row_input->>'name','')),80);
   row_campaign:=null;row_wheel:=null;
   if error_code is not null and error_code not in('missing_name','invalid_spins','spins_too_large','invalid_amount','amount_too_large') then raise exception 'invalid import row error' using errcode='22023'; end if;
   if error_code is null then
     if row_name='' then error_code:='missing_name';
     elsif jsonb_typeof(row_input->'spins') is distinct from 'number' then error_code:='invalid_spins';
     else
       row_spins:=(row_input->>'spins')::numeric;
       if row_spins<>trunc(row_spins) or row_spins<0 then error_code:='invalid_spins'; elsif row_spins>1000000 then error_code:='spins_too_large'; end if;
     end if;
   end if;
   if error_code is null then
     if jsonb_typeof(row_input->'amountCents') is distinct from 'number' then error_code:='invalid_amount';
     else
       row_amount:=(row_input->>'amountCents')::numeric;
       if row_amount<>trunc(row_amount) or row_amount<0 then error_code:='invalid_amount'; elsif row_amount>100000000 then error_code:='amount_too_large'; end if;
     end if;
   end if;
   if error_code is null then
     -- Preserve the import contract: an unknown/non-owned campaign is ignored,
     -- so its row uses the creator's default wheel without a foreign reference.
     if row_input->>'campaignId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
       select id into row_campaign from public.campaigns where id=(row_input->>'campaignId')::uuid and creator_id=p_creator;
     end if;
     if nullif(row_input->>'wheelId','') is not null then
       if row_input->>'wheelId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then row_wheel:=(row_input->>'wheelId')::uuid; else error_code:='no_wheel'; end if;
     end if;
     if error_code is null then
       request_id:=gen_random_uuid();
       outcome:=public._create_pass_grant_core(request_id,p_creator,null,row_wheel,row_name,row_spins::int,0,row_amount::int,row_campaign,null,null,1);
       if outcome->>'status'='granted' then
         insert into public.fan_import_items(batch_id,ordinal,creator_id,grant_id) values(p_batch,n,p_creator,request_id);
       elsif outcome->>'status'='invalid' then
         error_code:=outcome->>'error';
         if error_code is null or error_code not in('no_wheel','campaign_not_found','invalid_pack','blocked','on_break') then raise exception 'import row refused' using errcode='22023'; end if;
       elsif outcome->>'status'='unavailable' then raise exception 'creator is not active or approved' using errcode='42501';
       else raise exception 'import transaction failed' using errcode='22023'; end if;
     end if;
   end if;
   if error_code is not null then insert into public.fan_import_items(batch_id,ordinal,creator_id,error) values(p_batch,n,p_creator,error_code); end if;
 end loop;
 return public._fan_import_result(p_batch,false);
end $$;
revoke execute on function public._import_fans_durable_core(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

-- Independent request receipts survive fan/grant erasure. Only metadata,
-- canonical hashes and accounting references are retained here, never names,
-- bearer tokens, CSV rows, ciphertext or future seeds.
create table if not exists public.creator_request_journal (
 id uuid not null,
 creator_id uuid not null references public.profiles(id) on delete cascade,
 actor_id uuid references public.profiles(id) on delete set null,
 kind text not null check(kind in('pass','grant','focus','import','edit')),
 request_hash text check(request_hash is null or request_hash ~ '^[a-f0-9]{64}$'),
 state text not null check(state in('pending','committed','rejected','cancelled','gone')),
 error text check(error is null or length(error)<=80),
 grant_id uuid references public.grants(id) on delete set null,
 batch_id uuid references public.fan_import_batches(id) on delete set null,
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 primary key(creator_id,id),
 check(request_hash is not null or state='cancelled'),
 check((state='pending' and finished_at is null) or (state<>'pending' and finished_at is not null))
);
create unique index if not exists creator_request_actor_id_idx on public.creator_request_journal(actor_id,id) where actor_id is not null;
create table if not exists public.actor_request_cancellations (
 actor_id uuid not null references public.profiles(id) on delete cascade,
 id uuid not null,
 kind text not null check(kind in('pass','grant','focus','import','edit')),
 created_at timestamptz not null default now(),
 primary key(actor_id,id)
);
alter table public.actor_request_cancellations enable row level security;
drop policy if exists actor_request_cancellations_select on public.actor_request_cancellations;
create policy actor_request_cancellations_select on public.actor_request_cancellations for select to authenticated
 using(actor_id=auth.uid() or public.is_admin());
revoke all on public.actor_request_cancellations from public,anon,authenticated;
grant select on public.actor_request_cancellations to authenticated;
grant all on public.actor_request_cancellations to service_role;

alter table public.creator_request_journal enable row level security;
drop policy if exists creator_request_journal_select on public.creator_request_journal;
create policy creator_request_journal_select on public.creator_request_journal for select to authenticated
 using(actor_id=auth.uid() or public.can_act_for(creator_id,'view') or public.is_admin());
revoke all on public.creator_request_journal from public,anon,authenticated;
grant select(id,creator_id,actor_id,kind,state,error,created_at,finished_at) on public.creator_request_journal to authenticated;
grant all on public.creator_request_journal to service_role;

-- Reuse the binding auth contract, including active/approved profiles and the
-- existing agency grant matrix. The actor is supplied only by a server route
-- after getUser(); this helper has no external EXECUTE grant.
create or replace function public._creator_actor_grant_allowed(p_actor uuid,p_creator uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare original_sub text:=current_setting('request.jwt.claim.sub',true); allowed boolean;
begin
 if p_actor is null then return false; end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 allowed:=public.can_act_for(p_creator,'grant');
 perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
 return coalesce(allowed,false);
exception when others then
 perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
 raise;
end $$;
revoke execute on function public._creator_actor_grant_allowed(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public._creator_request_receipt(p_request uuid,p_creator uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.creator_request_journal%rowtype; g public.grants%rowtype; p public.fan_passes%rowtype; f public.fan_focus%rowtype;
begin
 select * into j from public.creator_request_journal where id=p_request and creator_id=p_creator;
 if j.kind='import' then
   if not exists(select 1 from public.fan_import_batches where id=j.batch_id and creator_id=j.creator_id) then return jsonb_build_object('status','gone','error','gone'); end if;
   return public._fan_import_result(j.batch_id,true);
 end if;
 select * into g from public.grants where id=j.grant_id and creator_id=j.creator_id;
 if j.kind='edit' then
   if g.id is null or not exists(select 1 from public.fans where id=g.fan_id and creator_id=j.creator_id) then return jsonb_build_object('status','gone','error','gone'); end if;
   select * into p from public.fan_passes where fan_id=g.fan_id and creator_id=j.creator_id and is_active and self_excluded_at is null
     order by (id=g.fan_pass_id) desc nulls last,created_at,id limit 1;
   return jsonb_build_object('status','updated','grantId',g.id,'balance',p.spins_remaining,'replayed',true,
     'grant',jsonb_build_object('id',g.id,'spins',g.spins,'bonusSpins',g.bonus_spins,'amountCents',g.amount_cents,'campaignId',g.campaign_id));
 end if;
 select * into p from public.fan_passes where id=g.fan_pass_id and creator_id=j.creator_id;
 if g.id is null or p.id is null or not exists(select 1 from public.fans where id=p.fan_id and creator_id=j.creator_id) then return jsonb_build_object('status','gone','error','gone'); end if;
 if j.kind='focus' then
   select * into f from public.fan_focus where grant_id=g.id and creator_id=j.creator_id;
   if f.id is null then return jsonb_build_object('status','gone','error','gone'); end if;
   return jsonb_build_object('status','granted','focus',to_jsonb(f),'grantId',g.id,'balance',p.spins_remaining,'replayed',true);
 end if;
 return jsonb_build_object('status','granted','grantId',g.id,'fanId',p.fan_id,'passId',p.id,'token',p.token,'balance',p.spins_remaining,'replayed',true);
end $$;
revoke execute on function public._creator_request_receipt(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public._creator_request_open(p_request uuid,p_creator uuid,p_actor uuid,p_kind text,p_hash text,p_allowed boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.creator_request_journal%rowtype; receipt jsonb;
begin
 if p_request is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid creator intent' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 if exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request) then
   if exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request and kind=p_kind) then return jsonb_build_object('status','cancelled','error','cancelled'); end if;
   return jsonb_build_object('status','conflict');
 end if;
 select * into j from public.creator_request_journal where id=p_request and actor_id=p_actor for update;
 if found and j.creator_id<>p_creator then return jsonb_build_object('status','conflict'); end if;
 select * into j from public.creator_request_journal where id=p_request and creator_id=p_creator for update;
 if found then
   if j.creator_id<>p_creator or j.actor_id is distinct from p_actor or j.kind<>p_kind or (j.request_hash is not null and j.request_hash<>p_hash) then return jsonb_build_object('status','conflict'); end if;
   if j.state in('cancelled','rejected','gone') then return jsonb_build_object('status',j.state,'error',coalesce(j.error,j.state)); end if;
   if j.state='committed' then
     if not p_allowed then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
     receipt:=public._creator_request_receipt(p_request,p_creator);
     if receipt->>'status'='gone' then update public.creator_request_journal set state='gone',error='gone' where id=p_request and creator_id=p_creator; end if;
     return receipt;
   end if;
 else
   insert into public.creator_request_journal(id,creator_id,actor_id,kind,request_hash,state)
   values(p_request,p_creator,p_actor,p_kind,p_hash,'pending');
 end if;
 return null;
end $$;
revoke execute on function public._creator_request_open(uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated,service_role;

create or replace function public._creator_request_finish(p_request uuid,p_creator uuid,p_outcome jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if p_outcome->>'status' in('granted','imported','updated') then
   update public.creator_request_journal set state='committed',grant_id=(p_outcome->>'grantId')::uuid,
     batch_id=(p_outcome->>'batchId')::uuid,finished_at=now() where id=p_request and creator_id=p_creator;
 else
   update public.creator_request_journal set state=case when p_outcome->>'status'='gone' then 'gone' else 'rejected' end,
     error=left(coalesce(p_outcome->>'error',p_outcome->>'status','unavailable'),80),finished_at=now() where id=p_request and creator_id=p_creator;
 end if;
 return p_outcome;
end $$;
revoke execute on function public._creator_request_finish(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- Deleting the business row changes the durable receipt rather than erasing
-- its key. A later stale create request can never recreate an erased fan.
create or replace function public._creator_request_grant_erased()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.creator_request_journal set state='gone',error='gone',grant_id=null,finished_at=coalesce(finished_at,now())
   where grant_id=old.id;
 return old;
end $$;
drop trigger if exists aa_creator_request_grant_erased on public.grants;
create trigger aa_creator_request_grant_erased before delete on public.grants for each row execute function public._creator_request_grant_erased();
revoke execute on function public._creator_request_grant_erased() from public,anon,authenticated,service_role;

create or replace function public.reconcile_creator_request(p_request uuid,p_creator uuid,p_actor uuid,p_kind text,p_cancel boolean default false,p_authorized boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.creator_request_journal%rowtype; allowed boolean:=false; receipt jsonb; identity jsonb; fenced_actor uuid;
begin
 identity:=jsonb_build_object('requestId',p_request,'kind',p_kind);
 if p_request is null or p_actor is null or p_kind not in('pass','grant','focus','import','edit')
   or not exists(select 1 from public.profiles where id=p_actor) then return identity||jsonb_build_object('status','unavailable'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,59));
 -- Actor+UUID discovers an already accepted operation before any absent-key
 -- cancellation, even if its original creator target was omitted or changed.
 select * into j from public.creator_request_journal where id=p_request and actor_id=p_actor for update;
 if not found and p_creator is not null then
   select * into j from public.creator_request_journal where id=p_request and creator_id=p_creator for update;
 end if;
 if j.id is null then
   if exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request) then
     return identity||jsonb_build_object('status',case when exists(select 1 from public.actor_request_cancellations where actor_id=p_actor and id=p_request and kind=p_kind) then 'cancelled' else 'conflict' end,'authorized',false);
   end if;
   if p_cancel then
     insert into public.actor_request_cancellations(actor_id,id,kind) values(p_actor,p_request,p_kind);
     return identity||jsonb_build_object('status','cancelled','authorized',false);
   end if;
   return identity||jsonb_build_object('status','absent','authorized',false);
 end if;
 if j.kind<>p_kind then return identity||jsonb_build_object('status','conflict','authorized',false); end if;
 allowed:=p_authorized and public._creator_actor_grant_allowed(p_actor,j.creator_id);
 if not allowed and j.actor_id is distinct from p_actor and j.creator_id<>p_actor then return identity||jsonb_build_object('status','unavailable','authorized',false); end if;
 if j.state='committed' then
   receipt:=public._creator_request_receipt(p_request,j.creator_id);
   if receipt->>'status'='gone' then
     update public.creator_request_journal set state='gone',error='gone' where id=p_request and creator_id=j.creator_id;
     return identity||jsonb_build_object('status','gone','authorized',allowed);
   end if;
   if allowed then return identity||jsonb_build_object('status','committed','authorized',true,'receipt',receipt); end if;
   return identity||jsonb_build_object('status','committed','authorized',false);
 end if;
 if j.state='pending' and p_cancel then
   update public.creator_request_journal set state='cancelled',error='cancelled',finished_at=now() where id=p_request and creator_id=j.creator_id;
   fenced_actor:=coalesce(j.actor_id,p_actor);
   insert into public.actor_request_cancellations(actor_id,id,kind) values(fenced_actor,p_request,p_kind) on conflict(actor_id,id) do nothing;
   return identity||jsonb_build_object('status','cancelled','authorized',allowed);
 end if;
 return identity||jsonb_build_object('status',j.state,'authorized',allowed);
end $$;
revoke execute on function public.reconcile_creator_request(uuid,uuid,uuid,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_creator_request(uuid,uuid,uuid,text,boolean,boolean) to service_role;

create or replace function public.grant_pass_spins(p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid default null,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_spins,p_bonus,p_amount,p_campaign)::text,'sha256'),'hex');
 allowed:=public._creator_actor_grant_allowed(actor,p_creator);
 prior:=public._creator_request_open(p_request,p_creator,actor,'grant',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._grant_pass_spins_core(p_request,p_creator,p_fan,p_pass,p_spins,p_bonus,p_amount,p_campaign);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.grant_pass_spins(uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.grant_pass_spins(uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid) to service_role;

create or replace function public.grant_focus_pack(p_request uuid,p_creator uuid,p_fan uuid,p_pass uuid,p_pack uuid,p_prize uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 h:=encode(digest(jsonb_build_array(p_creator,p_fan,p_pass,p_pack,p_prize)::text,'sha256'),'hex');
 allowed:=public._creator_actor_grant_allowed(actor,p_creator);
 prior:=public._creator_request_open(p_request,p_creator,actor,'focus',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._grant_focus_pack_core(p_request,p_creator,p_fan,p_pass,p_pack,p_prize);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.create_pass_grant(p_request uuid,p_creator uuid,p_fan uuid,p_wheel uuid,p_name text,p_spins integer,p_bonus integer,p_amount integer,p_campaign uuid,p_referral_code text default null,p_pack uuid default null,p_pack_units integer default 1,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=coalesce(p_actor,p_creator); h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 h:=encode(digest(jsonb_build_array('create-pass-v1',p_creator,p_fan,p_wheel,p_name,case when p_pack is null then p_spins else null end,case when p_pack is null then p_bonus else null end,case when p_pack is null then p_amount else null end,p_campaign,p_referral_code,p_pack,p_pack_units)::text,'sha256'),'hex');
 allowed:=public._creator_actor_grant_allowed(actor,p_creator);
 prior:=public._creator_request_open(p_request,p_creator,actor,'pass',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._create_pass_grant_core(p_request,p_creator,p_fan,p_wheel,p_name,p_spins,p_bonus,p_amount,p_campaign,p_referral_code,p_pack,p_pack_units);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.create_pass_grant(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.create_pass_grant(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid) to service_role;

create or replace function public.import_fans_durable(p_batch uuid,p_creator uuid,p_request_hash text,p_rows jsonb,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=coalesce(p_actor,p_creator); allowed boolean; prior jsonb; outcome jsonb;
begin
 if p_request_hash is distinct from encode(digest(public._canonical_proof_json(jsonb_build_array('fan-import-v1',p_rows)),'sha256'),'hex') then raise exception 'invalid import binding' using errcode='22023'; end if;
 allowed:=public._creator_actor_grant_allowed(actor,p_creator);
 prior:=public._creator_request_open(p_batch,p_creator,actor,'import',p_request_hash,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._import_fans_durable_core(p_batch,p_creator,p_request_hash,p_rows);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_batch,p_creator,outcome);
end $$;
revoke execute on function public.import_fans_durable(uuid,uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.import_fans_durable(uuid,uuid,text,jsonb,uuid) to service_role;

-- The legacy authenticated import bypasses request hashes, journal receipts
-- and actor cancellation fences. It remains an owner-only implementation
-- detail; every application import must enter through import_fans_durable.
revoke execute on function public.import_fans(jsonb) from public,anon,authenticated,service_role;


-- Present-only raw patches are bound before mutable grant reads. The private
-- patch core then follows fan -> sorted passes -> grant locks and derives all
-- omitted fields/bonus metadata from that locked current row.
create or replace function public._edit_grant_patch_core(p_creator uuid,p_grant uuid,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare g public.grants%rowtype; v_spins integer; v_bonus integer; v_amount integer; v_campaign uuid; n numeric; outcome jsonb;
begin
 if jsonb_typeof(p_patch) is distinct from 'object'
   or exists(select 1 from jsonb_object_keys(p_patch) k where k not in('spins','amountCents','campaignId')) then return jsonb_build_object('status','invalid','error','invalid'); end if;
 select * into g from public.grants where id=p_grant and creator_id=p_creator;
 if not found then return jsonb_build_object('status','unavailable','error','not_found'); end if;
 perform 1 from public.fans where id=g.fan_id and creator_id=p_creator for update;
 if not found then return jsonb_build_object('status','gone','error','gone'); end if;
 perform 1 from public.fan_passes where fan_id=g.fan_id and creator_id=p_creator order by id for update;
 select * into g from public.grants where id=p_grant and creator_id=p_creator for update;
 if not found then return jsonb_build_object('status','gone','error','gone'); end if;
 v_spins:=g.spins;v_bonus:=g.bonus_spins;v_amount:=g.amount_cents;v_campaign:=g.campaign_id;
 if p_patch ? 'spins' then
   if jsonb_typeof(p_patch->'spins') is distinct from 'number' then return jsonb_build_object('status','invalid','error','invalid'); end if;
   n:=(p_patch->>'spins')::numeric;
   if n<>trunc(n) or n<0 or n>1000000 then return jsonb_build_object('status','invalid','error','invalid'); end if;
   v_spins:=n::integer;v_bonus:=least(g.bonus_spins,v_spins);
 end if;
 if p_patch ? 'amountCents' then
   if jsonb_typeof(p_patch->'amountCents') is distinct from 'number' then return jsonb_build_object('status','invalid','error','invalid'); end if;
   n:=(p_patch->>'amountCents')::numeric;
   if n<>trunc(n) or n<0 or n>100000000 then return jsonb_build_object('status','invalid','error','invalid'); end if;
   v_amount:=n::integer;
 end if;
 if p_patch ? 'campaignId' then
   if p_patch->'campaignId'='null'::jsonb then v_campaign:=null;
   elsif jsonb_typeof(p_patch->'campaignId')='string' and p_patch->>'campaignId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then v_campaign:=(p_patch->>'campaignId')::uuid;
   else return jsonb_build_object('status','invalid','error','campaign_not_found'); end if;
 end if;
 outcome:=public.edit_pass_grant(p_creator,p_grant,v_spins,v_bonus,v_amount,v_campaign,p_patch ? 'campaignId',p_patch ? 'spins',p_patch ? 'amountCents');
 if outcome->>'status'='updated' then
   select * into g from public.grants where id=p_grant and creator_id=p_creator;
   return outcome||jsonb_build_object('grantId',g.id,'replayed',false,
     'grant',jsonb_build_object('id',g.id,'spins',g.spins,'bonusSpins',g.bonus_spins,'amountCents',g.amount_cents,'campaignId',g.campaign_id));
 end if;
 return outcome;
end $$;
revoke execute on function public._edit_grant_patch_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function public.edit_pass_grant(p_request uuid,p_creator uuid,p_grant uuid,p_patch jsonb,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare h text; allowed boolean; prior jsonb; outcome jsonb;
begin
 -- There is no creator fallback for this new public edit contract. The server
 -- route must bind the actual getUser() actor to its captured request UUID.
 if p_actor is null or not exists(select 1 from public.profiles where id=p_actor) then return jsonb_build_object('status','unavailable','error','forbidden'); end if;
 h:=encode(digest(public._canonical_proof_json(jsonb_build_array('edit-grant-v1',p_creator,p_grant,p_patch)),'sha256'),'hex');
 allowed:=public._creator_actor_grant_allowed(p_actor,p_creator);
 prior:=public._creator_request_open(p_request,p_creator,p_actor,'edit',h,allowed);
 if prior is not null then return prior; end if;
 if allowed then outcome:=public._edit_grant_patch_core(p_creator,p_grant,p_patch);
 else outcome:=jsonb_build_object('status','unavailable','error','forbidden'); end if;
 return public._creator_request_finish(p_request,p_creator,outcome);
end $$;
revoke execute on function public.edit_pass_grant(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.edit_pass_grant(uuid,uuid,uuid,jsonb,uuid) to service_role;


-- A route can be in flight when agency permission is revoked. The public
-- service gateway must recheck the actual actor after taking the fan lock,
-- before the exact expected-focus compare-and-set releases any paid stock.
revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.cancel_fan_focus(p_creator uuid,p_fan uuid,p_focus uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if p_focus is null then raise exception 'expected focus id required' using errcode='22023'; end if;
 if p_actor is null then return jsonb_build_object('status','unavailable'); end if;
 perform 1 from public.fans where id=p_fan and creator_id=p_creator for update;
 if not found or not public._creator_actor_grant_allowed(p_actor,p_creator) then return jsonb_build_object('status','unavailable'); end if;
 return public.cancel_fan_focus(p_creator,p_fan,p_focus);
end $$;
revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_fan_focus(uuid,uuid,uuid,uuid) to service_role;

-- Reward creation is not a value disclosure. The server decrypts and validates
-- the complete winner response, records all disclosed reward IDs atomically,
-- then releases plaintext only after this token-bound log succeeds.
alter table public.spin_rewards alter column views set default 0;
alter table public.spin_rewards alter column last_viewed_at drop not null;
alter table public.spin_rewards alter column last_viewed_at set default null;
create or replace function public.record_fan_reward_views(p_spins uuid[],p_token text)
returns integer language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; expected integer; found_count integer;
begin
 expected:=cardinality(p_spins);
 if expected is null or expected<1 or expected>5 or(array_position(p_spins,null) is not null)
  or(select count(distinct x) from unnest(p_spins) x)<>expected then return 0;end if;
 select * into p from public.fan_passes where token=p_token;
 if not found then return 0;end if;
 -- The same fan-first order as erasure and attempt commits prevents logging
 -- cleared values or deadlocking a multi-reward disclosure against deletion.
 perform 1 from public.fans where id=p.fan_id for update;
 if not found then return 0;end if;
 select fp.* into p from public.fan_passes fp join public.fans f on f.id=fp.fan_id join public.profiles c on c.id=fp.creator_id
 where fp.token=p_token and fp.is_active and fp.self_excluded_at is null and f.creator_id=fp.creator_id and f.blocked_at is null
 and c.is_active and(c.approval_status='approved' or c.role='admin');
 if not found then return 0;end if;
 -- Breaks restrict purchases/plays, never the safe reopening of existing wins.
 perform 1 from public.spin_rewards r join public.spins s on s.id=r.spin_id
 where r.spin_id=any(p_spins) and r.erased_at is null and s.fan_id=p.fan_id and s.creator_id=p.creator_id and r.creator_id=p.creator_id order by r.spin_id for update of r;
 get diagnostics found_count=row_count;
 if found_count<>expected then return 0;end if;
 update public.spin_rewards set views=views+1,last_viewed_at=now() where spin_id=any(p_spins);
 get diagnostics found_count=row_count;
 return found_count;
end $$;
revoke execute on function public.record_fan_reward_views(uuid[],text) from public,anon,authenticated;
grant execute on function public.record_fan_reward_views(uuid[],text) to service_role;
