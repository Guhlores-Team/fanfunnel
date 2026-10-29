--0061: personal Bingo, one paid attempt, ordered bonus receipts and card CAS.
alter table public.spins add column if not exists kind text not null default 'play';
alter table public.spins add column if not exists parent_spin_id uuid references public.spins(id) on delete cascade;
alter table public.spins add column if not exists bingo_line smallint;
alter table public.spins drop constraint if exists spins_kind_parent_check;
alter table public.spins add constraint spins_kind_parent_check check(
 (kind='play' and parent_spin_id is null and bingo_line is null) or
 (kind='bonus' and parent_spin_id is not null and parent_spin_id<>id and bingo_line between 0 and 7 and game_kind='bingo'));
create index if not exists spins_parent_spin_idx on public.spins(parent_spin_id) where parent_spin_id is not null;

create or replace function public._bingo_completed_lines(p_mask integer)
returns integer language sql immutable strict set search_path=public as $$
 select coalesce(sum(1<<i)::integer,0) from unnest(array[7,56,448,73,146,292,273,84]) with ordinality x(m,n)
 cross join lateral(select n::integer-1 i) z where (p_mask&m)=m;
$$;
revoke execute on function public._bingo_completed_lines(integer) from public,anon,authenticated,service_role;

create or replace function public._bingo_cells_valid(p_cells jsonb)
returns boolean language plpgsql immutable set search_path=public as $$
declare c jsonb; ids text[]:=array[]::text[];
begin
 if jsonb_typeof(p_cells) is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_cells)<>9 then return false; end if;
 for c in select value from jsonb_array_elements(p_cells) loop
  if jsonb_typeof(c) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(c))<>4 or exists(select 1 from jsonb_object_keys(c) k where k not in('id','label','emoji','rarity'))
   or jsonb_typeof(c->'id') is distinct from 'string' or c->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   or jsonb_typeof(c->'label') is distinct from 'string' or length(c->>'label')>1000
   or not(c ? 'emoji') or (jsonb_typeof(c->'emoji') not in('null','string'))
   or jsonb_typeof(c->'rarity') is distinct from 'string' or c->>'rarity' not in('common','uncommon','rare','epic','legendary') or not(c ? 'rarity') or c->>'id'=any(ids) then return false; end if;
  ids:=array_append(ids,c->>'id');
 end loop;
 return true;
end $$;
revoke execute on function public._bingo_cells_valid(jsonb) from public,anon,authenticated,service_role;

create table if not exists public.bingo_cards(
 id uuid primary key default gen_random_uuid(),
 creator_id uuid not null references public.profiles(id) on delete cascade,
 fan_id uuid not null references public.fans(id) on delete cascade,
 wheel_id uuid not null references public.wheels(id) on delete cascade,
 cells jsonb not null check(public._bingo_cells_valid(cells)),
 marked_mask integer not null default 0 check(marked_mask between 0 and 511),
 awarded_lines_mask integer not null default 0 check(awarded_lines_mask between 0 and 255 and awarded_lines_mask=public._bingo_completed_lines(marked_mask)),
 version bigint not null default 0 check(version between 0 and 9007199254740991 and version>=bit_count(marked_mask::bit(9))),
 status text not null default 'active' check(status in('active','complete')),
 created_at timestamptz not null default now(),completed_at timestamptz,
 check((status='complete' and marked_mask=511 and completed_at is not null) or(status='active' and marked_mask<>511 and completed_at is null))
);
create unique index if not exists bingo_cards_one_active_idx on public.bingo_cards(fan_id,wheel_id) where status='active';
create index if not exists bingo_cards_current_idx on public.bingo_cards(fan_id,wheel_id,created_at desc,id);
create table if not exists public.bingo_line_awards(
 card_id uuid not null references public.bingo_cards(id) on delete cascade,
 line_index smallint not null check(line_index between 0 and 7),
 creator_id uuid not null references public.profiles(id) on delete cascade,
 fan_id uuid not null references public.fans(id) on delete cascade,
 wheel_id uuid not null references public.wheels(id) on delete cascade,
 primary_spin_id uuid not null references public.spins(id) on delete cascade,
 bonus_spin_id uuid not null unique references public.spins(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(card_id,line_index),unique(primary_spin_id,line_index),check(primary_spin_id<>bonus_spin_id)
);
alter table public.bingo_cards enable row level security;
alter table public.bingo_line_awards enable row level security;
drop policy if exists bingo_cards_select on public.bingo_cards;
create policy bingo_cards_select on public.bingo_cards for select to authenticated using(public.can_act_for(creator_id,'view') or public.is_admin());
drop policy if exists bingo_line_awards_select on public.bingo_line_awards;
create policy bingo_line_awards_select on public.bingo_line_awards for select to authenticated using(public.can_act_for(creator_id,'view') or public.is_admin());
revoke all on public.bingo_cards,public.bingo_line_awards from public,anon,authenticated;
grant select on public.bingo_cards,public.bingo_line_awards to authenticated;
grant all on public.bingo_cards,public.bingo_line_awards to service_role;

create or replace function public._bingo_public_state(p_card jsonb)
returns jsonb language sql immutable set search_path=public as $$
 select case when p_card is null or p_card='null'::jsonb then null else jsonb_build_object('cells',p_card->'cells','markedMask',(p_card->>'marked_mask')::integer,'awardedLinesMask',(p_card->>'awarded_lines_mask')::integer,'version',(p_card->>'version')::bigint) end;
$$;
revoke execute on function public._bingo_public_state(jsonb) from public,anon,authenticated,service_role;

create or replace function public._guard_bingo_state_write()
returns trigger language plpgsql security definer set search_path=public as $$
declare c public.bingo_cards%rowtype; parent public.spins%rowtype; bonus public.spins%rowtype;
begin
 if tg_op='DELETE' then
  if exists(select 1 from public.profiles where id=old.creator_id) and exists(select 1 from public.fans where id=old.fan_id) and exists(select 1 from public.wheels where id=old.wheel_id)
    and current_setting('fanfunnel.bingo_write',true) is distinct from 'on' then raise exception 'use atomic bingo attempt' using errcode='42501'; end if;
  return old;
 end if;
 if current_setting('fanfunnel.bingo_write',true) is distinct from 'on' then raise exception 'use atomic bingo attempt' using errcode='42501'; end if;
 if not exists(select 1 from public.fans where id=new.fan_id and creator_id=new.creator_id)
  or not exists(select 1 from public.wheels where id=new.wheel_id and creator_id=new.creator_id and game_kind='bingo' and game_ready) then raise exception 'bingo tenant mismatch' using errcode='42501'; end if;
 if tg_table_name='bingo_cards' then
  if tg_op='UPDATE' and(new.fan_id is distinct from old.fan_id or new.creator_id is distinct from old.creator_id or new.wheel_id is distinct from old.wheel_id or new.cells is distinct from old.cells or new.version<>old.version+1
   or (new.marked_mask|old.marked_mask)<>new.marked_mask or old.status='complete') then raise exception 'invalid bingo card transition' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(new.cells) x where not exists(select 1 from public.prizes p where p.id=(x->>'id')::uuid and p.wheel_id=new.wheel_id and p.stock is null and p.delivery<>'codes' and p.weight>0)) then raise exception 'bingo cell not markable' using errcode='22023'; end if;
 else
  select * into c from public.bingo_cards where id=new.card_id;
  select * into parent from public.spins where id=new.primary_spin_id;
  select * into bonus from public.spins where id=new.bonus_spin_id;
  if c.creator_id is distinct from new.creator_id or c.fan_id is distinct from new.fan_id or c.wheel_id is distinct from new.wheel_id
   or parent.creator_id is distinct from new.creator_id or parent.fan_id is distinct from new.fan_id or parent.wheel_id is distinct from new.wheel_id or parent.kind<>'play' or parent.game_kind<>'bingo'
   or bonus.creator_id is distinct from new.creator_id or bonus.fan_id is distinct from new.fan_id or bonus.wheel_id is distinct from new.wheel_id or bonus.kind<>'bonus' or bonus.parent_spin_id is distinct from parent.id or bonus.bingo_line is distinct from new.line_index then raise exception 'bingo award tenant mismatch' using errcode='42501'; end if;
 end if;
 return new;
