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
-- Only flags on fans WITHOUT a board handle are cleared. Opting in now
-- requires a handle and no UI ever set one before this change, so a set flag
-- with no handle can only have come from spin()'s auto opt-in, while a fan
-- who has a handle chose it deliberately. This also makes a re-run safe: it
-- never touches a real opt-in.
update public.fans
   set leaderboard_opt_in = false
 where leaderboard_opt_in
   and (handle is null or btrim(handle) = '');
