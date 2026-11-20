-- 0058 Per-creator theming: headline font, page background and a photo hub
-- (owner decisions D12: per creator, the brand colour stays per wheel; D13:
-- SFW-only everywhere, the creator attests each photo, fans can report it).
--
-- profiles.theme holds the creator's look as allow-listed KEYS only:
--   {"font": <font key>, "background": <preset key>, "bg_media_id": <uuid>}
-- never a URL, colour or CSS string. The app maps each key to a self-hosted
-- font and a computed, contrast-checked background (src/lib/creatorTheme/).
-- profiles UPDATE is admin-only (AGENTS.md rule 6), so the creator writes it
-- through set_creator_theme(), which validates every key against the same
-- allow-list, accepts a background photo only from the caller's OWN media,
-- writes auth.uid()'s active row only, and is not executable by anon (0044).
--
-- creator_media is the photo hub: one row per re-encoded WebP in the
-- `creator-media` bucket. Rows are inserted ONLY by the upload route with the
-- service role, after it has sniffed, size-checked and re-encoded the file
-- (no insert policy or grant for any client role). The creator may change a
-- photo's caption and order (column-level grant) and delete it, on their own
-- rows only, while active; an admin may delete any (moderation: "Remove
-- photos" on the account row). The path is pinned to "<creator_id>/<uuid>.webp".
-- A trigger caps the hub at 12 photos, and deleting the photo the theme uses
-- as its background drops the theme back to the default background.
--
-- The bucket is public-read (fan and link-in-bio pages show the photos) with
-- no storage.objects policy for it at all, so no client can write, overwrite
-- or delete an object directly; it only accepts WebP up to 2 MB.

alter table public.profiles
  add column if not exists theme jsonb not null default '{}'::jsonb
    check (jsonb_typeof(theme) = 'object');

create table if not exists public.creator_media (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles(id) on delete cascade,
  path            text not null unique,
  caption         text check (caption is null or char_length(caption) <= 140),
  sort_order      integer not null default 0,
  width           integer not null check (width between 1 and 1600),
  height          integer not null check (height between 1 and 1600),
  sfw_attested_at timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint creator_media_path_shape check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
    and split_part(path, '/', 1) = creator_id::text
  )
);
create index if not exists creator_media_creator_idx
  on public.creator_media (creator_id, sort_order, created_at);

alter table public.creator_media enable row level security;

drop policy if exists creator_media_select on public.creator_media;
create policy creator_media_select on public.creator_media for select
  using ((public.can_act_for(creator_id, 'view') and public.current_user_active()) or public.is_admin());

drop policy if exists creator_media_update on public.creator_media;
create policy creator_media_update on public.creator_media for update
  using (creator_id = auth.uid() and public.current_user_active())
  with check (creator_id = auth.uid() and public.current_user_active());

drop policy if exists creator_media_delete on public.creator_media;
create policy creator_media_delete on public.creator_media for delete
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

-- Anon never touches the table. A signed-in creator may read (RLS), delete
-- (RLS) and change only the caption and order; never insert, and never move a
-- row's path, owner, size or attestation.
revoke all on table public.creator_media from anon;
revoke insert, update on table public.creator_media from authenticated;
grant update (caption, sort_order) on table public.creator_media to authenticated;

create or replace function public.creator_media_cap()
returns trigger language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('creator_media:' || new.creator_id::text));
  if (select count(*) from public.creator_media where creator_id = new.creator_id) >= 12 then
    raise exception 'creator media limit reached' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists creator_media_cap on public.creator_media;
create trigger creator_media_cap before insert on public.creator_media
  for each row execute function public.creator_media_cap();

create or replace function public.creator_media_unset_background()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set theme = (theme - 'bg_media_id') || jsonb_build_object('background', 'glow')
   where id = old.creator_id and theme ->> 'bg_media_id' = old.id::text;
  return old;
end;
$$;

drop trigger if exists creator_media_unset_background on public.creator_media;
create trigger creator_media_unset_background after delete on public.creator_media
  for each row execute function public.creator_media_unset_background();

