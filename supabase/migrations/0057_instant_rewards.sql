-- 0057 Instant-delivery prizes (#26).
--
-- A prize can carry a digital reward that is revealed to the winner the moment
-- they win it, and its redemption is recorded as fulfilled automatically:
--   prizes.delivery     'manual' (today) | 'link' | 'text' | 'codes'. Not a
--                       secret: the creator's editor reads it; the fan-safe
--                       projection never sends it.
--   prize_rewards       one encrypted link or text per prize (link/text).
--   prize_reward_codes  a list of single-use encrypted codes per prize. A code
--                       is handed out at most once: spin_id is unique and a
--                       code is only ever assigned under its prize's row lock.
--   spin_rewards        what one winning spin received (a copy of the
--                       ciphertext, made in the same statement as the spin
--                       insert by trg_attach_spin_reward), plus how often the
--                       fan has viewed it. The fan's re-view reads only this.
--
-- Values are AES-256-GCM ciphertext made on the server with a key that never
-- leaves it (REWARD_ENCRYPTION_KEY). Nobody but the service role can read a
-- cipher or iv column: creators read only metadata (kind, hint, counts, views)
-- through column grants, anon reads nothing, and every write goes through the
-- server-only functions below (revoked from public, anon and authenticated).
--
-- Stock: for a code-list prize, prizes.stock IS the number of unused codes.
-- trg_sync_code_prize_stock recounts it on every write to the prize row, so the
-- editor, a hand edit or a stale save can't drift it, and the prize leaves the
-- wheel exactly when the codes run out. A spin reserves its code before the
-- spin row exists (reserve_reward_code, bound to the spin's pre-generated id),
-- and the spin insert itself refuses a code prize without a reserved code, so a
-- prize that can't be delivered is never awarded.

alter table public.prizes add column if not exists delivery text not null default 'manual'
  check (delivery in ('manual', 'link', 'text', 'codes'));

create table if not exists public.prize_rewards (
  prize_id    uuid primary key references public.prizes(id) on delete cascade,
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('link', 'text')),
  cipher      text not null check (char_length(cipher) <= 8192),
  iv          text not null check (char_length(iv) <= 64),
  key_version smallint not null default 1 check (key_version >= 1),
  updated_at  timestamptz not null default now()
);
create index if not exists prize_rewards_creator_idx on public.prize_rewards (creator_id);

create table if not exists public.prize_reward_codes (
  id          uuid primary key default gen_random_uuid(),
  prize_id    uuid not null references public.prizes(id) on delete cascade,
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  cipher      text check (char_length(cipher) <= 1024),
  iv          text check (char_length(iv) <= 64),
  erased_at   timestamptz,
  key_version smallint not null default 1 check (key_version >= 1),
  hint        text check (char_length(hint) <= 8),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  spin_id     uuid unique,
  assigned_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint prize_reward_codes_assignment check ((spin_id is null) = (assigned_at is null)),
  unique (prize_id, fingerprint),
  constraint prize_reward_codes_erasure check (
    (erased_at is null and cipher is not null and iv is not null) or
    (erased_at is not null and cipher is null and iv is null) and spin_id is not null and hint is null
  )
);
create index if not exists prize_reward_codes_free_idx
  on public.prize_reward_codes (prize_id, created_at) where spin_id is null;
create index if not exists prize_reward_codes_creator_idx on public.prize_reward_codes (creator_id);

create table if not exists public.spin_rewards (
  spin_id        uuid primary key references public.spins(id) on delete cascade,
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('link', 'text', 'code')),
  cipher         text check (char_length(cipher) <= 8192),
  iv             text check (char_length(iv) <= 64),
  erased_at   timestamptz,
  key_version    smallint not null default 1 check (key_version >= 1),
  code_id        uuid unique references public.prize_reward_codes(id) on delete set null,
  stock_after    integer,
  views          integer not null default 1 check (views >= 0),
  last_viewed_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint spin_rewards_erasure check (
    (erased_at is null and cipher is not null and iv is not null) or
    (erased_at is not null and cipher is null and iv is null)
  )
);
create index if not exists spin_rewards_creator_idx on public.spin_rewards (creator_id);
create index if not exists spins_reward_history_idx on public.spins (fan_id, created_at desc, share_id desc) where share_id is not null;

-- RLS: a creator (or a seat that may edit / view for them) reads its own
-- metadata rows; an admin reads all. No write policy exists, so even with
-- table privileges a session could not insert, update or delete a row.
alter table public.prize_rewards enable row level security;
drop policy if exists prize_rewards_select on public.prize_rewards;
create policy prize_rewards_select on public.prize_rewards for select
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

