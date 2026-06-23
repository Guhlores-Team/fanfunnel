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

-- Every app-data table is listed EXPLICITLY (not left to implicit cascade): some
-- relations don't cascade from fans/fan_passes — notably `grants.fan_pass_id` is
-- ON DELETE SET NULL, so revenue rows would otherwise survive a "clean slate" as
-- orphans. `cascade` still resolves FK ordering; `restart identity` resets
-- sequences. Preserves creator/admin logins (profiles) and agency structure
-- (orgs, org_members, org_member_creators, org_invites).
truncate table
  public.redemptions,
  public.spins,
  public.grants,
  public.referrals,
  public.wishlists,
  public.messages,
  public.happy_hours,
  public.webhooks,
  public.creator_reports,
  public.creator_applications,
  public.autopilot_dismissals,
  public.dm_templates,
  public.campaign_packs,
  public.prize_templates,
  public.wheel_templates,
  public.fan_passes,
  public.fans,
  public.prizes,
  public.wheels,
  public.campaigns
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