create or replace function public.set_creator_theme(p_theme jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_font text := 'bricolage';
  v_bg text := 'glow';
  v_media uuid;
  v_out jsonb;
begin
  if p_theme is null or jsonb_typeof(p_theme) <> 'object' then
    raise exception 'invalid theme' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_theme) as k(key)
     where k.key not in ('font', 'background', 'bg_media_id')
  ) then
    raise exception 'invalid theme key' using errcode = '22023';
  end if;
  if p_theme ? 'font' then
    if jsonb_typeof(p_theme -> 'font') <> 'string'
       or (p_theme ->> 'font') not in ('bricolage', 'playfair', 'dm-serif', 'syne', 'fraunces', 'unbounded') then
      raise exception 'invalid theme font' using errcode = '22023';
    end if;
    v_font := p_theme ->> 'font';
  end if;
  if p_theme ? 'background' then
    if jsonb_typeof(p_theme -> 'background') <> 'string'
       or (p_theme ->> 'background') not in ('glow', 'velvet', 'noir', 'aurora', 'solid', 'photo') then
      raise exception 'invalid theme background' using errcode = '22023';
    end if;
    v_bg := p_theme ->> 'background';
  end if;
  if v_bg = 'photo' then
    if jsonb_typeof(p_theme -> 'bg_media_id') is distinct from 'string'
       or (p_theme ->> 'bg_media_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
    v_media := (p_theme ->> 'bg_media_id')::uuid;
    if not exists (
      select 1 from public.creator_media m where m.id = v_media and m.creator_id = auth.uid()
    ) then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
  elsif p_theme ? 'bg_media_id' and jsonb_typeof(p_theme -> 'bg_media_id') <> 'null' then
    raise exception 'invalid theme photo' using errcode = '22023';
  end if;

  v_out := jsonb_build_object('font', v_font, 'background', v_bg);
  if v_media is not null then
    v_out := v_out || jsonb_build_object('bg_media_id', v_media);
  end if;
  update public.profiles set theme = v_out where id = auth.uid() and is_active = true;
  if not found then
    return null;
  end if;
  return v_out;
end;
$$;

revoke execute on function public.set_creator_theme(jsonb) from public, anon;
grant execute on function public.set_creator_theme(jsonb) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creator-media', 'creator-media', true, 2097152, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 0058 storage durability tail. Requires the integrated 0054–0056 foundation.
-- Client DELETE would discard the retry path before storage is removed.
-- All photo removal now goes through the authorized durable server queue.
revoke delete on table public.creator_media from public, anon, authenticated;

-- These records deliberately have no auth/profile/media FK: retries must
-- survive an auth cascade. Paths are random names, never credentials/tokens.
create table if not exists public.creator_storage_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  bucket text not null check (bucket in ('avatars', 'creator-media')),
  path text not null,
  upload_state text not null check (upload_state in ('inflight', 'stored', 'rejected', 'uncertain')),
  cleanup_kind text not null default 'none' check (cleanup_kind in ('none', 'orphan', 'media', 'account')),
  media_id uuid,
  audit_actor uuid,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  published_at timestamptz,
  removed_at timestamptz,
  unique (bucket, path),
  constraint creator_storage_object_scope check (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|jpeg|gif|webp|avif)$'
    and split_part(path, '/', 1) = owner_id::text
  )
);
create index if not exists creator_storage_objects_work_idx on public.creator_storage_objects (cleanup_kind, updated_at) where removed_at is null;
create index if not exists creator_storage_objects_owner_idx on public.creator_storage_objects (owner_id);
alter table public.creator_storage_objects enable row level security;
drop policy if exists creator_storage_objects_read on public.creator_storage_objects;
create policy creator_storage_objects_read on public.creator_storage_objects for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
revoke all on table public.creator_storage_objects from public, anon, authenticated;
grant select on table public.creator_storage_objects to authenticated;
grant all on table public.creator_storage_objects to service_role;

create table if not exists public.creator_storage_deletions (
  owner_id uuid primary key,
  id uuid not null unique default gen_random_uuid(),
  state text not null check (state in ('pending', 'auth_deleting', 'auth_deleted', 'complete', 'paused')),
  was_role text not null check (was_role in ('admin', 'creator')),
  was_active boolean not null,
  actor_id uuid,
  action text not null check (action in ('account.delete', 'account.self_close')),
  link_hashes jsonb not null default '[]'::jsonb check (jsonb_typeof(link_hashes) = 'array' and jsonb_array_length(link_hashes) <= 100000)
    check (link_hashes::text ~ '^\[("[0-9a-f]{64}"(, "[0-9a-f]{64}")*)?\]$'),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists creator_storage_deletions_work_idx on public.creator_storage_deletions (state, updated_at);
alter table public.creator_storage_deletions enable row level security;
drop policy if exists creator_storage_deletions_read on public.creator_storage_deletions;
create policy creator_storage_deletions_read on public.creator_storage_deletions for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
revoke all on table public.creator_storage_deletions from public, anon, authenticated;
grant select on table public.creator_storage_deletions to authenticated;
grant all on table public.creator_storage_deletions to service_role;

-- Recheck eligibility under the same owner lock at the media-row write too.
-- This closes the upload-publication -> service INSERT quiescence race.
create or replace function public.creator_media_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_active boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || new.creator_id::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_active
    from public.profiles where id = new.creator_id for update;
  if v_active is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = new.creator_id and state not in ('paused', 'complete')) then
    raise exception 'creator media forbidden' using errcode = '42501';
  end if;
  if (select count(*) from public.creator_media where creator_id = new.creator_id) >= 12 then
    raise exception 'creator media limit reached' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke execute on function public.creator_media_cap() from public, anon, authenticated;
