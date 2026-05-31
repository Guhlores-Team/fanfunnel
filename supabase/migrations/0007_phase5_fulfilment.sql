-- Phase 5a (fulfilment workflow)
-- #13 A richer fulfilment queue: an "in progress" status plus a due date.
-- (redemptions.notes already exists from an earlier migration.)
alter type public.redemption_status add value if not exists 'in_progress';
alter table public.redemptions add column if not exists due_at timestamptz;
