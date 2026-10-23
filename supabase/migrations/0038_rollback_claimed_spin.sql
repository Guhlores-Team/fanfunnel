-- Compensating rollback for a spin that was CLAIMED but whose outcome could not
-- be durably recorded (the `spins` insert failed, or the wheel had no available
-- prize after the claim). Without this, spin() could decrement the fan's pass
-- balance (and a limited prize's stock) yet return a "win" that has no spins/
-- redemption row — an unfulfillable prize plus silently-leaked inventory, with
-- the fan charged a spin for nothing.
--
-- Refunds the spin onto the pass (the trg_sync_fan_spin_aggregate trigger then
-- re-syncs fans.spins_remaining from the pass sum) and, when the recorded prize
-- was limited-stock, restores the one unit we had decremented. SECURITY DEFINER
-- + revoked from clients: only the server (service role) may call it, exactly
-- like claim_spin.
create or replace function public.rollback_claimed_spin(p_token text, p_prize_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.fan_passes
     set spins_remaining = spins_remaining + 1
   where token = p_token;
  if p_prize_id is not null then
    update public.prizes
       set stock = stock + 1
     where id = p_prize_id and stock is not null;
  end if;
end;
$$;

revoke execute on function public.rollback_claimed_spin(text, uuid) from public, anon, authenticated;