grant execute on function public.creator_media_cap() to service_role;
revoke execute on function public.creator_media_unset_background() from public, anon, authenticated;
grant execute on function public.creator_media_unset_background() to service_role;
grant all on table public.creator_media to service_role;

-- The new setter must retain0056's active/approval predicate.
create or replace function public.set_creator_theme(p_theme jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_font text := 'bricolage';
  v_bg text := 'glow';
  v_media uuid;
  v_out jsonb;
begin
  if p_theme is null or jsonb_typeof(p_theme) <> 'object' then
    raise exception 'invalid theme' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_theme) as k(key)
     where k.key not in ('font', 'background', 'bg_media_id')
  ) then
    raise exception 'invalid theme key' using errcode = '22023';
  end if;
  if p_theme ? 'font' then
    if jsonb_typeof(p_theme -> 'font') <> 'string'
       or (p_theme ->> 'font') not in ('bricolage', 'playfair', 'dm-serif', 'syne', 'fraunces', 'unbounded') then
      raise exception 'invalid theme font' using errcode = '22023';
    end if;
    v_font := p_theme ->> 'font';
  end if;
  if p_theme ? 'background' then
    if jsonb_typeof(p_theme -> 'background') <> 'string'
       or (p_theme ->> 'background') not in ('glow', 'velvet', 'noir', 'aurora', 'solid', 'photo') then
      raise exception 'invalid theme background' using errcode = '22023';
    end if;
    v_bg := p_theme ->> 'background';
  end if;
  if v_bg = 'photo' then
    if jsonb_typeof(p_theme -> 'bg_media_id') is distinct from 'string'
       or (p_theme ->> 'bg_media_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
    v_media := (p_theme ->> 'bg_media_id')::uuid;
    if not exists (
      select 1 from public.creator_media m where m.id = v_media and m.creator_id = auth.uid()
    ) then
      raise exception 'invalid theme photo' using errcode = '22023';
    end if;
  elsif p_theme ? 'bg_media_id' and jsonb_typeof(p_theme -> 'bg_media_id') <> 'null' then
    raise exception 'invalid theme photo' using errcode = '22023';
  end if;

  v_out := jsonb_build_object('font', v_font, 'background', v_bg);
  if v_media is not null then
    v_out := v_out || jsonb_build_object('bg_media_id', v_media);
  end if;
  update public.profiles set theme = v_out where id = auth.uid() and is_active = true and public.current_user_active();
  if not found then
    return null;
  end if;
  return v_out;
end;
$$;

revoke execute on function public.set_creator_theme(jsonb) from public, anon;
grant execute on function public.set_creator_theme(jsonb) to authenticated;

alter table public.creator_storage_objects add column if not exists upload_registered boolean not null default false;

create or replace function public.creator_storage_register_upload(p_id uuid, p_owner uuid, p_bucket text, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok
    from public.profiles where id = p_owner for update;
  if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](webp|png|jpg|jpeg|gif)$' or v_ok is distinct from true or exists (select 1 from public.creator_storage_deletions where owner_id = p_owner and state not in ('paused', 'complete')) then
    raise exception 'creator upload forbidden' using errcode = '42501';
  end if;
  -- A duplicate registration never grants permission to launch another upload
  -- to the same immutable path. Retries create a fresh, separately tracked id.
  insert into public.creator_storage_objects (id, owner_id, bucket, path, upload_state,upload_registered)
    values (p_id, p_owner, p_bucket, p_path, 'inflight',true);
  return jsonb_build_object('id', p_id, 'registered', true);
end; $$;

create or replace function public.creator_storage_finish_upload(p_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_ok boolean; v_object public.creator_storage_objects%rowtype;
begin
  if p_outcome not in ('stored', 'rejected', 'uncertain', 'cleanup', 'publish') then raise exception 'invalid upload outcome' using errcode = '22023'; end if;
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then raise exception 'upload intent missing' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = v_owner for update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  v_ok := coalesce(v_ok, false) and v_object.expires_at > now() and not exists (select 1 from public.creator_storage_deletions where owner_id = v_owner and state not in ('paused', 'complete'));
  update public.creator_storage_objects set
    upload_state = case when upload_state in ('stored', 'rejected') or p_outcome in ('cleanup', 'publish') then upload_state else p_outcome end,
    settled_at = case when p_outcome in ('stored', 'rejected') then coalesce(settled_at, now()) else settled_at end,
    cleanup_kind = case when cleanup_kind = 'none' and (not v_ok or p_outcome in ('rejected', 'uncertain', 'cleanup')) then 'orphan' else cleanup_kind end,
    media_id = case when p_outcome='cleanup' then coalesce(media_id,(select m.id from public.creator_media m where m.creator_id=creator_storage_objects.owner_id and m.path=creator_storage_objects.path)) else media_id end,
    updated_at = now()
    where id = p_id returning * into v_object;
  v_ok := v_ok and v_object.upload_state = 'stored' and v_object.cleanup_kind = 'none' and v_object.removed_at is null;
  if p_outcome = 'publish' and v_ok then update public.creator_storage_objects set published_at = coalesce(published_at, now()) where id = p_id; end if;
  return v_ok;
end; $$;

create or replace function public.creator_storage_queue_remove(p_owner uuid, p_objects jsonb, p_actor uuid default null, p_admin boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_ok boolean; v_count integer := 0;
begin
  if jsonb_typeof(p_objects) is distinct from 'array' or jsonb_array_length(p_objects) not between 1 and 12 then raise exception 'invalid removal batch' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select is_active and (approval_status = 'approved' or role = 'admin') into v_ok from public.profiles where id = p_owner for update;
  if p_admin then
    if not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active) then raise exception 'admin required' using errcode = '42501'; end if;
  elsif v_ok is distinct from true or p_actor is distinct from p_owner then raise exception 'creator removal forbidden' using errcode = '42501'; end if;
  for v_item in select value from jsonb_array_elements(p_objects) loop
    if not exists (select 1 from public.creator_media where id = (v_item ->> 'id')::uuid and creator_id = p_owner and path = v_item ->> 'path') then raise exception 'media scope mismatch' using errcode = '42501'; end if;
    insert into public.creator_storage_objects (owner_id, bucket, path, upload_state, cleanup_kind, media_id, audit_actor, settled_at)
      values (p_owner, 'creator-media', v_item ->> 'path', 'stored', 'media', (v_item ->> 'id')::uuid, case when p_admin then p_actor else null end, now())
      on conflict (bucket, path) do update set
        cleanup_kind = 'media', media_id = excluded.media_id, removed_at = null,
        audit_actor = coalesce(public.creator_storage_objects.audit_actor, excluded.audit_actor),
        upload_state = 'stored', settled_at = coalesce(public.creator_storage_objects.settled_at, now()), updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

create or replace function public.creator_storage_complete_remove(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype;
begin
  select owner_id into v_owner from public.creator_storage_objects where id = p_id;
  if v_owner is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || v_owner::text, 0));
  perform id from public.profiles where id = v_owner for update;
  select * into v_object from public.creator_storage_objects where id = p_id for update;
  if v_object.cleanup_kind = 'none' or v_object.upload_state not in ('stored', 'rejected') then return false; end if;
  if v_object.removed_at is not null then return true; end if;
  if v_object.media_id is not null then
    delete from public.creator_media where id = v_object.media_id and creator_id = v_object.owner_id and path = v_object.path;
  end if;
  update public.creator_storage_objects set removed_at = now(), updated_at = now(), last_error = null where id = p_id;
  if v_object.audit_actor is not null then
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_object.id, v_object.audit_actor, 'account.media_remove', 'profile', v_object.owner_id, jsonb_build_object('photosRemoved', 1))
      on conflict (id) do nothing;
  end if;
  return true;
