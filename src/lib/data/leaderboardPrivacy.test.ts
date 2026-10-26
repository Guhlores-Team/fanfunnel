import assert from "node:assert";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetLeaderboard,
  mockGetRecentWins,
  mockSetFanLeaderboardOptIn,
  mockSetLeaderboardEnabled,
  mockSpin,
} from "./mock";

// Privacy regression (HARD-4). The public leaderboard used to:
//   1. opt a fan in the moment they spun (data/index.ts + mock.ts set
//      leaderboard_opt_in = true inside spin()), so a fan landed on a public,
//      unauthenticated page without ever choosing to; and
//   2. publish each fan's lifetime spend (`spentCents`, summed from `grants`)
//      in the public /api/leaderboard JSON.
// Both are fixed: appearing is opt-in only, and the public payload carries no
// spend field at all.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  mockSetLeaderboardEnabled(true);

  // A paying fan: 3 spins for $25. Spend exists in the store, so if the public
  // payload ever reintroduces a spend field this test sees a real number.
  const fan = mockCreatePass("Taylor Spender", 3, undefined, undefined, 2500);
  mockAckFan(fan.token);

  // --- 1. Spinning must NOT opt the fan in -------------------------------
  const before = mockGetLeaderboard("demo-creator");
  check("board starts with no entry for a brand-new fan", !before.entries.some((e) => e.handle === "Taylor"));

  const result = await mockSpin(fan.token);
  check("the spin itself succeeded", !("error" in result));

  const after = mockGetLeaderboard("demo-creator");
  check(
    "a fan who only spun is NOT on the public board",
    !after.entries.some((e) => e.handle === "Taylor")
  );
  check(
    "the fan's own pass reports them as opted out",
    (await mockGetFanPass(fan.token))?.leaderboardOptIn === false
  );
  check(
    "a fan who only spun is NOT in the public recent-wins ticker",
    !mockGetRecentWins().some((w) => w.handle === "Taylor")
  );

  // --- 2. Explicit opt-in puts them on the board ------------------------
  mockSetFanLeaderboardOptIn(fan.token, true, "taylor");
  const optedIn = mockGetLeaderboard("demo-creator");
  const row = optedIn.entries.find((e) => e.handle === "taylor");
  check("after an explicit opt-in the fan appears", !!row);
  check("the fan's pass reports them as opted in", (await mockGetFanPass(fan.token))?.leaderboardOptIn === true);
  check("the entry carries the spin count", row!.spins >= 1);

  // --- 3. No spend anywhere in the public payload -----------------------
  for (const e of optedIn.entries) {
    check(
      `entry ${e.rank} has no spend field`,
      !("spentCents" in e) && !("spent" in e) && !("revenueCents" in e)
    );
  }
  const json = JSON.stringify(optedIn);
  check("serialized public payload mentions no spend key", !/spent|revenue|amount_?cents/i.test(json));
  check("serialized public payload leaks no fan id or token", !/fanId|"id"|token/i.test(json));

  // --- 4. Opting back out removes them ----------------------------------
  mockSetFanLeaderboardOptIn(fan.token, false);
  check(
    "opting out removes the fan from the public board",
    !mockGetLeaderboard("demo-creator").entries.some((e) => e.handle === "taylor")
  );

  // --- 5. The creator's own on/off switch still wins --------------------
  mockSetFanLeaderboardOptIn(fan.token, true, "taylor");
  mockSetLeaderboardEnabled(false);
  const off = mockGetLeaderboard("demo-creator");
  check("creator toggle off -> enabled:false", off.enabled === false);
  check("creator toggle off -> no entries", off.entries.length === 0);
  mockSetLeaderboardEnabled(true);

  // --- 6. A fan's real name is never published --------------------------
  // An opted-in fan with NO board handle is skipped outright rather than
  // shown under their first name (the old `firstName(display_name)` fallback).
  const nameless = mockCreatePass("Priya Realname", 2, undefined, undefined, 0);
  mockAckFan(nameless.token);
  await mockSpin(nameless.token);
  mockSetFanLeaderboardOptIn(nameless.token, true); // no handle
  check(
    "the data layer records the opt-in",
    (await mockGetFanPass(nameless.token))?.leaderboardOptIn === true
  );
  const board = mockGetLeaderboard("demo-creator");
  check(
    "an opted-in fan without a handle is not on the board",
    !board.entries.some((e) => /priya|realname/i.test(e.handle))
  );
  check(
    "nor in the recent-wins ticker",
    !mockGetRecentWins().some((w) => /priya|realname/i.test(w.handle))
  );
  check(
    "the public payload never contains the fan's name",
    !/priya|realname/i.test(JSON.stringify(board) + JSON.stringify(mockGetRecentWins()))
  );

  // --- 7. Ranking is by spins / rare wins, never by spend ---------------
  const quiet = mockCreatePass("Quiet Quincy", 5, undefined, undefined, 0);
  mockAckFan(quiet.token);
  mockSetFanLeaderboardOptIn(quiet.token, true, "quincy");
  for (let i = 0; i < 3; i++) await mockSpin(quiet.token);
  const ranked = mockGetLeaderboard("demo-creator");
  const quincy = ranked.entries.find((e) => e.handle === "quincy");
  const taylor = ranked.entries.find((e) => e.handle === "taylor");
  check("both opted-in fans are ranked", !!quincy && !!taylor);
  check(
    "the fan with more spins ranks higher than the bigger spender",
    quincy!.spins > taylor!.spins && quincy!.rank < taylor!.rank
  );

  console.log(`leaderboardPrivacy.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
