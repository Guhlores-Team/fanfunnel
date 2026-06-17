-- 0031 Suspended admins lose deletion power at the DB layer too (multi-review
-- audit). admin_reserve_account_deletion only required the caller's role to be
-- 'admin', ignoring is_active. The API route now checks is_active, but this
-- SECURITY DEFINER RPC is the atomic last-admin guard and should fail closed for
-- a suspended admin independently of the route — mirroring public.is_admin(),
-- which already requires is_active.

create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an ACTIVE admin (defense in depth; the route checks too).
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  ) then
    return 'forbidden';
  end if;
  if p_target = auth.uid() then
    return 'cannot_delete_self';
  end if;
  -- Lock the target row; missing => not found.
  select role into v_role from public.profiles where id = p_target for update;
  if v_role is null then
    return 'not_found';
  end if;
  if v_role = 'admin' then
    -- Lock ALL admin rows so concurrent reservations serialize here.
    select count(*) into v_admins from (
      select id from public.profiles where role = 'admin' for update
    ) s;
    if v_admins <= 1 then
      return 'last_admin';
    end if;
    -- Atomic reservation: demote so a concurrent call sees one fewer admin.
    update public.profiles set role = 'creator' where id = p_target;
  end if;
  return 'ok';
end;
$$;

grant execute on function public.admin_reserve_account_deletion(uuid) to authenticated;