end; $$;

-- Every external destructive call has a durable immutable dispatch record.
alter table public.creator_storage_objects add column if not exists deletion_attempt uuid;
alter table public.creator_storage_objects add column if not exists last_attempt_at timestamptz;
alter table public.creator_storage_objects add column if not exists next_attempt_at timestamptz not null default now();
alter table public.creator_storage_deletions add column if not exists attempt_id uuid not null default gen_random_uuid();
alter table public.creator_storage_deletions add column if not exists restore_allowed boolean not null default true;

-- A later security decision must survive a failed deletion. UPDATE OF counts
-- even an admin's same-value is_active=false write while this account is already
-- quiesced. Only the service-owned job holds the restoration fence; client GUCs,
-- editable metadata and profile values cannot re-arm it. Profile UPDATE has
-- already locked its row before this trigger locks the job (the account worker
-- uses the same profile -> job order).
create or replace function public.creator_storage_security_write()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_pending boolean;
begin
 select state in ('pending','auth_deleting','auth_deleted') into v_pending
  from public.creator_storage_deletions where owner_id=new.id for update;
 if coalesce(v_pending,false) then
  if new.is_active then
   raise exception 'account cleanup pending' using errcode='42501';
  end if;
  update public.creator_storage_deletions set restore_allowed=false where owner_id=new.id;
 end if;
 return new;
end; $$;
revoke execute on function public.creator_storage_security_write() from public,anon,authenticated;
grant execute on function public.creator_storage_security_write() to service_role;
drop trigger if exists creator_storage_security_write on public.profiles;
create trigger creator_storage_security_write before update of role,is_active,approval_status on public.profiles
 for each row execute function public.creator_storage_security_write();