end $$;
revoke execute on function public._guard_bingo_state_write() from public,anon,authenticated,service_role;
drop trigger if exists aa_bingo_state_write on public.bingo_cards;
create trigger aa_bingo_state_write before insert or update or delete on public.bingo_cards for each row execute function public._guard_bingo_state_write();
drop trigger if exists aa_bingo_state_write on public.bingo_line_awards;
create trigger aa_bingo_state_write before insert or update or delete on public.bingo_line_awards for each row execute function public._guard_bingo_state_write();

create or replace function public._bingo_ready_error(p_wheel uuid)
returns text language plpgsql stable security definer set search_path=public as $$
declare w public.wheels%rowtype;
begin
 select * into w from public.wheels where id=p_wheel;
 if w.game_kind<>'bingo' then return null; end if;
 if jsonb_typeof(w.game_config) is distinct from 'object' or w.game_config->>'size' is distinct from '3' or (select count(*) from jsonb_object_keys(w.game_config))<>2
  or w.game_config->>'linePrizeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or not(w.game_config ? 'linePrizeId') or w.game_config->'linePrizeId'='null'::jsonb then return 'invalid_game_config'; end if;
 if not exists(select 1 from public.prizes where id=(w.game_config->>'linePrizeId')::uuid and wheel_id=w.id) then return 'invalid_game_config'; end if;
 if(select count(*) from public.prizes where wheel_id=w.id and stock is null and delivery<>'codes' and weight>0)<9 then return 'bingo_needs_cells'; end if;
 if not exists(select 1 from public.prizes where wheel_id=w.id and stock is null and delivery<>'codes' and weight>0 and rarity in('rare','epic','legendary')) then return 'bingo_needs_fallback'; end if;
 return null;
end $$;
revoke execute on function public._bingo_ready_error(uuid) from public,anon,authenticated,service_role;

create or replace function public._game_feature_allowed(p_creator uuid,p_kind text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=p_creator and is_active and(approval_status='approved' or role='admin')
 and(p_kind='wheel' or(p_kind in('scratch','bingo') and features->p_kind='true'::jsonb)));
$$;
revoke execute on function public._game_feature_allowed(uuid,text) from public,anon,authenticated,service_role;

