-- 0039: fan_passes.spins_remaining can never go negative (ledger integrity).
--
-- fans.spins_remaining has had `check (spins_remaining >= 0)` since schema.sql,
-- but the per-wheel pass balance that claim_spin actually spends (added in 0020
-- as a bare `int not null default 0`) had no such guard. Every code path keeps
-- it >= 0 today (claim_spin only decrements `where spins_remaining > 0`;
-- top-ups, credit_pass_spins and rollback_claimed_spin only add; editGrant
-- clamps to 0), so this is defence in depth: the DB itself refuses a negative
-- balance from any future bug or direct write.
--
-- Order matters:
--   1. Add the CHECK as NOT VALID. From this point on every INSERT/UPDATE is
--      checked, so no new negative row can appear while we repair. NOT VALID
--      skips the full-table scan at add time.
--   2. Repair any pre-existing negative rows by clamping them to 0. This is the
--      safe repair: a negative balance is already unspendable (claim_spin needs
--      > 0), so 0 changes nothing a fan can do today. It only drops a "debt"
--      that no legitimate path can create and that would otherwise silently eat
--      part of the fan's next top-up. spins_granted_total (the history) is left
--      alone. trg_sync_fan_spin_aggregate re-syncs fans.spins_remaining.
--   3. VALIDATE the constraint (scans existing rows; a no-op once validated).
--
-- Idempotent: the add is guarded on pg_constraint, the repair matches no rows
-- on a re-run, and VALIDATE on a validated constraint does nothing.
-- NON-DESTRUCTIVE: no DROP/DELETE/TRUNCATE. No RLS, grant or function changes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'fan_passes_spins_remaining_check'
       and conrelid = 'public.fan_passes'::regclass
  ) then
    alter table public.fan_passes
      add constraint fan_passes_spins_remaining_check
      check (spins_remaining >= 0) not valid;
  end if;
end;
$$;

update public.fan_passes
   set spins_remaining = 0
 where spins_remaining < 0;

alter table public.fan_passes
  validate constraint fan_passes_spins_remaining_check;
