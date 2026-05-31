-- ============================================================================
-- FanFunnel — RESET data
--
-- Wipes all app data (wheels, prizes, fans, links, spins, redemptions) so you
-- can start from a clean slate, WITHOUT dropping tables or touching accounts.
--
-- Run in the Supabase SQL Editor. Safe to run repeatedly.
--
-- NOTE: this does NOT delete creator/admin logins. To remove those too, see
-- the optional blocks at the bottom.
-- ============================================================================

begin;

-- Order doesn't matter thanks to ON DELETE CASCADE, but truncate explicitly so
-- the intent is obvious.
truncate table
  public.redemptions,
  public.spins,
  public.fan_passes,
  public.fans,
  public.prizes,
  public.wheels
restart identity cascade;

commit;

-- ----------------------------------------------------------------------------
-- OPTIONAL: also delete every creator/admin account (full nuke).
-- Deleting from auth.users cascades to public.profiles and everything they own.
-- Uncomment and set your own email so you keep your admin login.
-- ----------------------------------------------------------------------------
-- delete from auth.users where email <> 'you@example.com';

-- ----------------------------------------------------------------------------
-- OPTIONAL: reset everyone back to plain 'creator' with default features.
-- ----------------------------------------------------------------------------
-- update public.profiles
--    set role = 'creator',
--        is_active = true,
--        features = '{"wheel": true}'::jsonb;
