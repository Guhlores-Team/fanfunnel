-- 0032 Enforce is_active in creator RLS (multi-review audit, HIGH).
--
-- Suspending a creator (profiles.is_active=false) was largely cosmetic: the
-- creator-owned RLS policies authorize on `creator_id = auth.uid()` (or
-- can_act_for, which short-circuits true for self) WITHOUT checking is_active,
-- so a suspended creator could keep reading and — critically — mutating their
-- own wheels, prizes, fans, passes, grants (money), messages, etc.
--
-- is_admin() already requires is_active, so admins were correctly gated; this
-- migration extends the same active-state requirement to creators.
--
-- Strategy:
--   * can_act_for() — the single predicate behind wheels/prizes/fans/fan_passes/
--     campaigns/redemptions/grants/messages — now denies every WRITE/act perm to
--     a suspended caller. 'view' is intentionally still allowed so the dashboard
--     can render a read-only "account suspended" state instead of breaking.
--   * The remaining creator-owned tables that still use the raw
--     `creator_id = auth.uid()` pattern get an explicit active check.

-- Caller's active state. SECURITY DEFINER (like is_admin) to avoid RLS recursion.
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and is_active
  );
$$;

-- Re-create can_act_for with the active-caller guard added up top.
create or replace function public.can_act_for(target_creator uuid, perm text)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_role org_role;
  v_member uuid;
  v_scoped boolean;
begin
  -- A suspended caller loses every write/act permission. 'view' is still allowed
  -- so a suspended creator can load a read-only dashboard (the auth gate then
  -- shows the suspension notice); every mutating perm fails closed.
  if perm <> 'view' and not exists (
    select 1 from public.profiles where id = auth.uid() and is_active
  ) then
    return false;
  end if;

  -- The creator themselves always has full power over their own account.
  if target_creator = auth.uid() then
    return true;
  end if;

  -- Find the caller's org membership that covers the target creator's org.
  select m.id, m.role into v_member, v_role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    join public.profiles p on p.id = target_creator
   where m.profile_id = auth.uid()
     and p.org_id = o.id
   limit 1;
  if v_member is null then
    return false;
  end if;

  -- Owners and managers act for every creator in their org.
  -- Other roles must be explicitly scoped to this creator.
  if v_role in ('owner','manager') then
    v_scoped := true;
  else
    select exists(
      select 1 from public.org_member_creators mc
       where mc.member_id = v_member and mc.creator_id = target_creator
    ) into v_scoped;
  end if;
  if not v_scoped then
    return false;
  end if;

  -- Role → permission matrix.
  return case perm
    when 'view'       then true
    when 'chat'       then v_role in ('owner','manager','chatter')
    when 'fulfil'     then v_role in ('owner','manager','fulfiller')
    when 'grant'      then v_role in ('owner','manager')
    when 'edit_wheel' then v_role in ('owner','manager')
    when 'manage'     then v_role in ('owner','manager')
    else false
  end case;
end;
$$;

-- ── Remaining creator-owned tables still on the raw creator_id pattern ───────
-- Gate the self branch on current_user_active(); admins keep access via
-- is_admin() (which already requires is_active). A suspended creator loses both
-- read and write here — that's fine, these are secondary config tables and the
-- dashboard gate keeps the UX coherent.

drop policy if exists dm_templates_rw on public.dm_templates;
create policy dm_templates_rw on public.dm_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists campaign_packs_rw on public.campaign_packs;
create policy campaign_packs_rw on public.campaign_packs for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists prize_templates_rw on public.prize_templates;
create policy prize_templates_rw on public.prize_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wheel_templates_rw on public.wheel_templates;
create policy wheel_templates_rw on public.wheel_templates for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists happy_hours_rw on public.happy_hours;
create policy happy_hours_rw on public.happy_hours for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists wishlists_rw on public.wishlists;
create policy wishlists_rw on public.wishlists for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists referrals_rw on public.referrals;
create policy referrals_rw on public.referrals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists webhooks_rw on public.webhooks;
create policy webhooks_rw on public.webhooks for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());

drop policy if exists autopilot_dismissals_rw on public.autopilot_dismissals;
create policy autopilot_dismissals_rw on public.autopilot_dismissals for all
  using ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin())
  with check ((creator_id = auth.uid() and public.current_user_active()) or public.is_admin());