alter table public.prize_reward_codes enable row level security;
drop policy if exists prize_reward_codes_select on public.prize_reward_codes;
create policy prize_reward_codes_select on public.prize_reward_codes for select
  using (public.can_act_for(creator_id, 'edit_wheel') or public.is_admin());

alter table public.spin_rewards enable row level security;
drop policy if exists spin_rewards_select on public.spin_rewards;
create policy spin_rewards_select on public.spin_rewards for select
  using (public.can_act_for(creator_id, 'view') or public.is_admin());

-- Privileges: anon nothing; authenticated only the non-secret columns.
revoke all on table public.prize_rewards from anon, authenticated;
revoke all on table public.prize_reward_codes from anon, authenticated;
revoke all on table public.spin_rewards from anon, authenticated;
grant select (prize_id, creator_id, kind, key_version, updated_at) on table public.prize_rewards to authenticated;
grant select (id, prize_id, creator_id, key_version, hint, spin_id, assigned_at, created_at, erased_at) on table public.prize_reward_codes to authenticated;
grant select (spin_id, creator_id, kind, key_version, code_id, views, last_viewed_at, created_at, erased_at) on table public.spin_rewards to authenticated;

-- A code-list prize's stock is its unused-code count, whoever writes the row.
-- SECURITY DEFINER so the recount sees every code whatever the caller may read.
create or replace function public.sync_code_prize_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery = 'codes' then
    new.stock := (select count(*)::integer from public.prize_reward_codes c
                   where c.prize_id = new.id and c.spin_id is null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_code_prize_stock on public.prizes;
create trigger trg_sync_code_prize_stock
  before insert or update on public.prizes
  for each row execute function public.sync_code_prize_stock();

-- Copy the delivered reward onto the spin in the same statement as the spin
-- insert. A code prize without a code reserved for this spin, or a link/text
-- prize without its reward, fails the insert: the server then refunds the
-- spin, so an undeliverable prize is never awarded.
create or replace function public.attach_spin_reward()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.prize_reward_codes%rowtype;
  v_reward public.prize_rewards%rowtype;
  v_delivery text;
begin
  select * into v_code from public.prize_reward_codes where spin_id = new.id;
  if found then
    if v_code.prize_id is distinct from new.prize_id or v_code.creator_id <> new.creator_id then
      raise exception 'reward code belongs to another prize' using errcode = '23514';
    end if;
    insert into public.spin_rewards (spin_id, creator_id, kind, cipher, iv, key_version, code_id)
    values (new.id, new.creator_id, 'code', v_code.cipher, v_code.iv, v_code.key_version, v_code.id);
    return new;
  end if;
  if new.prize_id is null then
    return new;
  end if;
  select delivery into v_delivery from public.prizes where id = new.prize_id;
  if v_delivery = 'codes' then
    raise exception 'no reward code reserved for this spin' using errcode = '23514';
  elsif v_delivery in ('link', 'text') then
    if current_setting('fanfunnel.reward_finalization', true) is distinct from new.id::text then
      raise exception 'instant prize must be finalized atomically' using errcode = '23514';
    end if;
    select * into v_reward from public.prize_rewards where prize_id = new.prize_id;
    if not found or v_reward.creator_id <> new.creator_id then
      raise exception 'instant prize has no reward' using errcode = '23514';
    end if;
    insert into public.spin_rewards (spin_id, creator_id, kind, cipher, iv, key_version)
    values (new.id, new.creator_id, v_reward.kind, v_reward.cipher, v_reward.iv, v_reward.key_version);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attach_spin_reward on public.spins;
create trigger trg_attach_spin_reward
  after insert on public.spins
  for each row execute function public.attach_spin_reward();

-- Server-only: take one unused code of a code-list prize for the spin that is
-- about to be recorded (its id is generated by the server first). Every change
-- to a prize's code pool locks the prize row, so concurrent spins queue here
-- and no two can take the same code. No row back = no code left (sold out).
create or replace function public.reserve_reward_code(p_prize uuid, p_spin uuid)
returns table (code_id uuid, code_cipher text, code_iv text, code_key_version smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.prize_reward_codes%rowtype;
begin
  if p_prize is null or p_spin is null then
    return;
  end if;
  perform 1 from public.prizes where id = p_prize and delivery = 'codes' for update;
  if not found then
    return;
  end if;
  select * into v_code from public.prize_reward_codes c
   where c.prize_id = p_prize and c.spin_id is null
   order by c.created_at, c.id
   limit 1;
  if found then
    update public.prize_reward_codes set spin_id = p_spin, assigned_at = now() where id = v_code.id;
  end if;
  -- Recount stock (trg_sync_code_prize_stock), also when nothing was left.
  update public.prizes set stock = stock where id = p_prize;
  if v_code.id is not null then
    return query select v_code.id, v_code.cipher, v_code.iv, v_code.key_version;
  end if;
end;
$$;

-- Server-only: give back the code reserved for a spin that was never recorded
-- (the spin failed after the reservation). A code whose spin row exists was
-- delivered and is never handed out again.
create or replace function public.release_reward_code(p_spin uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prize uuid;
begin
  select prize_id into v_prize from public.prize_reward_codes where spin_id = p_spin and erased_at is null;
  if v_prize is null then
    return false;
  end if;
  perform 1 from public.prizes where id = v_prize for update;
  if exists (select 1 from public.spins where id = p_spin) then
    return false;
  end if;
  update public.prize_reward_codes set spin_id = null, assigned_at = null where spin_id = p_spin;
  update public.prizes set stock = stock where id = v_prize;
  return true;
end;
$$;

-- Server-only: append encrypted codes to a prize on one of p_creator's wheels
-- and make it a code-list prize, in one transaction. Returns the codes left.
-- p_codes: [{ "cipher": text, "iv": text, "key_version": int, "hint": text|null }].
create or replace function public.add_reward_codes(p_prize uuid, p_creator uuid, p_codes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left integer;
  v_new integer;
  v_added integer;
begin
  perform 1 from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = p_prize and w.creator_id = p_creator
   for update of p;
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

-- Server-only: set a prize on one of p_creator's wheels to manual, an
-- encrypted link or an encrypted text. Leaving a code list discards its unused
-- codes; the prize keeps its current stock as an ordinary limit.
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
begin
  if p_kind is null or p_kind not in ('manual', 'link', 'text') then
    raise exception 'invalid delivery' using errcode = '22023';
  end if;
  perform 1 from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = p_prize and w.creator_id = p_creator
   for update of p;
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

-- Server-only: the fan re-opened their reward (the spin's owner is checked by
-- the server route first). Returns the new view count.
create or replace function public.record_reward_view(p_spin uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.spin_rewards
     set views = views + 1, last_viewed_at = now()
   where spin_id = p_spin and erased_at is null
  returning views;
$$;

revoke execute on function public.reserve_reward_code(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_reward_code(uuid, uuid) to service_role;
revoke execute on function public.release_reward_code(uuid) from public, anon, authenticated;
grant execute on function public.release_reward_code(uuid) to service_role;
revoke execute on function public.add_reward_codes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_reward_codes(uuid, uuid, jsonb) to service_role;
revoke execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) from public, anon, authenticated;
grant execute on function public.set_prize_delivery(uuid, uuid, text, text, text, smallint) to service_role;
revoke execute on function public.record_reward_view(uuid) from public, anon, authenticated;
grant execute on function public.record_reward_view(uuid) to service_role;

-- Instant wins finalize in one transaction. The caller has already decrypted
-- exactly p_expected; a changed code/value is retried without changing odds.
-- A retry after an HTTP timeout uses the same spin id and recovers its receipt.
create or replace function public.finalize_reward_spin(p_spin jsonb, p_expected jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_input public.spins%rowtype;
  v_existing public.spins%rowtype;
  v_prize public.prizes%rowtype;
  v_code public.prize_reward_codes%rowtype;
  v_reward public.prize_rewards%rowtype;
  v_receipt public.spin_rewards%rowtype;
  v_pass uuid;
begin
  select * into v_input from jsonb_populate_record(null::public.spins, p_spin);
  if v_input.id is null or v_input.fan_pass_id is null or v_input.creator_id is null or v_input.fan_id is null then
    raise exception 'invalid spin identity' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_input.id::text, 57));
  select * into v_existing from public.spins where id = v_input.id;
  if found then
    if v_existing.creator_id is distinct from v_input.creator_id or v_existing.fan_id is distinct from v_input.fan_id
       or v_existing.fan_pass_id is distinct from v_input.fan_pass_id then
      raise exception 'spin identity conflict' using errcode = '42501';
    end if;
    select * into v_receipt from public.spin_rewards where spin_id = v_existing.id;
    return jsonb_build_object('status', 'recorded', 'id', v_existing.id, 'shareId', v_existing.share_id,
      'reward', jsonb_build_object('kind', v_receipt.kind, 'cipher', v_receipt.cipher, 'iv', v_receipt.iv, 'keyVersion', v_receipt.key_version),
      'stockAfter', v_receipt.stock_after);
  end if;

  -- Match the existing claim lock order, then serialize prize edits/allocations.
  perform 1 from public.fans where id = v_input.fan_id for update;
  select fp.id into v_pass from public.fan_passes fp
    join public.fans f on f.id = fp.fan_id
    join public.profiles c on c.id = fp.creator_id
   where fp.id = v_input.fan_pass_id and fp.fan_id = v_input.fan_id and fp.creator_id = v_input.creator_id
     and fp.is_active and fp.self_excluded_at is null and f.blocked_at is null
     and (f.break_until is null or f.break_until <= now()) and c.is_active
   for update of fp;
  if v_pass is null then raise exception 'spin link is not active' using errcode = '42501'; end if;
  select p.* into v_prize from public.prizes p join public.wheels w on w.id = p.wheel_id
   where p.id = v_input.prize_id and p.wheel_id = v_input.wheel_id and w.creator_id = v_input.creator_id for update of p;
  if not found then return jsonb_build_object('status', 'sold_out'); end if;
  if v_prize.delivery is distinct from p_expected->>'delivery' then return jsonb_build_object('status', 'changed'); end if;

  if v_prize.delivery = 'codes' then
    select * into v_code from public.prize_reward_codes
     where id = (p_expected->>'codeId')::uuid and prize_id = v_prize.id and spin_id is null;
    if not found then
      if exists (select 1 from public.prize_reward_codes where prize_id = v_prize.id and spin_id is null) then
        return jsonb_build_object('status', 'retry');
      end if;
      return jsonb_build_object('status', 'sold_out');
    end if;
    if v_code.cipher is distinct from p_expected->>'cipher' or v_code.iv is distinct from p_expected->>'iv'
       or v_code.key_version is distinct from (p_expected->>'keyVersion')::smallint then
      return jsonb_build_object('status', 'retry');
    end if;
    update public.prize_reward_codes set spin_id = v_input.id, assigned_at = now() where id = v_code.id;
    update public.prizes set stock = stock where id = v_prize.id;
  elsif v_prize.delivery in ('link', 'text') then
    select * into v_reward from public.prize_rewards where prize_id = v_prize.id;
    if not found then return jsonb_build_object('status', 'unavailable'); end if;
    if v_reward.kind is distinct from p_expected->>'delivery' or v_reward.cipher is distinct from p_expected->>'cipher'
       or v_reward.iv is distinct from p_expected->>'iv' or v_reward.key_version is distinct from (p_expected->>'keyVersion')::smallint then
      return jsonb_build_object('status', 'retry');
    end if;
    if v_prize.stock is not null then
      if v_prize.stock <= 0 then return jsonb_build_object('status', 'sold_out'); end if;
      update public.prizes set stock = stock - 1 where id = v_prize.id;
    end if;
  else
    return jsonb_build_object('status', 'changed');
  end if;

  perform set_config('fanfunnel.reward_finalization', v_input.id::text, true);
  insert into public.spins (
    id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity, prize_image_url,
    campaign_id, server_seed, server_seed_hash, nonce, client_seed, seed_commitment,
    fair_version, pool_snapshot, pool_hash, fair_trace
  ) values (
    v_input.id, v_input.fan_pass_id, v_input.creator_id, v_input.wheel_id, v_input.fan_id, v_input.prize_id,
    v_input.prize_label, v_input.prize_rarity, v_input.prize_image_url, v_input.campaign_id,
    v_input.server_seed, v_input.server_seed_hash, v_input.nonce, v_input.client_seed, v_input.seed_commitment,
    v_input.fair_version, v_input.pool_snapshot, v_input.pool_hash, v_input.fair_trace
  ) returning * into v_existing;
  insert into public.redemptions (spin_id, creator_id, status, fulfilled_at)
  values (v_existing.id, v_existing.creator_id, 'fulfilled', now());
  update public.spin_rewards set stock_after = (select stock from public.prizes where id = v_existing.prize_id) where spin_id = v_existing.id;
  select * into v_receipt from public.spin_rewards where spin_id = v_existing.id;
  return jsonb_build_object('status', 'recorded', 'id', v_existing.id, 'shareId', v_existing.share_id,
    'reward', jsonb_build_object('kind', v_receipt.kind, 'cipher', v_receipt.cipher, 'iv', v_receipt.iv, 'keyVersion', v_receipt.key_version),
    'stockAfter', v_receipt.stock_after);
end;
$$;
revoke execute on function public.finalize_reward_spin(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_reward_spin(jsonb, jsonb) to service_role;

-- A delivered secret cannot be undone by changing a queue status or due date,
-- including direct requests through the creator's RLS-scoped database client.
create or replace function public.guard_delivered_redemption()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.spin_rewards where spin_id = new.spin_id) then
    if new.status <> 'fulfilled' or new.fulfilled_at is null or new.due_at is not null then
      raise exception 'instant reward is already delivered' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_delivered_redemption on public.redemptions;
create trigger trg_guard_delivered_redemption before insert or update of status, fulfilled_at, due_at on public.redemptions
  for each row execute function public.guard_delivered_redemption();


-- Erasure removes delivered values, preserving only anonymous fulfilment
-- metadata and a keyed consumed-code tombstone so an exposed coupon is never
-- restocked or re-uploaded as a fresh code. The trigger runs before0054's
-- ON DELETE SET NULL actions remove the fan association from retained spins.
create or replace function public.scrub_fan_reward_values(p_fan uuid)
returns void
language sql
security definer set search_path = public
as $$
  update public.prize_reward_codes c
     set cipher = null, iv = null, hint = null, erased_at = now()
    from public.spins s where s.id = c.spin_id and s.fan_id = p_fan;
  update public.spin_rewards r
     set cipher = null, iv = null, erased_at = now()
    from public.spins s where s.id = r.spin_id and s.fan_id = p_fan;
$$;
revoke execute on function public.scrub_fan_reward_values(uuid) from public, anon, authenticated, service_role;

create or replace function public.erase_fan_reward_values()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.scrub_fan_reward_values(old.id);
  return old;
end;
$$;
drop trigger if exists trg_erase_fan_reward_values on public.fans;
create trigger trg_erase_fan_reward_values before delete on public.fans
  for each row execute function public.erase_fan_reward_values();


-- Re-check the live token on the view write, so deletion/pause/block races
-- between the first lookup and decryption cannot disclose an invalidated win.
create or replace function public.record_fan_reward_view(p_spin uuid, p_token text)
returns integer
language sql
security definer set search_path = public
as $$
  update public.spin_rewards r set views = r.views + 1, last_viewed_at = now()
    from public.spins s
    join public.fan_passes fp on fp.fan_id = s.fan_id and fp.creator_id = s.creator_id
    join public.fans f on f.id = fp.fan_id
    join public.profiles c on c.id = fp.creator_id
   where r.spin_id = p_spin and s.id = r.spin_id and fp.token = p_token
     and fp.is_active and fp.self_excluded_at is null and f.blocked_at is null and c.is_active
     and r.erased_at is null
  returning r.views;
$$;
revoke execute on function public.record_fan_reward_view(uuid, text) from public, anon, authenticated;
grant execute on function public.record_fan_reward_view(uuid, text) to service_role;

-- Prize replacement must not cascade away encrypted rewards before a failing
-- insert. Keep this set in one transaction, retaining ids owned by this wheel.
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
    insert into public.prizes (id,wheel_id,label,description,rarity,weight,color,emoji,image_url,cost_cents,stock,sort_order)
    values(v_id,p_wheel,v_row->>'label',v_row->>'description',(v_row->>'rarity')::public.prize_rarity,
      (v_row->>'weight')::integer,v_row->>'color',v_row->>'emoji',v_row->>'image_url',
      (v_row->>'cost_cents')::integer,(v_row->>'stock')::integer,v_order)
    on conflict(id) do update set label=excluded.label,description=excluded.description,rarity=excluded.rarity,
      weight=excluded.weight,color=excluded.color,emoji=excluded.emoji,image_url=excluded.image_url,
      cost_cents=excluded.cost_cents,stock=excluded.stock,sort_order=excluded.sort_order;
    v_ids := array_append(v_ids,v_id);
    v_order := v_order + 1;
  end loop;
  delete from public.prizes where wheel_id=p_wheel and not(id=any(v_ids));
end;
$$;
revoke execute on function public.save_wheel_prizes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_wheel_prizes(uuid, uuid, jsonb) to service_role;
