-- Fan leaderboard privacy: reset the consent flag that spin() used to set.
--
-- `fans.leaderboard_opt_in` has always defaulted to false (migration 0005), but
-- until this change spin() flipped it to true for every fan on their first spin
-- (src/lib/data/index.ts). So every fan who ever spun is currently marked as
-- having consented to appear on a public, unauthenticated page they never saw a
-- control for. The code fix stops new fans from being opted in; this migration
-- clears the flags that were set without consent, so existing fans start from
-- opted-out and only reappear once they tick the box on their spin page.
--
-- No schema change (no new column), no RLS or grant change: the opt-in flag is
-- written only by the server (service role) through
-- `setFanLeaderboardOptIn()`, token-gated at /api/leaderboard/opt-in.
--
-- NOTE: this is intentionally a blanket reset. There is no record of which
-- fans would have opted in deliberately, so the privacy-safe default is to
-- clear all of them and let fans re-consent.
update public.fans
   set leaderboard_opt_in = false
 where leaderboard_opt_in;