create table if not exists public.creator_storage_dispatches (
 id uuid primary key,
 owner_id uuid not null,
 attempt_id uuid,
 worker_id uuid,
 kind text not null check (kind in ('remove','auth','manifest')),
 object_id uuid,
 bucket text check (bucket in ('avatars','creator-media')),
 path text,
 state text not null default 'pending' check (state in ('pending','acknowledged','rejected','uncertain')),
 created_at timestamptz not null default now(),
 settled_at timestamptz,
 constraint creator_storage_dispatch_scope check (
   (kind='auth' and object_id is null and bucket is null and path is null and attempt_id is not null) or
   (kind in ('remove','manifest') and object_id is not null and bucket is not null and path is not null and split_part(path,'/',1)=owner_id::text)
 )
);
create unique index if not exists creator_storage_manifest_item_idx on public.creator_storage_dispatches(attempt_id,object_id) where kind='manifest';
create index if not exists creator_storage_dispatches_owner_idx on public.creator_storage_dispatches(owner_id,state);
alter table public.creator_storage_dispatches enable row level security;
drop policy if exists creator_storage_dispatches_read on public.creator_storage_dispatches;
create policy creator_storage_dispatches_read on public.creator_storage_dispatches for select to authenticated
 using (owner_id=auth.uid() or public.is_admin());
revoke all on public.creator_storage_dispatches from public, anon, authenticated;
grant select on public.creator_storage_dispatches to authenticated;
grant all on public.creator_storage_dispatches to service_role;

-- Registration remains UUID/immutable; a fenced manifest also records older
-- safe nested/replaced paths that predate the upload-intent protocol.
alter table public.creator_storage_objects drop constraint if exists creator_storage_object_scope;
alter table public.creator_storage_objects add constraint creator_storage_object_scope check (
 split_part(path,'/',1)=owner_id::text and length(path)<=2048 and
 path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$' and
 path !~ '(^|/)[.]{1,2}(/|$)'
);

create or replace function public.creator_storage_manifest(p_owner uuid,p_attempt uuid,p_worker uuid,p_bucket text,p_paths jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_job public.creator_storage_deletions%rowtype; v_path text; v_count integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||p_owner::text,0));
 select * into v_job from public.creator_storage_deletions where owner_id=p_owner for update;
 if v_job.attempt_id is distinct from p_attempt or v_job.lease_id is distinct from p_worker or v_job.lease_until<=now() or
    v_job.state not in ('pending','auth_deleting') or exists(select 1 from public.profiles where id=p_owner and is_active) then return null; end if;
 if p_bucket not in ('avatars','creator-media') or jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths)>100 then raise exception 'invalid manifest' using errcode='22023'; end if;
 for v_path in select jsonb_array_elements_text(p_paths) loop
  insert into public.creator_storage_objects(owner_id,bucket,path,upload_state,cleanup_kind,settled_at,deletion_attempt,media_id)
   values(p_owner,p_bucket,v_path,'stored','account',now(),p_attempt,(select id from public.creator_media where creator_id=p_owner and path=v_path))
   on conflict(bucket,path) do update set cleanup_kind='account',deletion_attempt=p_attempt,upload_state='stored',settled_at=coalesce(public.creator_storage_objects.settled_at,now()),removed_at=null,updated_at=now()
   where public.creator_storage_objects.owner_id=p_owner;
  if not found then raise exception 'manifest scope mismatch' using errcode='42501'; end if;
  insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind,object_id,bucket,path,state,settled_at)
   select gen_random_uuid(),p_owner,p_attempt,p_worker,'manifest',id,bucket,path,'acknowledged',now() from public.creator_storage_objects where owner_id=p_owner and bucket=p_bucket and path=v_path
   on conflict(attempt_id,object_id) where kind='manifest' do nothing;
  v_count:=v_count+1;
 end loop;
 return v_count;
end; $$;

