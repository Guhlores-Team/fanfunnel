import assert from "node:assert";
import { mockCreatePass, mockGetFanPass } from "./mock";

// Regression: a referral bonus must land on a SPENDABLE pass, so the balance the
// fan sees equals what they can actually spin. The old behavior added the bonus
// to the fan-level aggregate only — leaving it unspendable and inflating the
// displayed count until the next spin resynced the aggregate down ("18 spins at
// the start that drop to 3 once you spin").

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function mustView<T>(view: T | null, label: string): T {
  if (!view) throw new Error(`expected a fan pass view: ${label}`);
  return view;
}

async function main() {
  // 1. A referrer fan (paid grant of 4) with a known referral code.
  const referrer = mockCreatePass("Referrer", 4, undefined, undefined, 1000);
  const referrerView = mustView(await mockGetFanPass(referrer.token), "referrer");
  check("referrer starts at its granted balance", referrerView.spinsRemaining === 4);
  const code = referrerView.referral?.code;
  assert.ok(code, "referrer has a referral code");

  // 2. A NEW fan referred by that code, created with a PAID grant of 3 — this is
  //    the fan's first paid grant, so the referral is credited to BOTH fans.
  const referred = mockCreatePass(
    "Referred",
    3,
    undefined,
    undefined,
    500,
    0,
    undefined,
    code,
  );
  const referredView = mustView(await mockGetFanPass(referred.token), "referred");

  // 3. The referred fan's bonus (3) is on the spendable pass: 3 paid + 3 = 6.
  check("referred fan's bonus is spendable on the pass", referredView.spinsRemaining === 6);

  // 4. The referrer's bonus (3) is on their spendable pass: 4 + 3 = 7. (Pre-fix
  //    this stayed at 4 because the bonus only touched the aggregate.)
  const referrerAfter = mustView(await mockGetFanPass(referrer.token), "referrer-after");
  check("referrer's bonus is spendable on the pass", referrerAfter.spinsRemaining === 7);

  console.log(`referralIntegrity.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
