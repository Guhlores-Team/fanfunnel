-- 0063: immutable reward-key anchor and bounded, read-only operational checks.
-- This migration follows the game and account-security migrations. It neither
-- repairs balances/stock nor replaces an existing key anchor.
create table if not exists public.reward_crypto_canary (
  singleton boolean primary key default true check (singleton),
  cipher text not null check (char_length(cipher) between 24 and 2048),
  iv text not null check (char_length(iv) between 16 and 64),
  key_version smallint not null check (key_version between 1 and 32767),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.reward_crypto_canary enable row level security;
drop policy if exists reward_crypto_canary_service on public.reward_crypto_canary;
create policy reward_crypto_canary_service on public.reward_crypto_canary for select to service_role
  using (auth.role() = 'service_role');
revoke all on public.reward_crypto_canary from public, anon, authenticated, service_role;
grant select on public.reward_crypto_canary to service_role;

create or replace function public.protect_reward_crypto_canary()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'reward key anchor is immutable; use audited key recovery' using errcode = '42501';
end $$;
revoke execute on function public.protect_reward_crypto_canary() from public, anon, authenticated, service_role;
drop trigger if exists reward_crypto_canary_immutable on public.reward_crypto_canary;
create trigger reward_crypto_canary_immutable before update or delete on public.reward_crypto_canary
  for each row execute function public.protect_reward_crypto_canary();

create table if not exists public.system_health_checks (
  singleton boolean primary key default true check (singleton),
  canary_status text not null default 'not_run' check (canary_status in ('not_run','healthy','missing','configuration_missing','configuration_invalid','mismatch','unavailable')),
  canary_checked_at timestamptz,
  canary_failure_at timestamptz,
  invariants_status text not null default 'not_run' check (invariants_status in ('not_run','healthy','violations','incomplete','unavailable')),
  invariant_counts jsonb not null default '{}',
  invariants_checked_at timestamptz,
  last_maintenance_at timestamptz,
  last_source text not null default 'startup' check (last_source in ('startup','manual','maintenance')),
  check (jsonb_typeof(invariant_counts) = 'object' and octet_length(invariant_counts::text) <= 4096)
);
alter table public.system_health_checks enable row level security;
drop policy if exists system_health_checks_admin on public.system_health_checks;
create policy system_health_checks_admin on public.system_health_checks for select to authenticated using (public.is_admin());
revoke all on public.system_health_checks from public, anon, authenticated;
grant select on public.system_health_checks to authenticated;
grant select, insert, update on public.system_health_checks to service_role;

-- An independent witness records a REAL negative stock delta, not the promised
-- reservation itself. Existing held reservations are deliberately not blessed.
create table if not exists public.chase_stock_evidence (
  reservation_id uuid primary key references public.chase_reservations(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  prize_id uuid not null references public.prizes(id) on delete cascade,
  origin_transaction text not null default pg_current_xact_id()::text,
  units_taken integer not null default 0 check (units_taken in (0,1)),
  created_at timestamptz not null default now(),
  witnessed_at timestamptz
);
create index if not exists chase_stock_evidence_pending_idx on public.chase_stock_evidence(prize_id,origin_transaction) where units_taken=0;
alter table public.chase_stock_evidence enable row level security;
drop policy if exists chase_stock_evidence_service on public.chase_stock_evidence;
create policy chase_stock_evidence_service on public.chase_stock_evidence for select to service_role using (auth.role()='service_role');
revoke all on public.chase_stock_evidence from public, anon, authenticated;
grant select on public.chase_stock_evidence to service_role;

create or replace function public.record_chase_stock_evidence()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind='stock' and new.state='held' and new.prize_id is not null then
    insert into public.chase_stock_evidence(reservation_id,creator_id,prize_id)
      values(new.id,new.creator_id,new.prize_id) on conflict(reservation_id) do nothing;
  end if;
  return new;
end $$;
revoke execute on function public.record_chase_stock_evidence() from public,anon,authenticated,service_role;
drop trigger if exists record_chase_stock_evidence on public.chase_reservations;
create trigger record_chase_stock_evidence after insert on public.chase_reservations
  for each row execute function public.record_chase_stock_evidence();

create or replace function public.witness_chase_stock_debit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_units integer;
begin
  if old.stock is not null and new.stock is not null and new.stock<old.stock then
    v_units:=old.stock-new.stock;
    update public.chase_stock_evidence set units_taken=1,witnessed_at=now()
      where reservation_id in (
        select e.reservation_id from public.chase_stock_evidence e
        join public.chase_reservations r on r.id=e.reservation_id
        where e.prize_id=new.id and e.creator_id=(select creator_id from public.wheels where id=new.wheel_id) and e.units_taken=0
          and e.origin_transaction=pg_current_xact_id()::text and r.kind='stock' and r.state='held'
        order by e.created_at,e.reservation_id limit v_units for update of e
      );
  end if;
  return new;
end $$;
revoke execute on function public.witness_chase_stock_debit() from public,anon,authenticated,service_role;
drop trigger if exists witness_chase_stock_debit on public.prizes;
create trigger witness_chase_stock_debit after update of stock on public.prizes
  for each row execute function public.witness_chase_stock_debit();

-- Inventory writers share this fence; initialization takes it exclusively.
-- This avoids holding table SHARE locks while an economic transaction waits
-- to insert its spin/receipt. It is synchronization, never authorization.
create or replace function public.fence_reward_inventory_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('reward-crypto-canary-initialize',0));
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke execute on function public.fence_reward_inventory_write() from public,anon,authenticated,service_role;
drop trigger if exists fence_reward_inventory_write on public.prize_rewards;
create trigger fence_reward_inventory_write before insert or update or delete on public.prize_rewards for each row execute function public.fence_reward_inventory_write();
drop trigger if exists fence_reward_inventory_write on public.prize_reward_codes;
create trigger fence_reward_inventory_write before insert or update or delete on public.prize_reward_codes for each row execute function public.fence_reward_inventory_write();
drop trigger if exists fence_reward_inventory_write on public.spin_rewards;
create trigger fence_reward_inventory_write before insert or update or delete on public.spin_rewards for each row execute function public.fence_reward_inventory_write();

-- Inventory stays server-only. Each row digest is computed in SQL; the server
-- validates decrypted values and concatenates these digests in cursor order.
create or replace function public._reward_crypto_inventory()
returns table(cursor text,creator_id uuid,prize_id uuid,cipher text,iv text,key_version smallint,fingerprint text,row_digest text)
language sql stable security definer set search_path=public,extensions,pg_temp as $$
  select x.cursor,x.creator_id,x.prize_id,x.cipher,x.iv,x.key_version,x.fingerprint,
    encode(digest(jsonb_build_array(x.cursor,x.creator_id,x.prize_id,x.cipher,x.iv,x.key_version,x.fingerprint)::text,'sha256'),'hex')
  from (
    select 'code:'||c.id::text cursor,c.creator_id,c.prize_id,c.cipher,c.iv,c.key_version,c.fingerprint
      from public.prize_reward_codes c where c.erased_at is null
    union all
    select 'reward:'||r.prize_id::text,r.creator_id,r.prize_id,r.cipher,r.iv,r.key_version,null::text
      from public.prize_rewards r
    union all
    select 'spin:'||r.spin_id::text,r.creator_id,s.prize_id,r.cipher,r.iv,r.key_version,null::text
      from public.spin_rewards r join public.spins s on s.id=r.spin_id where r.erased_at is null
  ) x;
$$;
revoke execute on function public._reward_crypto_inventory() from public,anon,authenticated,service_role;

create or replace function public.read_reward_crypto_canary()
returns jsonb language sql stable security definer set search_path = public as $$
 select case when c.singleton is null then null else jsonb_build_object('cipher',c.cipher,'iv',c.iv,'keyVersion',c.key_version,'fingerprint',c.fingerprint,'createdAt',c.created_at) end
 from (values(true)) seed(singleton) left join public.reward_crypto_canary c using(singleton);
$$;
revoke execute on function public.read_reward_crypto_canary() from public,anon,authenticated;
grant execute on function public.read_reward_crypto_canary() to service_role;

create or replace function public.reward_crypto_inventory_page(p_after text default '',p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb; v_limit integer:=least(greatest(coalesce(p_limit,500),1),500);
begin
 if length(coalesce(p_after,''))>64 then raise exception 'invalid inventory cursor' using errcode='22023'; end if;
 if (select count(*) from (select 1 from public._reward_crypto_inventory() limit 25001) bounded)>25000 then
   return jsonb_build_object('status','inventory_limit','rows','[]'::jsonb);
 end if;
 select coalesce(jsonb_agg(to_jsonb(p) order by p.cursor collate "C"),'[]'::jsonb) into v_rows
 from (select * from public._reward_crypto_inventory() where cursor collate "C">coalesce(p_after,'') collate "C" order by cursor collate "C" limit v_limit) p;
 return jsonb_build_object('rows',v_rows);
end $$;
revoke execute on function public.reward_crypto_inventory_page(text,integer) from public,anon,authenticated;
grant execute on function public.reward_crypto_inventory_page(text,integer) to service_role;

-- Close any pre-release three-argument gateway left by a manual schema paste.
-- Every current caller supplies p_context explicitly, including null bootstrap.
do $$begin
 if to_regprocedure('public.initialize_reward_crypto_canary(jsonb,text,uuid)') is not null then
  execute 'revoke execute on function public.initialize_reward_crypto_canary(jsonb,text,uuid) from public,anon,authenticated,service_role';
 end if;
end$$;
create or replace function public.initialize_reward_crypto_canary(p_canary jsonb,p_inventory_digest text,p_actor uuid default null,p_context uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp set lock_timeout='3s' as $$
declare v_existing jsonb; v_count integer; v_digest text;
begin
 --0062 admin/profile writes take this fence before row/storage/inventory locks.
 -- Preserve that order: an admitted request must not outlive admin revocation.
 if p_actor is not null then perform pg_advisory_xact_lock(hashtextextended('fanfunnel-active-admins',0)); end if;
 perform pg_advisory_xact_lock(hashtextextended('reward-crypto-canary-initialize',0));
 if p_actor is not null then
   if not public._creator_actor_allowed(p_context,p_actor,p_actor,'system_health','system_health') then return jsonb_build_object('status','forbidden');end if;
   perform 1 from public.profiles where id=p_actor and role='admin' and is_active;
   if not found then return jsonb_build_object('status','forbidden'); end if;
 end if;
 select public.read_reward_crypto_canary() into v_existing;
 if v_existing is not null then return jsonb_build_object('status','existing','canary',v_existing); end if;
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
revoke execute on function public.initialize_reward_crypto_canary(jsonb,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.initialize_reward_crypto_canary(jsonb,text,uuid,uuid) to service_role;

-- Read-only: an over-budget database is explicitly incomplete, never healthy.
create or replace function public.run_reward_ledger_invariants(p_row_limit integer default 100000)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_limit integer:=least(greatest(coalesce(p_row_limit,100000),1),100000); v_counts jsonb; v_total integer;
begin
 if exists(
   select 1 from (
     select count(*) n from (select id from public.prizes limit v_limit+1) x union all
     select count(*) from (select id from public.prize_reward_codes limit v_limit+1) x union all
     select count(*) from (select id from public.fan_focus limit v_limit+1) x union all
     select count(*) from (select id from public.chase_reservations limit v_limit+1) x union all
     select count(*) from (select reservation_id from public.chase_stock_evidence limit v_limit+1) x union all
     select count(*) from (select id from public.fans limit v_limit+1) x union all
     select count(*) from (select id from public.fan_passes limit v_limit+1) x
   ) bounded where n>v_limit
 ) then return jsonb_build_object('status','incomplete','counts','{}'::jsonb,'rowLimit',v_limit); end if;
 select jsonb_build_object(
   'codeStockMismatch',(select count(*) from public.prizes p left join lateral
       (select count(*) n from public.prize_reward_codes c where c.prize_id=p.id and c.spin_id is null and c.reserved_focus_id is null and c.erased_at is null and c.cipher is not null and c.iv is not null) free on true
     where p.delivery='codes' and p.stock is distinct from free.n),
   'heldReservationMismatch',(select count(*) from public.chase_reservations r left join public.fan_focus f on f.id=r.focus_id left join public.prizes p on p.id=r.prize_id left join public.wheels w on w.id=p.wheel_id
     where r.state='held' and (f.id is null or f.kind<>'chase' or f.status not in('active','paused') or f.creator_id<>r.creator_id or f.prize_id is distinct from r.prize_id or w.creator_id is distinct from r.creator_id)),
   'liveChaseMissingReservation',(select count(*) from public.fan_focus f left join public.chase_reservations r on r.focus_id=f.id
     where f.kind='chase' and f.status in('active','paused') and (r.id is null or r.state<>'held')),
   'heldCodeMismatch',(select count(*) from public.chase_reservations r left join public.prize_reward_codes c on c.id=r.code_id
     where r.state='held' and r.kind='code' and (c.id is null or c.creator_id<>r.creator_id or c.prize_id is distinct from r.prize_id or c.spin_id is not null or c.erased_at is not null or c.cipher is null or c.iv is null or c.reserved_focus_id is distinct from r.focus_id)),
   'orphanReservedCode',(select count(*) from public.prize_reward_codes c left join public.chase_reservations r on r.code_id=c.id and r.focus_id=c.reserved_focus_id and r.state='held'
     where c.reserved_focus_id is not null and (c.spin_id is not null or r.id is null or r.kind<>'code')),
   'unwitnessedStockReservation',(select count(*) from public.chase_reservations r left join public.chase_stock_evidence e on e.reservation_id=r.id left join public.prizes p on p.id=r.prize_id left join public.wheels w on w.id=p.wheel_id
     where r.state='held' and r.kind='stock' and (e.reservation_id is null or e.units_taken<>1 or e.creator_id<>r.creator_id or e.prize_id is distinct from r.prize_id or p.stock is null)),
   'fanCreditMismatch',(select count(*) from public.fans f left join lateral
      (select coalesce(sum(p.spins_remaining),0) balance from public.fan_passes p where p.fan_id=f.id) credit on true
     where f.spins_remaining::bigint<>credit.balance)
 ) into v_counts;
 select coalesce(sum(value::integer),0) into v_total from jsonb_each_text(v_counts);
 return jsonb_build_object('status',case when v_total=0 then 'healthy' else 'violations' end,'counts',v_counts,'rowLimit',v_limit);
end $$;
revoke execute on function public.run_reward_ledger_invariants(integer) from public,anon,authenticated;
grant execute on function public.run_reward_ledger_invariants(integer) to service_role;

create or replace function public.record_system_health_check(p_source text,p_canary_status text,p_invariants jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_counts jsonb:='{}'; v_row public.system_health_checks%rowtype;
begin
 if p_source is null or p_canary_status is null or p_source not in('startup','manual','maintenance') or p_canary_status not in('healthy','missing','configuration_missing','configuration_invalid','mismatch','unavailable') then raise exception 'invalid health result' using errcode='22023'; end if;
 if p_invariants is not null then
   v_status:=p_invariants->>'status'; v_counts:=p_invariants->'counts';
   if jsonb_typeof(p_invariants)<>'object' or v_status is null or v_status not in('healthy','violations','incomplete','unavailable') or v_counts is null or jsonb_typeof(v_counts)<>'object' or octet_length(v_counts::text)>4096 or
      exists(select 1 from jsonb_each_text(v_counts) e where e.key not in('codeStockMismatch','heldReservationMismatch','liveChaseMissingReservation','heldCodeMismatch','orphanReservedCode','unwitnessedStockReservation','fanCreditMismatch') or e.value!~'^[0-9]{1,10}$')
   then raise exception 'invalid invariant result' using errcode='22023'; end if;
   if v_status in('healthy','violations') and (
     (select count(*) from jsonb_object_keys(v_counts))<>7 or
     (v_status='healthy' and exists(select 1 from jsonb_each_text(v_counts) where value::numeric<>0)) or
     (v_status='violations' and not exists(select 1 from jsonb_each_text(v_counts) where value::numeric>0))
   ) then raise exception 'incomplete or inconsistent invariant result' using errcode='22023'; end if;
 end if;
 insert into public.system_health_checks(singleton,canary_status,canary_checked_at,canary_failure_at,invariants_status,invariant_counts,invariants_checked_at,last_maintenance_at,last_source)
 values(true,p_canary_status,now(),case when p_canary_status<>'healthy' then now() end,coalesce(v_status,'not_run'),v_counts,case when p_invariants is not null then now() end,case when p_source='maintenance' then now() end,p_source)
 on conflict(singleton) do update set
   canary_status=excluded.canary_status,canary_checked_at=excluded.canary_checked_at,
   canary_failure_at=case when p_canary_status<>'healthy' then now() when p_source='manual' then null else system_health_checks.canary_failure_at end,
   invariants_status=case when p_invariants is not null then excluded.invariants_status else system_health_checks.invariants_status end,
   invariant_counts=case when p_invariants is not null then excluded.invariant_counts else system_health_checks.invariant_counts end,
   invariants_checked_at=coalesce(excluded.invariants_checked_at,system_health_checks.invariants_checked_at),
   last_maintenance_at=coalesce(excluded.last_maintenance_at,system_health_checks.last_maintenance_at),last_source=excluded.last_source
 where p_source<>'startup' or system_health_checks.canary_status is distinct from excluded.canary_status or system_health_checks.canary_checked_at<now()-interval '5 minutes'
 returning * into v_row;
 if v_row.singleton is null then select * into v_row from public.system_health_checks where singleton; end if;
 return jsonb_build_object('canaryStatus',v_row.canary_status,'canaryCheckedAt',v_row.canary_checked_at,'canaryFailureAt',v_row.canary_failure_at,'invariantsStatus',v_row.invariants_status,'invariantCounts',v_row.invariant_counts,'invariantsCheckedAt',v_row.invariants_checked_at,'lastMaintenanceAt',v_row.last_maintenance_at);
end $$;
revoke execute on function public.record_system_health_check(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_system_health_check(text,text,jsonb) to service_role;