create or replace function public.creator_storage_dispatch(p_operation text,p_id uuid,p_owner uuid,p_kind text default null,p_attempt uuid default null,p_worker uuid default null,p_object uuid default null,p_outcome text default null,p_origin_upload boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_job public.creator_storage_deletions%rowtype; v_object public.creator_storage_objects%rowtype; v_call public.creator_storage_dispatches%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||p_owner::text,0));
 select * into v_job from public.creator_storage_deletions where owner_id=p_owner for update;
 if p_operation='begin' then
  if exists(select 1 from public.creator_storage_dispatches where id=p_id) then return jsonb_build_object('dispatch',false); end if;
  if p_attempt is not null then
   if v_job.attempt_id is distinct from p_attempt or v_job.lease_id is distinct from p_worker or v_job.lease_until<=now() or v_job.state not in ('pending','auth_deleting') or exists(select 1 from public.profiles where id=p_owner and is_active) then return null; end if;
  end if;
  if p_kind='remove' then
   select * into v_object from public.creator_storage_objects where id=p_object and owner_id=p_owner for update;
   if v_object.id is null or v_object.cleanup_kind='none' or v_object.upload_state not in ('stored','rejected') or v_object.removed_at is not null or (p_attempt is not null and v_object.deletion_attempt is distinct from p_attempt) then return null; end if;
   if p_attempt is not null and not exists(select 1 from public.creator_storage_dispatches where kind='manifest' and owner_id=p_owner and attempt_id=p_attempt and object_id=v_object.id and bucket=v_object.bucket and path=v_object.path) then return null; end if;
   if p_attempt is null and (v_object.cleanup_kind='account' or (v_job.owner_id is not null and v_job.state not in ('paused','complete'))) and not (p_origin_upload and v_object.upload_registered and v_object.published_at is null) then return null; end if;
   insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind,object_id,bucket,path)
    values(p_id,p_owner,p_attempt,p_worker,p_kind,v_object.id,v_object.bucket,v_object.path);
  elsif p_kind='auth' and p_attempt is not null and v_job.state='auth_deleting' then
   insert into public.creator_storage_dispatches(id,owner_id,attempt_id,worker_id,kind) values(p_id,p_owner,p_attempt,p_worker,p_kind);
  else raise exception 'invalid dispatch' using errcode='22023'; end if;
  return jsonb_build_object('dispatch',true);
 elsif p_operation='finish' then
  if p_outcome not in ('acknowledged','rejected','uncertain') then raise exception 'invalid dispatch outcome' using errcode='22023'; end if;
  select * into v_call from public.creator_storage_dispatches where id=p_id and owner_id=p_owner for update;
  if v_call.id is null then return null; end if;
  if v_call.state in ('acknowledged','rejected') then return jsonb_build_object('state',v_call.state); end if;
  -- Completion can be recorded by a lease-expired worker, but cannot authorize
  -- another dispatch or change a later attempt's manifest.
  update public.creator_storage_dispatches set state=p_outcome,settled_at=case when p_outcome='uncertain' then null else now() end where id=p_id;
  if p_outcome='acknowledged' and v_call.kind='remove' then
   if not public.creator_storage_complete_remove(v_call.object_id) then raise exception 'removal completion failed' using errcode='40001'; end if;
  end if;
  return jsonb_build_object('state',p_outcome);
 end if;
 raise exception 'invalid dispatch operation' using errcode='22023';
end; $$;

-- Media publication, metadata creation and intent binding are one idempotent
-- transaction. An INSERT acknowledgement loss cannot detach bytes from a row.
create or replace function public.creator_storage_publish_media(p_id uuid,p_caption text,p_width integer,p_height integer,p_sort_order integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_owner uuid; v_object public.creator_storage_objects%rowtype; v_media public.creator_media%rowtype; v_ok boolean;
begin
 select owner_id into v_owner from public.creator_storage_objects where id=p_id;
 if v_owner is null then raise exception 'upload missing' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('creator-storage:'||v_owner::text,0));
 select is_active and (approval_status='approved' or role='admin') into v_ok from public.profiles where id=v_owner for update;
 select * into v_object from public.creator_storage_objects where id=p_id for update;
 select * into v_media from public.creator_media where id=p_id and creator_id=v_owner and path=v_object.path;
 if v_media.id is not null and v_object.media_id=p_id and v_object.cleanup_kind='none' and v_object.removed_at is null then return to_jsonb(v_media); end if;
 if v_ok is distinct from true or v_object.bucket<>'creator-media' or v_object.upload_state<>'stored' or v_object.cleanup_kind<>'none' or v_object.removed_at is not null or v_object.expires_at<=now() or exists(select 1 from public.creator_storage_deletions where owner_id=v_owner and state not in ('paused','complete')) then raise exception 'media publication forbidden' using errcode='42501'; end if;
 insert into public.creator_media(id,creator_id,path,caption,width,height,sort_order,sfw_attested_at)
 values(p_id,v_owner,v_object.path,p_caption,p_width,p_height,p_sort_order,now()) returning * into v_media;
 update public.creator_storage_objects set media_id=p_id,published_at=now(),updated_at=now() where id=p_id;
 return to_jsonb(v_media);
end; $$;

-- Claim updates the schedule before inspecting bytes, including on a crash or
-- an absent uncertain object. All eligible categories share one fair queue.
create or replace function public.creator_storage_work_claim(p_limit integer default 20)
returns jsonb language sql security definer set search_path=public as $$
 with candidates as (
  select id from public.creator_storage_objects
   where removed_at is null and cleanup_kind<>'account' and next_attempt_at<=now()
    and (cleanup_kind<>'none' or (published_at is null and expires_at<now()))
   order by next_attempt_at,last_attempt_at nulls first,created_at,id
   for update skip locked limit least(greatest(p_limit,1),20)
 ), claimed as (
 update public.creator_storage_objects o set attempts=o.attempts+1,last_attempt_at=now(),
  next_attempt_at=now()+make_interval(secs=>least(900,5*power(2,least(o.attempts,8)))::integer),updated_at=now()
 from candidates c where o.id=c.id returning o.*
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) from claimed;
$$;

