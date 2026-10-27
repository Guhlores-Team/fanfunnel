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
  mockSaveWheel,
  mockSpin,
} from "./mock";
import { renderToStaticMarkup } from "react-dom/server";
import VerifyPage from "@/app/verify/[shareId]/page";
import {
  buildPoolSnapshot,
  canonicalJson,
  hashPoolSnapshot,
  parsePoolSnapshot,
  replayV3,
} from "@/lib/games/wheel/fairnessV3";

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

  // --- fairness v3: the mock records and replays exactly like the real path ---
  {
    const wheel = mockGetWheel();
    // A cost on every prize: none of it may reach the snapshot or the page.
    mockSaveWheel({ ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, cost: 777 })) });
    const now = Date.now();
    const hh = mockCreateHappyHour({
      wheelId: wheel.id,
      multiplier: 2,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60_000).toISOString(),
    });
    assert.ok(!("error" in hh), "happy hour created");
    try {
      const { token } = mockCreatePass("ParityV3", 3);
      mockAckFan(token);
      await mockGetFanPass(token); // commits the next seed, as the page does
      const r = await mockSpin(token, "v3-seed");
      assert.ok(!("error" in r), "mock spin succeeded");
      check("mock spin response carries fairVersion 3 + the pool hash", r.fairVersion === 3 && /^[0-9a-f]{64}$/.test(r.poolHash ?? ""));
      const v = await mockGetSpinVerification(r.shareId!);
      assert.ok(v && v.v3, "mock verification has v3 inputs");
      check("mock verification is fair_version 3", v.fairVersion === 3);
      const parsed = parsePoolSnapshot(v.v3.poolSnapshot);
      check(
        "mock snapshot is built by the same pure builder as the real path",
        parsed.ok &&
          canonicalJson(parsed.snapshot) ===
            canonicalJson(
              buildPoolSnapshot(wheel, {
                happyHourMultiplier: 2,
                pityCounter: parsed.snapshot.modifiers.pity.counter,
              }),
            ),
      );
      check("mock snapshot records the happy hour", parsed.ok && parsed.snapshot.modifiers.happyHour?.multiplier === 2);
      check("mock snapshot has no cost", !/cost|777/.test(JSON.stringify(v.v3.poolSnapshot)));
      check("mock pool hash = SHA-256 of the canonical snapshot", parsed.ok && v.v3.poolHash === (await hashPoolSnapshot(parsed.snapshot)) && v.v3.poolHash === r.poolHash);
      const rep = await replayV3({
        serverSeed: v.serverSeed,
        clientSeed: v.clientSeed ?? null,
        nonce: v.nonce,
        snapshot: v.v3.poolSnapshot,
        poolHash: v.v3.poolHash,
        trace: v.v3.fairTrace,
        prizeId: v.v3.prizeId,
        prizeLabel: v.prizeLabel,
      });
      check("mock spin replays to the prize it awarded", rep.ok && rep.replayed?.id === r.prize.id);

      // The verify page in demo mode.
      const el = await VerifyPage({ params: Promise.resolve({ shareId: r.shareId! }) });
      const html = renderToStaticMarkup(el).replace(/&#x27;|&rsquo;|’/g, "'");
      check("demo verify page: 'Hash matches'", /✓ Hash matches/.test(html));
      check("demo verify page: shows the odds used and that they were locked in", /Odds used for this spin/.test(html) && /locked in before/i.test(html));
      check("demo verify page: the replay passes", /Replayed: these odds and seeds draw/.test(html));
      check("demo verify page: no cost", !/cost/i.test(html));
    } finally {
      mockDeleteHappyHour(hh.id);
      mockSaveWheel(wheel);
    }

    // Two spins race for the last unit of the only weighted prize: the loser sees
    // it sold out after its snapshot, re-draws, and records the exclusion,
    // like the Supabase path's lost stock compare-and-swap.
    mockSaveWheel({
      ...wheel,
      prizes: wheel.prizes.map((p, i) => (i === 0 ? { ...p, weight: 1, stock: 1 } : { ...p, weight: 0 })),
    });
    try {
      const { token } = mockCreatePass("ParityRace", 2);
      mockAckFan(token);
      const [a, b] = await Promise.all([mockSpin(token, "race-a"), mockSpin(token, "race-b")]);
      assert.ok(!("error" in a) && !("error" in b), "both racing spins succeeded");
      const va = await mockGetSpinVerification(a.shareId!);
      const vb = await mockGetSpinVerification(b.shareId!);
      assert.ok(va?.v3 && vb?.v3, "both spins are v3");
      const traces = [va, vb].map((v) => v.v3!.fairTrace as { excluded: string[]; won: string });
      const target = wheel.prizes[0].id;
      check("exactly one racing spin won the last unit", traces.filter((t) => t.won === target).length === 1);
      check("the other recorded it as a sold-out re-draw", traces.some((t) => t.excluded.length === 1 && t.excluded[0] === target && t.won !== target));
      for (const v of [va, vb]) {
        const rep = await replayV3({
          serverSeed: v.serverSeed, clientSeed: v.clientSeed ?? null, nonce: v.nonce,
          snapshot: v.v3!.poolSnapshot, poolHash: v.v3!.poolHash, trace: v.v3!.fairTrace,
          prizeId: v.v3!.prizeId, prizeLabel: v.prizeLabel,
        });
        check("a racing spin (exclusion or not) replays", rep.ok);
      }
    } finally {
      mockSaveWheel(wheel);
    }
  }

  console.log(`spinParity.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
