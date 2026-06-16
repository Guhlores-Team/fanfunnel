-- Fan-level spin bonuses must land on a SPENDABLE per-wheel pass, not just the
-- fan aggregate. Before this, referral bonuses were added to fans.spins_remaining
-- only. But spins are spent per-pass (claim_spin decrements a fan_pass), so those
-- bonus spins were (a) never actually spendable, and (b) inflated the balance the
-- fan/dashboard saw until the next spin resynced the aggregate back down to the
-- true sum of passes — i.e. "18 spins at the start that drop to 3 once you spin".
--
-- This migration heals any already-drifted aggregates and adds a helper that
-- credits the fan's oldest active pass (matching the 0020 backfill convention)
-- while keeping the aggregate exactly equal to the sum of the fan's passes.

-- (a) One-time reconcile: snap every fan's aggregate to the true sum of their
--     active passes. Only touches fans that actually have passes, so any legacy
--     pre-0020 fan (balance only on the aggregate) is left untouched.
update public.fans f
   set spins_remaining = coalesce((
         select sum(p.spins_remaining) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0),
       spins_granted_total = coalesce((
         select sum(p.spins_granted_total) from public.fan_passes p
          where p.fan_id = f.id and p.is_active), 0)
 where exists (
   select 1 from public.fan_passes p where p.fan_id = f.id and p.is_active
 );

-- (b) Credit N spins to a fan's OLDEST active pass and resync the fan aggregate
--     to the sum of its passes. Used for referral bonuses so they're spendable
--     on a real link and never drift the displayed balance.
create or replace function public.credit_pass_spins(p_fan_id uuid, p_spins int)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_pass uuid;
begin
  if p_spins is null or p_spins <= 0 then
    return;
  end if;

  -- Oldest active pass = the fan's original link (matches the 0020 backfill).
  select id into v_pass
    from public.fan_passes
   where fan_id = p_fan_id and is_active = true
   order by created_at asc
   limit 1;
  if v_pass is null then
    return; -- no active pass to credit; nothing spendable to add to
  end if;

  update public.fan_passes
     set spins_remaining = spins_remaining + p_spins,
         spins_granted_total = spins_granted_total + p_spins
   where id = v_pass;

  -- Keep the fan-level aggregate exactly equal to the sum of passes.
  update public.fans f
     set spins_remaining = coalesce((
           select sum(p.spins_remaining) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0),
         spins_granted_total = coalesce((
           select sum(p.spins_granted_total) from public.fan_passes p
            where p.fan_id = f.id and p.is_active), 0)
   where f.id = p_fan_id;
end;
$$;