create or replace function public._guard_game_settings()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed_kind boolean:=true; error_code text;
begin
 if new.game_kind not in('wheel','scratch','bingo') or jsonb_typeof(new.game_config) is distinct from 'object'
  or(new.game_kind='wheel' and(new.game_config<>'{}'::jsonb or not new.game_ready))
  or(new.game_kind='scratch' and(new.game_config<>'{"style":"classic"}'::jsonb or not new.game_ready)) then raise exception 'invalid_game_config' using errcode='22023'; end if;
 if tg_op='UPDATE' then
  if new.creator_id is distinct from old.creator_id then raise exception 'game_owner_immutable' using errcode='22023'; end if;
  changed_kind:=new.game_kind is distinct from old.game_kind;
  if tg_table_name='wheels' and new.game_kind='bingo' and not old.game_ready and new.game_ready and not exists(select 1 from public.spins where wheel_id=old.id and kind='play') and not public._game_feature_allowed(new.creator_id,'bingo') then raise exception 'feature_disabled' using errcode='42501';end if;
  if tg_table_name='wheels' then
   if changed_kind and exists(select 1 from public.spins where wheel_id=old.id and kind='play') then raise exception 'game_kind_locked' using errcode='22023'; end if;
   if old.game_kind='bingo' and new.game_config is distinct from old.game_config and exists(select 1 from public.bingo_cards where wheel_id=old.id and status='active') then raise exception 'bingo_active_card' using errcode='22023'; end if;
  end if;
 end if;
 if new.game_kind<>'wheel' and not exists(select 1 from public.profiles where id=new.creator_id and is_active and(approval_status='approved' or role='admin')) then raise exception 'creator_unavailable' using errcode='42501'; end if;
 if new.game_kind<>'wheel' and(tg_op='INSERT' or changed_kind) and not public._game_feature_allowed(new.creator_id,new.game_kind) then raise exception 'feature_disabled' using errcode='42501'; end if;
 if new.game_kind='bingo' then
  if new.game_config->>'size' is distinct from '3' or(select count(*) from jsonb_object_keys(new.game_config))<>2 or not(new.game_config ? 'linePrizeId')
   or(new.game_config->'linePrizeId'<>'null'::jsonb and(new.game_config->>'linePrizeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) then raise exception 'invalid_game_config' using errcode='22023'; end if;
  if tg_table_name='wheels' then
   if not new.game_ready and(new.is_active or new.active_from is not null or new.active_until is not null) then raise exception 'game_not_ready' using errcode='22023'; end if;
   if new.game_ready and current_setting('fanfunnel.game_configuration',true) is distinct from new.id::text then
    -- Validate NEW config against existing prize rows; direct ready writes may
    -- never publish a half-created game. Atomic saver validates after its work.
    if new.game_config->'linePrizeId'='null'::jsonb or not exists(select 1 from public.prizes where id=(new.game_config->>'linePrizeId')::uuid and wheel_id=new.id) then raise exception 'invalid_game_config' using errcode='22023'; end if;
    if(select count(*) from public.prizes where wheel_id=new.id and stock is null and delivery<>'codes' and weight>0)<9 then raise exception 'bingo_needs_cells' using errcode='22023'; end if;
    if not exists(select 1 from public.prizes where wheel_id=new.id and stock is null and delivery<>'codes' and weight>0 and rarity in('rare','epic','legendary')) then raise exception 'bingo_needs_fallback' using errcode='22023'; end if;
   end if;
  end if;
 end if;
 return new;
end $$;
revoke execute on function public._guard_game_settings() from public,anon,authenticated,service_role;
drop trigger if exists aa_game_settings on public.wheels;
create trigger aa_game_settings before insert or update of game_kind,game_config,game_ready,creator_id,is_active,active_from,active_until on public.wheels for each row execute function public._guard_game_settings();

create or replace function public._guard_bingo_prize_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare w public.wheels%rowtype; pr public.prizes%rowtype; old_id uuid; eligible integer; fallback integer;
begin
 old_id:=case when tg_op='INSERT' then null else old.id end;
 if tg_op='UPDATE' and new.wheel_id is distinct from old.wheel_id and exists(select 1 from public.wheels where id in(old.wheel_id,new.wheel_id) and game_kind='bingo') then raise exception 'bingo_active_card' using errcode='22023';end if;
 select * into w from public.wheels where id=case when tg_op='DELETE' then old.wheel_id else new.wheel_id end;
 if w.game_kind is distinct from 'bingo' or not exists(select 1 from public.profiles where id=w.creator_id) then if tg_op='DELETE' then return old; else return new; end if; end if;
 -- Bingo only: serialize against card play. Every writer locks wheel -> prize
 -- (commit_spin_attempt, save_wheel_prizes, set_prize_delivery, add_reward_codes,
 -- _release_fan_focus), so this lock never closes a cycle.
 select * into w from public.wheels where id=w.id for update;
 if old_id is not null and exists(select 1 from public.bingo_cards c,jsonb_array_elements(c.cells) cell where c.wheel_id=w.id and c.status='active' and cell->>'id'=old_id::text) then
  if tg_op='DELETE' or new.wheel_id is distinct from old.wheel_id or new.stock is not null or new.delivery='codes' or new.weight<=0 then raise exception 'bingo_active_card' using errcode='22023'; end if;
 end if;
 if w.game_ready and current_setting('fanfunnel.game_configuration',true) is distinct from w.id::text then
  select count(*) filter(where stock is null and delivery<>'codes' and weight>0),count(*) filter(where stock is null and delivery<>'codes' and weight>0 and rarity in('rare','epic','legendary')) into eligible,fallback from public.prizes where wheel_id=w.id and id is distinct from old_id;
  if tg_op<>'DELETE' and new.stock is null and new.delivery<>'codes' and new.weight>0 then eligible:=eligible+1;if new.rarity in('rare','epic','legendary') then fallback:=fallback+1;end if;end if;
  if eligible<9 then raise exception 'bingo_needs_cells' using errcode='22023'; end if;
  if fallback<1 then raise exception 'bingo_needs_fallback' using errcode='22023'; end if;
  if tg_op='DELETE' and old.id::text=w.game_config->>'linePrizeId' then raise exception 'invalid_game_config' using errcode='22023'; end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke execute on function public._guard_bingo_prize_change() from public,anon,authenticated,service_role;
drop trigger if exists ab_bingo_prize_guard on public.prizes;
create trigger ab_bingo_prize_guard before insert or update or delete on public.prizes for each row execute function public._guard_bingo_prize_change();

-- Retirement: archiving a Bingo game with active cards is allowed. The cards
-- persist, resolution already ignores archived games, and unarchiving restores
-- play. Deleting the game or un-publishing it would discard paid progress.
create or replace function public._guard_bingo_wheel_lifecycle()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if old.game_kind='bingo' and exists(select 1 from public.profiles where id=old.creator_id) and exists(select 1 from public.bingo_cards where wheel_id=old.id and status='active')
  and(tg_op='DELETE' or not new.game_ready) then raise exception 'bingo_active_card' using errcode='22023'; end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke execute on function public._guard_bingo_wheel_lifecycle() from public,anon,authenticated,service_role;
drop trigger if exists ab_bingo_wheel_lifecycle on public.wheels;
create trigger ab_bingo_wheel_lifecycle before delete or update of game_ready on public.wheels for each row execute function public._guard_bingo_wheel_lifecycle();

create or replace function public._game_actor_edit_allowed(p_actor uuid,p_creator uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare old_sub text:=current_setting('request.jwt.claim.sub',true); allowed boolean;
begin
 if p_actor is null then return false;end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);allowed:=public.can_act_for(p_creator,'edit_wheel');
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);return coalesce(allowed,false);
exception when others then perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);raise;
end $$;
revoke execute on function public._game_actor_edit_allowed(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.save_game_wheel(p_wheel uuid,p_creator uuid,p_prizes jsonb,p_config jsonb,p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
declare w public.wheels%rowtype; error_code text;
begin
 select * into w from public.wheels where id=p_wheel and creator_id=p_creator for update;
 if not found then raise exception 'game_not_found' using errcode='P0002'; end if;
 if not public._game_actor_edit_allowed(p_actor,p_creator) then raise exception 'forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_config) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in('title','subtitle','brand_color','label_color','label_size','show_stock','game_kind','game_config'))
  or p_config->>'game_kind' is distinct from 'bingo' then raise exception 'invalid_game_config' using errcode='22023'; end if;
 perform set_config('fanfunnel.game_configuration',w.id::text,true);
 -- Keep existing readiness while editing; no intermediate state leaves this
 -- statement transaction, and active-card lifecycle guards remain in force.
 update public.wheels set game_kind='bingo',game_config=p_config->'game_config',
  title=case when p_config ? 'title' then p_config->>'title' else title end,subtitle=case when p_config ? 'subtitle' then p_config->>'subtitle' else subtitle end,
  brand_color=case when p_config ? 'brand_color' then p_config->>'brand_color' else brand_color end,
  label_color=case when p_config ? 'label_color' then p_config->>'label_color' else label_color end,label_size=case when p_config ? 'label_size' then p_config->>'label_size' else label_size end,
  show_stock=case when p_config ? 'show_stock' then (p_config->>'show_stock')::boolean else show_stock end where id=w.id;
 perform public.save_wheel_prizes(w.id,p_creator,p_prizes);
 error_code:=public._bingo_ready_error(w.id);if error_code is not null then raise exception '%',error_code using errcode='22023'; end if;
 update public.wheels set game_ready=true where id=w.id;
 perform set_config('fanfunnel.game_configuration','',true);
end $$;
revoke execute on function public.save_game_wheel(uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_game_wheel(uuid,uuid,jsonb,jsonb,uuid) to service_role;

-- A read of the fan's own card. It is not gated on the creator blocking the
-- fan or on creator approval: a blocked fan keeps the same read-only page as
-- on wheel/scratch, and play is refused by prepare/commit, never by this read.
create or replace function public.get_bingo_card_state(p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.fan_passes%rowtype; card public.bingo_cards%rowtype; wheel uuid;
begin
 select fp.* into p from public.fan_passes fp join public.fans f on f.id=fp.fan_id
 where fp.token=p_token and fp.is_active and fp.self_excluded_at is null and f.creator_id=fp.creator_id;
 if not found then return jsonb_build_object('status','unavailable');end if;
 wheel:=public._resolved_spin_wheel(p.id);
 select * into card from public.bingo_cards where fan_id=p.fan_id and wheel_id=wheel order by(status='active') desc,created_at desc,id desc limit 1;
 return jsonb_build_object('status','ok','card',case when card.id is null then null else public._bingo_public_state(to_jsonb(card)) end);
end $$;
revoke execute on function public.get_bingo_card_state(text) from public,anon,authenticated;
grant execute on function public.get_bingo_card_state(text) to service_role;

create or replace function public._validate_bingo_presentation(p_snapshot jsonb,p_before jsonb,p_presentation jsonb,p_prize uuid)
returns boolean language plpgsql immutable set search_path=public as $$
declare after_state jsonb; cells jsonb; cell jsonb; index_found integer; old_marks integer; marks integer; old_lines integer; lines integer; new_lines jsonb; new_card boolean; i integer;
begin
 if jsonb_typeof(p_presentation) is distinct from 'object' then return false;end if;
 if(select count(*) from jsonb_object_keys(p_presentation))<>6 or exists(select 1 from jsonb_object_keys(p_presentation) k where k not in('kind','before','after','newCard','markedIndex','newLines'))
  or p_presentation->>'kind' is distinct from 'bingo' or p_presentation->'before' is distinct from coalesce(p_before,'null'::jsonb) then return false;end if;
 after_state:=p_presentation->'after';
 if jsonb_typeof(after_state) is distinct from 'object' then return false;end if;
 if(select count(*) from jsonb_object_keys(after_state))<>4 or exists(select 1 from jsonb_object_keys(after_state) k where k not in('cells','markedMask','awardedLinesMask','version'))
  or not public._bingo_cells_valid(after_state->'cells') then return false;end if;
 new_card:=p_before is null or p_before='null'::jsonb or(p_before->>'markedMask')::integer=511;
 if p_presentation->'newCard' is distinct from to_jsonb(new_card) then return false;end if;
 cells:=after_state->'cells';
 if not new_card and cells is distinct from p_before->'cells' then return false;end if;
 if new_card then
  for cell in select value from jsonb_array_elements(cells) loop
   if not exists(select 1 from jsonb_array_elements(p_snapshot#>'{bingo,catalog}') c where c=cell) then return false;end if;
  end loop;
 end if;
 select n::integer-1 into index_found from jsonb_array_elements(cells) with ordinality x(c,n) where c->>'id'=p_prize::text;
 if p_presentation->'markedIndex' is distinct from coalesce(to_jsonb(index_found),'null'::jsonb) then return false;end if;
 old_marks:=case when new_card then 0 else(p_before->>'markedMask')::integer end;
 old_lines:=case when new_card then 0 else(p_before->>'awardedLinesMask')::integer end;
 marks:=old_marks|case when index_found is null then 0 else 1<<index_found end;
 lines:=public._bingo_completed_lines(marks);
 select coalesce(jsonb_agg(x order by x),'[]'::jsonb) into new_lines from generate_series(0,7) x where(lines&(~old_lines)&(1<<x))<>0;
 if after_state->'markedMask' is distinct from to_jsonb(marks) or after_state->'awardedLinesMask' is distinct from to_jsonb(lines)
  or after_state->'version' is distinct from to_jsonb(case when new_card then 1::bigint else(p_before->>'version')::bigint+1 end)
  or p_presentation->'newLines' is distinct from new_lines then return false;end if;
 return true;
end $$;
revoke execute on function public._validate_bingo_presentation(jsonb,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;

create or replace function public._validate_bingo_snapshot(p_snapshot jsonb,p_context jsonb,p_before jsonb)
returns boolean language plpgsql immutable set search_path=public as $$
declare catalog jsonb; bonus_selected jsonb; fallback jsonb; p jsonb; free_stock integer; chosen text; expected jsonb;
begin
 if jsonb_typeof(p_snapshot->'bingo') is distinct from 'object' then return false;end if;
 if(select count(*) from jsonb_object_keys(p_snapshot->'bingo'))<>3 or exists(select 1 from jsonb_object_keys(p_snapshot->'bingo') k where k not in('catalog','before','bonus'))
  or p_snapshot#>'{bingo,before}' is distinct from coalesce(p_before,'null'::jsonb) then return false;end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->'id','label',x->'label','emoji',x->'emoji','rarity',x->'rarity') order by x->>'id'),'[]'::jsonb) into catalog
 from jsonb_array_elements(p_context->'prizes') x where x->>'stock' is null and x->>'delivery'<>'codes' and(x->>'weight')::integer>0;
 if jsonb_array_length(catalog)<9 or p_snapshot#>'{bingo,catalog}' is distinct from catalog then return false;end if;
 if p_before is not null and p_before<>'null'::jsonb and(p_before->>'markedMask')::integer<>511 and exists(select 1 from jsonb_array_elements(p_before->'cells') c where not exists(select 1 from jsonb_array_elements(catalog) x where x->>'id'=c->>'id')) then return false;end if;
 chosen:=p_snapshot#>>'{gameConfig,linePrizeId}';bonus_selected:='null'::jsonb;fallback:='[]'::jsonb;
 for p in select value from jsonb_array_elements(p_context->'prizes') order by value->>'id' loop
  free_stock:=(p->>'stock')::integer;
  if p_context#>>'{reservation,prize_id}'=p->>'id' and p_context#>>'{reservation,kind}' in('stock','code') and free_stock is not null then free_stock:=free_stock-1;end if;
  if(p->>'delivery'='codes' and coalesce(free_stock,0)>0) or(p->>'delivery'<>'codes' and(free_stock is null or free_stock>0)) then
   expected:=jsonb_build_object('id',p->'id','label',p->'label','emoji',p->'emoji','rarity',p->'rarity','w',(p->>'weight')::integer,'unlimited',p->>'delivery'<>'codes' and free_stock is null);
   if p->>'id'=chosen then bonus_selected:=expected;end if;
   if(p->>'weight')::integer>0 and p->>'rarity' in('rare','epic','legendary') then fallback:=fallback||jsonb_build_array(expected);end if;
  end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(fallback) x where x->'unlimited'='true'::jsonb) then return false;end if;
 return p_snapshot#>'{bingo,bonus}'=jsonb_build_object('selected',bonus_selected,'fallback',fallback);
end $$;
revoke execute on function public._validate_bingo_snapshot(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

-- A bonus allocation failure is caught by the enclosing attempt's EXCEPTION
-- block. Its subtransaction rolls back primary credit/stock and every earlier
-- bonus before returning a recoverable candidate status to the trusted caller.
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
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end);
 select stock into v_stock_after from public.prizes where id=pr.id;update public.spin_rewards set stock_after=v_stock_after where spin_id=s.id;
 return jsonb_build_object('line',p_line,'shareId',s.share_id,'prize',p_bonus->'response_prize','spin',to_jsonb(s)-'fan_id'-'fan_pass_id','stockAfter',v_stock_after);
end $$;
revoke execute on function public._commit_bingo_bonus(uuid,jsonb,integer) from public,anon,authenticated,service_role;
-- The one ranking every path uses to pick a creator's live game: campaign pin,
-- then an open schedule window, then the is_active flag, then the oldest live
-- game. Issuance (_create_pass_grant_core), the prepare context and spin time
-- (_resolved_spin_wheel) all call this, so a link is minted for the game the
-- fan will actually play. Mirrored in src/lib/data/wheels.ts resolveActiveWheelId.
create or replace function public._creator_default_wheel(p_creator uuid,p_campaign uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(
  (select w.id from public.campaigns c join public.wheels w on w.id=c.pinned_wheel_id
    where c.id=p_campaign and c.creator_id=p_creator and w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')),
  (select w.id from public.wheels w where w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')
    and (w.active_from is not null or w.active_until is not null)
    and (w.active_from is null or w.active_from<=now()) and (w.active_until is null or w.active_until>now())
    order by w.active_from desc nulls last,w.created_at desc,w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo') and w.is_active order by w.created_at,w.id limit 1),
  (select w.id from public.wheels w where w.creator_id=p_creator and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo') order by w.created_at,w.id limit 1));
$$;
revoke execute on function public._creator_default_wheel(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public._resolved_spin_wheel(p_pass uuid)
returns uuid language sql stable security definer set search_path=public as $$
 select coalesce(public._creator_default_wheel(fp.creator_id,fp.campaign_id),
  (select w.id from public.wheels w where w.id=fp.wheel_id and w.creator_id=fp.creator_id and w.archived_at is null and w.game_ready and w.game_kind in('wheel','scratch','bingo')))
 from public.fan_passes fp where fp.id=p_pass;
$$;

create or replace function public._spin_attempt_context(p_pass uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare p public.fan_passes%rowtype; f public.fans%rowtype; w public.wheels%rowtype;
 ff public.fan_focus%rowtype; r public.chase_reservations%rowtype; v_prizes jsonb; v_hash_prizes jsonb; v jsonb; hh numeric; card public.bingo_cards%rowtype;
begin
 select * into p from public.fan_passes where id=p_pass;
 select * into f from public.fans where id=p.fan_id;
 select * into w from public.wheels where id=public._resolved_spin_wheel(p_pass);
 select * into ff from public.fan_focus where fan_id=p.fan_id and status in('active','paused');
 select * into r from public.chase_reservations where focus_id=ff.id and state='held';
 select coalesce(jsonb_agg(to_jsonb(pr) || jsonb_build_object('stock',case when r.prize_id=pr.id and r.state='held' and pr.stock is not null then pr.stock+1 else pr.stock end) order by pr.sort_order,pr.id),'[]'::jsonb)
   into v_prizes from public.prizes pr where pr.wheel_id=w.id;
 select coalesce(jsonb_agg(x-'stock' order by x->>'id'),'[]'::jsonb) into v_hash_prizes from jsonb_array_elements(v_prizes) x;
 -- Only the game owner's own happy hours boost the game (tenancy, defence in depth).
 select least(5,coalesce(max(multiplier),1)) into hh from public.happy_hours where wheel_id=w.id and creator_id=w.creator_id and starts_at<=now() and ends_at>now();
 v:=jsonb_build_object('fanId',p.fan_id,'passId',p.id,'creatorId',p.creator_id,'campaignId',p.campaign_id,
  'wheelId',w.id,'wheel',to_jsonb(w),'serverSeed',p.next_server_seed,'serverSeedHash',p.next_server_seed_hash,
  'nonce',p.next_spin_nonce,'pityCounter',f.pity_counter,'happyHourMultiplier',hh,
  'focus',case when ff.id is null then null else to_jsonb(ff) end,
  'reservation',case when r.id is null then null else to_jsonb(r) end);
 if w.game_kind='bingo' then
  select * into card from public.bingo_cards where fan_id=p.fan_id and wheel_id=w.id order by(status='active') desc,created_at desc,id desc limit 1;
  v:=v||jsonb_build_object('bingoCard',case when card.id is null then null else to_jsonb(card) end);
 end if;
 return v || jsonb_build_object('prizes',v_prizes,'contextHash',encode(digest((v||jsonb_build_object('prizes',v_hash_prizes))::text,'sha256'),'hex'));
end $$;

create or replace function public._spin_attempt_receipt(p_attempt uuid,p_replayed boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.spin_attempts%rowtype; r public.spin_rewards%rowtype; b integer; f jsonb; next_hash text; bonus jsonb; bonuses jsonb:='[]'::jsonb; receipt_reward public.spin_rewards%rowtype;
begin
 select * into a from public.spin_attempts where id=p_attempt;
 select spins_remaining,next_server_seed_hash into b,next_hash from public.fan_passes where id=a.fan_pass_id;
 select to_jsonb(ff) into f from public.fan_focus ff where ff.fan_id=a.fan_id and ff.status in('active','paused');
 select * into r from public.spin_rewards where spin_id=a.spin_id and erased_at is null;
 for bonus in select value from jsonb_array_elements(coalesce(a.result->'bonusWins','[]'::jsonb)) loop
  select * into receipt_reward from public.spin_rewards where spin_id=(bonus#>>'{spin,id}')::uuid and erased_at is null;
  bonuses:=bonuses||jsonb_build_array(bonus||jsonb_build_object('reward',case when receipt_reward.spin_id is null then null else jsonb_build_object('kind',receipt_reward.kind,'cipher',receipt_reward.cipher,'iv',receipt_reward.iv,'keyVersion',receipt_reward.key_version) end));
 end loop;
 return a.result || jsonb_build_object('status','committed','replayed',p_replayed,'bonusWins',bonuses,'bingoCard',(public.get_bingo_card_state((select token from public.fan_passes where id=a.fan_pass_id))->'card'),'balance',b,'focus',f,'nextServerSeedHash',next_hash,
  'reward',case when r.spin_id is null then null else jsonb_build_object('kind',r.kind,'cipher',r.cipher,'iv',r.iv,'keyVersion',r.key_version) end);
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
 insert into public.redemptions(spin_id,creator_id,status,fulfilled_at) values(s.id,s.creator_id,case when pr.delivery='manual' then 'pending'::public.redemption_status else 'fulfilled'::public.redemption_status end,case when pr.delivery='manual' then null else now() end);
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
 -- Same ranking as spin time (pin, open window, active flag, oldest), so the
 -- link is minted for the game the fan will actually play.
 if p_wheel is null then p_wheel:=public._creator_default_wheel(p_creator,p_campaign); end if;
 if not exists(select 1 from public.wheels where id=p_wheel and creator_id=p_creator and archived_at is null and game_ready and game_kind in('wheel','scratch','bingo')) then return jsonb_build_object('status','invalid','error','no_wheel'); end if;
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
  v_stock integer;
  v_current integer;
  v_expected integer;
begin
  perform 1 from public.wheels where id = p_wheel and creator_id = p_creator for update;
  if not found then raise exception 'wheel not found' using errcode = 'P0002'; end if;
  if exists(select 1 from public.wheels where id=p_wheel and game_kind='bingo') and current_setting('fanfunnel.game_configuration',true) is distinct from p_wheel::text then raise exception 'use actor-bound game saver' using errcode='42501';end if;
  if p_prizes is null or jsonb_typeof(p_prizes) <> 'array' or jsonb_array_length(p_prizes) not between 2 and 50 then
    raise exception 'invalid prize count' using errcode = '22023';
  end if;
  perform 1 from public.prizes where wheel_id = p_wheel order by id for update;
  for v_row in select * from jsonb_array_elements(p_prizes) loop
    v_id := null;
    v_stock := (v_row->>'stock')::integer;
    if (v_row->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id, stock into v_id, v_current from public.prizes where id = (v_row->>'id')::uuid and wheel_id = p_wheel;
    end if;
    -- Stock is a compare-and-set against the value the editor loaded
    -- (expected_stock), so a save never "un-decrements" spins that landed
    -- while the creator was editing. A finite edit over moved stock is applied
    -- as the creator's delta; a limited/unlimited switch that no longer matches
    -- what they saw is a stock_changed conflict (reload and retry).
    if v_id is not null and (v_row ? 'expected_stock') then
      v_expected := (v_row->>'expected_stock')::integer;
      if v_current is distinct from v_expected and v_stock is not null then
        if v_current is null or v_expected is null then raise exception 'stock_changed' using errcode = '22023'; end if;
        v_stock := greatest(0, v_current + (v_stock - v_expected));
      end if;
    end if;
    if v_id is null and current_setting('fanfunnel.game_configuration',true)=p_wheel::text and(v_row->>'id') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
      if exists(select 1 from public.prizes where id=(v_row->>'id')::uuid) then raise exception 'invalid_game_config' using errcode='22023';end if;
      v_id:=(v_row->>'id')::uuid;
    end if;
    if v_id is null then v_id := gen_random_uuid(); end if;
    if v_id = any(v_ids) then raise exception 'duplicate prize id' using errcode = '22023'; end if;
    insert into public.prizes (id,wheel_id,label,description,rarity,weight,color,emoji,image_url,cost_cents,stock,sort_order,boostable)
    values(v_id,p_wheel,v_row->>'label',v_row->>'description',(v_row->>'rarity')::public.prize_rarity,
      (v_row->>'weight')::integer,v_row->>'color',v_row->>'emoji',v_row->>'image_url',
      (v_row->>'cost_cents')::integer,v_stock,v_order,coalesce((v_row->>'boostable')::boolean,false))
    on conflict(id) do update set label=excluded.label,description=excluded.description,rarity=excluded.rarity,
      weight=excluded.weight,color=excluded.color,emoji=excluded.emoji,image_url=excluded.image_url,
      cost_cents=excluded.cost_cents,stock=excluded.stock,sort_order=excluded.sort_order,boostable=excluded.boostable;
    v_ids := array_append(v_ids,v_id);
    v_order := v_order + 1;
  end loop;
  delete from public.prizes where wheel_id=p_wheel and not(id=any(v_ids));
end;
$$;

create or replace function public._guard_immutable_game_proof()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' then
   if new.kind is distinct from old.kind or new.parent_spin_id is distinct from old.parent_spin_id or new.bingo_line is distinct from old.bingo_line or new.game_kind is distinct from old.game_kind or new.presentation is distinct from old.presentation
     or (old.game_kind<>'wheel' and (new.pool_snapshot is distinct from old.pool_snapshot or new.pool_hash is distinct from old.pool_hash or new.fair_trace is distinct from old.fair_trace)) then
     raise exception 'game proof is immutable' using errcode='22023';
   end if;
 elsif new.kind='bonus' then
  if current_setting('fanfunnel.bingo_write',true) is distinct from 'on' or new.game_kind<>'bingo' or new.presentation is not null or new.server_seed is not null or new.server_seed_hash is not null or new.nonce is not null or new.fair_version is not null or new.pool_snapshot is not null or new.pool_hash is not null or new.fair_trace is not null
   or not exists(select 1 from public.spins where id=new.parent_spin_id and kind='play' and game_kind='bingo' and creator_id=new.creator_id and fan_id=new.fan_id and fan_pass_id=new.fan_pass_id and wheel_id=new.wheel_id) then raise exception 'invalid bingo bonus parent' using errcode='42501';end if;
 elsif new.game_kind='bingo' then
  if not public._validate_bingo_presentation(new.pool_snapshot,new.pool_snapshot#>'{bingo,before}',new.presentation,new.prize_id) then raise exception 'invalid bingo presentation' using errcode='22023';end if;
 elsif new.game_kind<>'wheel' and (new.game_kind<>'scratch' or not public._valid_scratch_presentation(new.pool_snapshot,new.prize_id,new.presentation)) then
   raise exception 'invalid game presentation' using errcode='22023';
 elsif new.game_kind='wheel' and new.presentation is not null then
   raise exception 'unexpected wheel presentation' using errcode='22023';
 end if;
 return new;
end $$;

drop trigger if exists ab_immutable_game_proof on public.spins;
create trigger ab_immutable_game_proof before insert or update of game_kind,presentation,pool_snapshot,pool_hash,fair_trace,kind,parent_spin_id,bingo_line on public.spins for each row execute function public._guard_immutable_game_proof();
revoke execute on function public._spin_attempt_context(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._spin_attempt_receipt(uuid,boolean) from public,anon,authenticated,service_role;
revoke execute on function public._resolved_spin_wheel(uuid) from public,anon,authenticated,service_role;
revoke execute on function public._guard_immutable_game_proof() from public,anon,authenticated,service_role;
revoke execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;
revoke execute on function public.save_wheel_prizes(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_wheel_prizes(uuid,uuid,jsonb) to service_role;
revoke execute on function public._create_pass_grant_core(uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer) from public,anon,authenticated,service_role;

-- Lock ordering: every prize writer takes the wheel row before the prize row,
-- the order commit_spin_attempt and save_wheel_prizes already use, so a
-- creator edit racing a credited play can never deadlock (40P01).
create or replace function public.add_reward_codes(p_prize uuid, p_creator uuid, p_codes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wheel uuid;
  v_left integer;
  v_new integer;
  v_added integer;
begin
  select wheel_id into v_wheel from public.prizes where id = p_prize;
  perform 1 from public.wheels where id = v_wheel and creator_id = p_creator for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  perform 1 from public.prizes where id = p_prize and wheel_id = v_wheel for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 then
    raise exception 'codes must be a non-empty array' using errcode = '22023';
  end if;
  select count(*) into v_left from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  select count(distinct e->>'fingerprint') into v_new from jsonb_array_elements(p_codes) e
   where not exists (select 1 from public.prize_reward_codes c where c.prize_id = p_prize and c.fingerprint = e->>'fingerprint');
  if v_left + v_new > 5000 then
    raise exception 'too many codes on one prize' using errcode = '22023';
  end if;
  with added as (
    insert into public.prize_reward_codes (prize_id, creator_id, cipher, iv, key_version, hint, fingerprint)
    select p_prize, p_creator, e->>'cipher', e->>'iv', coalesce((e->>'key_version')::smallint, 1), nullif(e->>'hint', ''), e->>'fingerprint'
      from jsonb_array_elements(p_codes) e
    on conflict (prize_id, fingerprint) do nothing
    returning 1
  ) select count(*) into v_added from added;
  delete from public.prize_rewards where prize_id = p_prize;
  update public.prizes set delivery = 'codes' where id = p_prize;
  select stock into v_left from public.prizes where id = p_prize;
  return v_added;
end;
$$;

create or replace function public.set_prize_delivery(
  p_prize uuid,
  p_creator uuid,
  p_kind text,
  p_cipher text default null,
  p_iv text default null,
  p_key_version smallint default 1
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wheel uuid;
begin
  if p_kind is null or p_kind not in ('manual', 'link', 'text') then
    raise exception 'invalid delivery' using errcode = '22023';
  end if;
  select wheel_id into v_wheel from public.prizes where id = p_prize;
  perform 1 from public.wheels where id = v_wheel and creator_id = p_creator for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  perform 1 from public.prizes where id = p_prize and wheel_id = v_wheel for update;
  if not found then
    raise exception 'prize not found' using errcode = 'P0002';
  end if;
  if p_kind = 'manual' then
    delete from public.prize_rewards where prize_id = p_prize;
  else
    if p_cipher is null or p_iv is null then
      raise exception 'reward value required' using errcode = '22023';
    end if;
    insert into public.prize_rewards (prize_id, creator_id, kind, cipher, iv, key_version, updated_at)
    values (p_prize, p_creator, p_kind, p_cipher, p_iv, coalesce(p_key_version, 1), now())
    on conflict (prize_id) do update
      set creator_id = excluded.creator_id, kind = excluded.kind, cipher = excluded.cipher,
          iv = excluded.iv, key_version = excluded.key_version, updated_at = now();
  end if;
  update public.prizes set delivery = p_kind where id = p_prize;
  delete from public.prize_reward_codes where prize_id = p_prize and spin_id is null;
  return p_kind;
end;
$$;

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
    perform 1 from public.wheels where id=(select wheel_id from public.prizes where id=r.prize_id) for update;
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

-- A happy hour may only boost one of its own creator's games: RLS with-check
-- for browser sessions and a BEFORE trigger for every role (defence in depth).
create or replace function public._guard_happy_hour_tenant()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.wheels where id=new.wheel_id and creator_id=new.creator_id) then raise exception 'happy hour wheel belongs to another creator' using errcode='42501'; end if;
 return new;
end $$;
revoke execute on function public._guard_happy_hour_tenant() from public,anon,authenticated,service_role;
drop trigger if exists aa_happy_hour_tenant on public.happy_hours;
create trigger aa_happy_hour_tenant before insert or update of wheel_id,creator_id on public.happy_hours for each row execute function public._guard_happy_hour_tenant();
drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check (((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
    and exists (select 1 from public.wheels w where w.id = wheel_id and w.creator_id = happy_hours.creator_id));
revoke execute on function public._release_fan_focus(uuid) from public,anon,authenticated,service_role;
revoke execute on function public.add_reward_codes(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.add_reward_codes(uuid,uuid,jsonb) to service_role;
revoke execute on function public.set_prize_delivery(uuid,uuid,text,text,text,smallint) from public,anon,authenticated;
grant execute on function public.set_prize_delivery(uuid,uuid,text,text,text,smallint) to service_role;
