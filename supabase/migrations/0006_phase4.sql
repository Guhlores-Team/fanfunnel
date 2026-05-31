-- Phase 4 (deeper analytics)
-- #18 Prize ROI: track the creator's cost to fulfil each prize, in cents.
alter table public.prizes add column if not exists cost_cents integer;