revoke execute on function public.creator_storage_manifest(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.creator_storage_manifest(uuid,uuid,uuid,text,jsonb) to service_role;
revoke execute on function public.creator_storage_dispatch(text,uuid,uuid,text,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.creator_storage_dispatch(text,uuid,uuid,text,uuid,uuid,uuid,text,boolean) to service_role;
revoke execute on function public.creator_storage_publish_media(uuid,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.creator_storage_publish_media(uuid,text,integer,integer,integer) to service_role;
revoke execute on function public.creator_storage_work_claim(integer) from public,anon,authenticated;
grant execute on function public.creator_storage_work_claim(integer) to service_role;

create or replace function public.creator_storage_account(p_operation text, p_owner uuid, p_was_admin boolean default false, p_worker uuid default null, p_actor uuid default null, p_action text default 'account.self_close', p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.creator_storage_deletions%rowtype; v_profile public.profiles%rowtype; v_hashes jsonb; v_reserve text;
begin
  if p_error is not null and p_error not in ('storage_cleanup_failed', 'delete_failed', 'db_error', 'upload_unconfirmed') then raise exception 'invalid work error' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-storage:' || p_owner::text, 0));
  select * into v_profile from public.profiles where id = p_owner for update;
  select * into v_job from public.creator_storage_deletions where owner_id = p_owner for update;
  if p_operation = 'begin' then
    if (p_action = 'account.self_close' and p_actor is distinct from p_owner) or
       (p_action = 'account.delete' and (p_actor = p_owner or not exists (select 1 from public.profiles where id = p_actor and role = 'admin' and is_active))) or
       p_action not in ('account.self_close', 'account.delete') then raise exception 'deletion actor forbidden' using errcode = '42501'; end if;
    if v_job.owner_id is not null and v_job.state <> 'paused' then
      return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
    end if;
    if v_profile.id is null then raise exception 'account missing' using errcode = '22023'; end if;
    -- Reservation and durable quiescence commit together: a crash cannot leave
    -- an admin demoted with no deletion record to resume or restore.
    v_reserve := public.reserve_self_account_deletion(p_owner);
    if v_reserve <> 'ok' then return jsonb_build_object('error', v_reserve); end if;
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') h from public.fan_passes where creator_id = p_owner) hashes;
    if jsonb_array_length(v_hashes) > 100000 then raise exception 'too many links' using errcode = '54000'; end if;
    insert into public.creator_storage_deletions (owner_id, state, was_role, was_active, actor_id, action, link_hashes)
      values (p_owner, 'pending', v_profile.role, v_profile.is_active, p_actor, p_action, v_hashes)
      on conflict (owner_id) do update set state = 'pending', attempt_id=gen_random_uuid(), was_role = excluded.was_role, was_active = excluded.was_active, actor_id = excluded.actor_id, action = excluded.action,
        link_hashes = excluded.link_hashes, lease_id = null, lease_until = null, updated_at = now(), last_error = null
      returning * into v_job;
    update public.profiles set is_active = false where id = p_owner;
    -- Re-arm only after our own reservation/quiescence updates, with the
    -- profile row still locked. An external admin cannot interleave here.
    update public.creator_storage_deletions set restore_allowed=true where owner_id=p_owner;
    update public.creator_storage_objects set cleanup_kind = 'account', deletion_attempt=v_job.attempt_id, updated_at = now() where owner_id = p_owner and removed_at is null;
    insert into public.creator_storage_dispatches(id,owner_id,attempt_id,kind,object_id,bucket,path,state,settled_at)
      select gen_random_uuid(),p_owner,v_job.attempt_id,'manifest',id,bucket,path,'acknowledged',now() from public.creator_storage_objects where owner_id=p_owner and removed_at is null
      on conflict(attempt_id,object_id) where kind='manifest' do nothing;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.owner_id is null then return null; end if;
  if v_job.state = 'complete' then return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes)); end if;
  if p_operation = 'claim' then
    if v_job.state in ('paused', 'complete') or (v_job.lease_until > now() and v_job.lease_id is distinct from p_worker) then return null; end if;
    if p_worker is null then raise exception 'worker id required' using errcode = '22023'; end if;
    update public.creator_storage_deletions set lease_id = p_worker, lease_until = now() + interval '3 minutes', attempts = attempts + 1, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', v_job.state, 'attempt_id', v_job.attempt_id, 'links', jsonb_array_length(v_job.link_hashes));
  end if;
  if v_job.lease_id is distinct from p_worker or v_job.lease_until <= now() then return null; end if;
  if p_operation = 'check' then
    update public.creator_storage_deletions set lease_until=now()+interval '3 minutes' where owner_id=p_owner;
    return jsonb_build_object('state',v_job.state,'attempt_id',v_job.attempt_id);
  end if;
  if p_operation = 'prepare' then
    if exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null and upload_state in ('inflight', 'uncertain')) then return jsonb_build_object('state', 'pending'); end if;
    if v_profile.id is not null and v_profile.is_active then raise exception 'account not quiesced' using errcode = '42501'; end if;
    -- Refresh hashes immediately before the auth call; only hashes survive it.
    select coalesce(jsonb_agg(h), '[]'::jsonb) into v_hashes from (select distinct value h from jsonb_array_elements_text(v_job.link_hashes) union select distinct encode(sha256(convert_to(token, 'UTF8')), 'hex') from public.fan_passes where creator_id = p_owner) hashes;
    if exists(select 1 from public.creator_storage_objects where owner_id=p_owner and removed_at is null) then return jsonb_build_object('state','pending'); end if;
    update public.creator_storage_deletions set state = 'auth_deleting', link_hashes = v_hashes, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleting');
  elsif p_operation = 'auth_deleted' then
    if exists (select 1 from auth.users where id = p_owner) then return null; end if;
    update public.creator_storage_dispatches set state='acknowledged',settled_at=now() where owner_id=p_owner and kind='auth' and state in ('pending','uncertain');
    update public.creator_storage_deletions set state = 'auth_deleted', updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', 'auth_deleted');
  elsif p_operation = 'complete' then
    if v_job.state <> 'auth_deleted' or exists (select 1 from auth.users where id = p_owner) or exists (select 1 from public.creator_storage_objects where owner_id = p_owner and removed_at is null) then return null; end if;
    insert into public.link_tombstones (token_hash, reason)
      select value, 'creator_closed' from jsonb_array_elements_text(v_job.link_hashes) on conflict (token_hash) do nothing;
    insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, details)
      values (v_job.id, v_job.actor_id, v_job.action, 'profile', p_owner, jsonb_build_object('role', v_job.was_role, 'fanLinks', jsonb_array_length(v_job.link_hashes))) on conflict (id) do nothing;
    update public.creator_storage_deletions set state = 'complete', completed_at = now(), updated_at = now(), lease_id = null, lease_until = null, last_error = null where owner_id = p_owner;
    return jsonb_build_object('id', v_job.id, 'state', 'complete', 'links', jsonb_array_length(v_job.link_hashes));
  elsif p_operation = 'pause' then
    if v_profile.id is null or exists(select 1 from public.creator_storage_dispatches where owner_id=p_owner and state in ('pending','uncertain')) then return null; end if;
    -- Change the service-owned state before our restoration write, in this
    -- same transaction under profile -> job locks. This is the sole safe way
    -- to reopen an account; ordinary profile writes cannot bypass quiescence.
    update public.creator_storage_deletions set state = 'paused', last_error = p_error, updated_at = now(), lease_id = null, lease_until = null where owner_id = p_owner;
    if v_job.restore_allowed then
      update public.profiles set role = v_job.was_role::public.app_role, is_active = v_job.was_active where id = p_owner;
    end if;
    return jsonb_build_object('state', 'paused');
  elsif p_operation = 'release' then
    update public.creator_storage_deletions set lease_id = null, lease_until = null, last_error = p_error, updated_at = now() where owner_id = p_owner;
    return jsonb_build_object('state', v_job.state);
  end if;
  raise exception 'invalid storage operation' using errcode = '22023';
