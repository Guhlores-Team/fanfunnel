-- 0052 Go-live hardening: agency/org RLS + non-negative ledger CHECKs.
--
-- PART 1 — agency/org RLS (found by the new org isolation probe,
-- scripts/db/orgIsolationProbe.mjs). AUTH-SENSITIVE (AGENTS.md).
--
--   a) The 0014 policies on orgs, org_members and org_member_creators query
--      each other's tables directly: orgs_read reads org_members, whose
--      org_members_read reads orgs again. Postgres refuses that with
--      "infinite recursion detected in policy" (42P17), so EVERY non-admin
--      read or write of those three tables errored. It failed closed (nothing
--      leaked), but the agency console could never load for an owner or a
--      seat, and a seat's isolation was untestable. The fix routes each
--      cross-table check through a SECURITY DEFINER helper (like _owns_org,
--      is_admin), which does not re-enter RLS.
--   b) orgs_read compared `m.org_id = id` inside a subquery on org_members,
--      where `id` bound to org_members.id, not orgs.id, so even without the
--      recursion a seat could never read its own org row.
--   c) org_account_stats returned EVERY creator in the org (email, fans,
--      spins, revenue) to ANY seat, including a chatter/fulfiller/analyst seat
--      scoped to one creator. Owners and admins still see every creator in
--      the org; a seat now sees only the creators can_act_for(…, 'view')
--      grants it (owner/manager seats: the whole org; scoped seats: their
--      scoped creators). Same rule the tenant-table RLS already applies.
--
-- Who may do what is unchanged otherwise: org owners manage seats and scopes,
-- a seat reads its own seat row, admins see everything.
--
-- PART 2 — non-negative CHECKs the code already assumes (audit A6).
--   fan_passes.spins_granted_total  per-pass ledger history; every write adds,
--                                   or clamps at 0 (fans.ts editGrant), or
--                                   undoes an add it just made (spins.ts).
--   fans.spins_granted_total        = SUM of the passes (0035 trigger).
--   prizes.stock                    NULL = unlimited; the stock CAS stops at 0
--                                   (spins.ts takeStockUnit) and wheel saves
--                                   clamp to >= 0 (wheels.ts prizeRow).
--   prizes.cost_cents               NULL = no cost; saves clamp to >= 0.
--   fans.rl_count                   claim_spin's window counter (1, then +1).
--
-- Why 0039 skipped spins_granted_total: it is the HISTORY, and 0039's repair
-- (clamp negatives to 0) would rewrite it. This migration never rewrites data.
-- A NOT VALID CHECK is still enforced on every later INSERT/UPDATE of the
-- whole row, so leaving one in place over a violating row would make ANY
-- update of that row fail (claim_spin decrementing that pass would error).
-- So each CHECK is added NOT VALID (the ALTER takes an ACCESS EXCLUSIVE lock
-- held to commit, so no write can slip in), then:
--   * no violating rows -> VALIDATE (the normal case);
--   * violating rows    -> DROP it again and RAISE WARNING with the count.
--     Nothing is rewritten; fix those rows by hand and re-run this file.
-- fans.spins_granted_total is validated only when the per-pass CHECK is, since
-- the aggregate trigger writes the SUM of the passes.
--
-- Idempotent: helpers are create-or-replace, policies drop-if-exists, each
-- add is guarded on pg_constraint and VALIDATE on a validated CHECK is a no-op.
-- NON-DESTRUCTIVE: no data is changed or deleted.

-- ── Part 1: org RLS without cross-table recursion ───────────────────────────

-- Does the caller hold a seat in this org?
create or replace function public._is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members where org_id = p_org and profile_id = auth.uid());
$$;

-- Does the caller own the org this seat belongs to?
create or replace function public._owns_org_seat(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.org_members m join public.orgs o on o.id = m.org_id
                 where m.id = p_member and o.owner_id = auth.uid());
$$;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select
  using (owner_id = auth.uid() or public._is_org_member(id) or public.is_admin());

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select
  using (profile_id = auth.uid() or public._owns_org(org_id) or public.is_admin());
drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for all
  using (public._owns_org(org_id) or public.is_admin())
  with check (public._owns_org(org_id) or public.is_admin());

drop policy if exists omc_rw on public.org_member_creators;
create policy omc_rw on public.org_member_creators for all
  using (public._owns_org_seat(member_id) or public.is_admin())
  with check (public._owns_org_seat(member_id) or public.is_admin());

create or replace function public.org_account_stats(p_org uuid)
returns table (
  id uuid, email text, display_name text, role app_role, is_active boolean,
  features jsonb, wheels bigint, fans bigint, spins bigint, pending bigint,
  revenue bigint
)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.role, p.is_active, p.features,
         (select count(*) from public.wheels w where w.creator_id = p.id),
         (select count(*) from public.fans f where f.creator_id = p.id),
         (select count(*) from public.spins s where s.creator_id = p.id),
         (select count(*) from public.redemptions r where r.creator_id = p.id and r.status = 'pending'),
         (select coalesce(sum(g.amount_cents),0) from public.grants g where g.creator_id = p.id)
    from public.profiles p
   where p.org_id = p_org
     and (
       public._owns_org(p_org)
       or public.is_admin()
       or (public._is_org_member(p_org) and public.can_act_for(p.id, 'view'))
     );
$$;

-- ── Part 2: non-negative CHECKs ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fan_passes_spins_granted_total_check'
                  and conrelid = 'public.fan_passes'::regclass) then
    alter table public.fan_passes add constraint fan_passes_spins_granted_total_check
      check (spins_granted_total >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fans_spins_granted_total_check'
                  and conrelid = 'public.fans'::regclass) then
    alter table public.fans add constraint fans_spins_granted_total_check
      check (spins_granted_total >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fans_rl_count_check'
                  and conrelid = 'public.fans'::regclass) then
    alter table public.fans add constraint fans_rl_count_check
      check (rl_count >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prizes_stock_check'
                  and conrelid = 'public.prizes'::regclass) then
    alter table public.prizes add constraint prizes_stock_check
      check (stock >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prizes_cost_cents_check'
                  and conrelid = 'public.prizes'::regclass) then
    alter table public.prizes add constraint prizes_cost_cents_check
      check (cost_cents >= 0) not valid;
  end if;
end;
$$;

do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad from public.fan_passes where spins_granted_total < 0;
  if v_bad = 0 then
    alter table public.fan_passes validate constraint fan_passes_spins_granted_total_check;
  else
    alter table public.fan_passes drop constraint fan_passes_spins_granted_total_check;
    raise warning '0052: % fan_passes row(s) have spins_granted_total < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.fans where spins_granted_total < 0;
  if v_bad = 0 and exists (select 1 from pg_constraint where conname = 'fan_passes_spins_granted_total_check'
                            and conrelid = 'public.fan_passes'::regclass and convalidated) then
    alter table public.fans validate constraint fans_spins_granted_total_check;
  else
    alter table public.fans drop constraint fans_spins_granted_total_check;
    raise warning '0052: fans.spins_granted_total CHECK not added (% negative row(s), or the per-pass CHECK was not added). Fix by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.fans where rl_count < 0;
  if v_bad = 0 then
    alter table public.fans validate constraint fans_rl_count_check;
  else
    alter table public.fans drop constraint fans_rl_count_check;
    raise warning '0052: % fans row(s) have rl_count < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.prizes where stock < 0;
  if v_bad = 0 then
    alter table public.prizes validate constraint prizes_stock_check;
  else
    alter table public.prizes drop constraint prizes_stock_check;
    raise warning '0052: % prizes row(s) have stock < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;

  select count(*) into v_bad from public.prizes where cost_cents < 0;
  if v_bad = 0 then
    alter table public.prizes validate constraint prizes_cost_cents_check;
  else
    alter table public.prizes drop constraint prizes_cost_cents_check;
    raise warning '0052: % prizes row(s) have cost_cents < 0; CHECK not added. Fix them by hand, then re-run 0052.', v_bad;
  end if;
end;
$$;
