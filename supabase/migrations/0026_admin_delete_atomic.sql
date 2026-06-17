-- 0026 Atomic admin account-deletion reservation (multi-review finding #2).
--
-- The JS "last admin" count check in /api/admin/account/delete is TOCTOU: two
-- concurrent deletes of the final two admins can both observe count=2, both pass,
-- and leave ZERO admins. This SECURITY DEFINER function makes the guard atomic:
-- it locks the admin rows (FOR UPDATE) and, for an admin target, refuses if it is
-- the last admin; otherwise it DEMOTES the target (role -> 'creator') as an atomic
-- reservation, so a concurrent call serialized behind the lock sees one fewer
-- admin and refuses. The caller (an admin) then deletes the auth user; the FK
-- cascade removes the rest. If the subsequent auth-delete fails, the target is
-- left demoted (a regular creator) — recoverable, and never a lockout.

create or replace function public.admin_reserve_account_deletion(p_target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_admins int;
begin
  -- Caller must be an admin (defense in depth; the route checks too).
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
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
