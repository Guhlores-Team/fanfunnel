import assert from "node:assert";
import {
  mockAckFan,
  mockCreateHappyHour,
  mockCreatePass,
  mockDuplicateWheel,
  mockGetWheel,
  mockDeleteHappyHour,
  mockGetActiveHappyHour,
  mockGetFanPass,
  mockGetSpinVerification,
  mockSpin,
} from "./mock";

// Regression (COR-6): the mock data layer must follow the Supabase path's
// fairness inputs, otherwise a spin verified in the demo re-derives differently
// from one verified against a real DB.
//
//  - nonce: the Supabase path uses claim_spin's return value — THIS PASS's
//    spins_remaining AFTER the decrement (migration 0035). The mock used the
//    fan-level aggregate BEFORE the decrement.
//  - happy hour: the Supabase path stores the multiplier as given (numeric
//    column, UI step 0.5); the mock floored it, so a ×1.5 boost became ×1 (no
//    boost at all).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  // --- nonce basis -----------------------------------------------------------
  {
    const { token: tokenA, fanId } = mockCreatePass("Parity", 5);
    const { wheel: otherWheel } = mockDuplicateWheel(mockGetWheel().id);
    const { token: tokenB } = mockCreatePass(
      "Parity", 2, fanId, undefined, undefined, undefined, undefined, undefined, otherWheel.id,
    );
    mockAckFan(tokenA);
    const before = await mockGetFanPass(tokenB);
    assert.ok(before, "pass view");
    check("fixture: the second pass holds 2 spins", before.spinsRemaining === 2);

    const r = await mockSpin(tokenB, "parity-seed");
    assert.ok(!("error" in r), "spin succeeded");
    const v = await mockGetSpinVerification(r.shareId);
    assert.ok(v, "verification for the spin");
    // claim_spin would return 1 here (pass balance 2 → 1); the fan aggregate
    // before the decrement was 7.
    check("nonce is this pass's balance after the decrement (claim_spin basis)", v.nonce === 1);
    check("nonce is not the fan aggregate", v.nonce !== 7);
  }

  // --- happy-hour multiplier --------------------------------------------------
  {
    const wheel = mockGetWheel();
    const now = Date.now();
    const created = mockCreateHappyHour({
      wheelId: wheel.id,
      multiplier: 1.5,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60_000).toISOString(),
    });
    assert.ok(!("error" in created), "fractional multiplier accepted (Supabase path accepts 1..10 numeric)");
    try {
      check("fractional multiplier is stored as given, not floored", created.multiplier === 1.5);
      const status = mockGetActiveHappyHour(wheel.id, new Date(now));
      check("active happy hour reports the fractional multiplier", status.active && status.multiplier === 1.5);
    } finally {
      mockDeleteHappyHour(created.id);
    }
    const low = mockCreateHappyHour({
      wheelId: wheel.id,
      multiplier: 0.5,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60_000).toISOString(),
    });
    check("multiplier below 1 is rejected (same range as the Supabase path)", "error" in low && low.error === "invalid_multiplier");
    const high = mockCreateHappyHour({
      wheelId: wheel.id,
      multiplier: 10.5,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60_000).toISOString(),
    });
    check("multiplier above 10 is rejected (same range as the Supabase path)", "error" in high && high.error === "invalid_multiplier");
  }

  console.log(`spinParity.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