end; $$;

create or replace function public.creator_storage_prune(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  -- Uncertain/inflight work is never expired: absence is not completion proof.
  delete from public.creator_storage_objects where removed_at < now() - make_interval(days => greatest(p_days, 1)) and upload_state in ('stored', 'rejected') and not exists(select 1 from public.creator_storage_dispatches d where d.object_id=creator_storage_objects.id and d.state in ('pending','uncertain'));
  get diagnostics v_count = row_count;
  delete from public.creator_storage_deletions where state = 'complete' and completed_at < now() - make_interval(days => greatest(p_days, 1));
  delete from public.creator_storage_dispatches d where state in ('acknowledged','rejected') and settled_at<now()-make_interval(days=>greatest(p_days,1)) and (kind<>'manifest' or not exists(select 1 from public.creator_storage_deletions j where j.owner_id=d.owner_id and j.attempt_id=d.attempt_id and j.state not in ('complete','paused')));
  return v_count;
end; $$;

revoke execute on function public.creator_storage_register_upload(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_register_upload(uuid, uuid, text, text) to service_role;
revoke execute on function public.creator_storage_finish_upload(uuid, text) from public, anon, authenticated;
grant execute on function public.creator_storage_finish_upload(uuid, text) to service_role;
revoke execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.creator_storage_queue_remove(uuid, jsonb, uuid, boolean) to service_role;
revoke execute on function public.creator_storage_complete_remove(uuid) from public, anon, authenticated;
grant execute on function public.creator_storage_complete_remove(uuid) to service_role;
revoke execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.creator_storage_account(text, uuid, boolean, uuid, uuid, text, text) to service_role;
revoke execute on function public.creator_storage_prune(integer) from public, anon, authenticated;
grant execute on function public.creator_storage_prune(integer) to service_role;
