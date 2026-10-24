import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";
import {
  mockAckFan,
  mockCreatePass,
  mockEditGrant,
  mockGetFanDetail,
  mockListFans,
  mockSpin,
} from "./mock";

// Ledger invariant: a fan's aggregate balance equals the sum of their active
// passes' spins_remaining (fans == SUM(passes)), maintained since 0035 by a
// trigger on fan_passes. editGrant changes the spins of an existing grant
// after some of them may already have been spun. These checks pin down what an
// edit may do: never push a pass negative, never leave fans != SUM(passes),
// and never mint spins that were already spent.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "creator-1";
const db = new FakeSupabase(CREATOR);

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => db.client(),
    createServiceClient: () => db.client(),
  },
});

function invariantHolds(fanId: string): boolean {
  const fan = db.row("fans", fanId);
  return (
    fan.spins_remaining === db.sumPasses(fanId, "spins_remaining") &&
    fan.spins_granted_total === db.sumPasses(fanId, "spins_granted_total")
  );
}

async function main() {
  const { editGrant } = await import("./index");
  const wheelA = db.seed("wheels", { creator_id: CREATOR, is_active: true });
  const wheelB = db.seed("wheels", { creator_id: CREATOR });

  // --- Supabase path -----------------------------------------------------------
  // Fan with two passes: wheel A got a 5-spin grant and has spun 3 of them
  // (2 left); wheel B has an untouched 4-spin grant. Aggregate = 2 + 4 = 6.
  const fan = db.seed("fans", { creator_id: CREATOR, display_name: "Edited" });
  const passA = db.seed("fan_passes", {
    token: "tok-a",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: fan.id,
    spins_remaining: 2,
    spins_granted_total: 5,
  });
  const passB = db.seed("fan_passes", {
    token: "tok-b",
    creator_id: CREATOR,
    wheel_id: wheelB.id,
    fan_id: fan.id,
    spins_remaining: 4,
    spins_granted_total: 4,
  });
  const grantA = db.seed("grants", {
    creator_id: CREATOR,
    fan_id: fan.id,
    fan_pass_id: passA.id,
    spins: 5,
    amount_cents: 500,
  });
  db.seed("grants", {
    creator_id: CREATOR,
    fan_id: fan.id,
    fan_pass_id: passB.id,
    spins: 4,
    amount_cents: 400,
  });
  const fanId = fan.id as string;
  check("setup: aggregate is 6", db.row("fans", fanId).spins_remaining === 6);

  // 1. Cutting the partly-spent grant from 5 to 1 would take the pass to -2:
  //    3 of the 5 are already spun and can't be un-granted. Refused, no change.
  const tooDeep = await editGrant(grantA.id as string, { spins: 1 });
  check(
    `shrink 5->1 is refused as insufficient_spins (got ${JSON.stringify(tooDeep)})`,
    "error" in tooDeep && tooDeep.error === "insufficient_spins"
  );
  check("refused shrink: grant row still says 5", db.row("grants", grantA.id as string).spins === 5);
  check("refused shrink: pass A still 2", db.row("fan_passes", passA.id as string).spins_remaining === 2);
  check("refused shrink: fans == SUM(passes)", invariantHolds(fanId));

  // 2. Cutting it to 3 (= exactly what was spent) is the deepest allowed cut:
  //    the pass gives back its 2 unspent spins and lands on 0, never below.
  const shrink = await editGrant(grantA.id as string, { spins: 3 });
  check("shrink 5->3 is accepted", "ok" in shrink);
  check("shrink: grant row says 3", db.row("grants", grantA.id as string).spins === 3);
  check("shrink: pass A is 0, not negative", db.row("fan_passes", passA.id as string).spins_remaining === 0);
  check("shrink: pass A granted_total is 3", db.row("fan_passes", passA.id as string).spins_granted_total === 3);
  check("shrink: pass B is untouched (4)", db.row("fan_passes", passB.id as string).spins_remaining === 4);
  check(
    `shrink: fans == SUM(passes) (fan ${db.row("fans", fanId).spins_remaining}, sum ${db.sumPasses(fanId)})`,
    invariantHolds(fanId)
  );

  // 3. Grow it back to 5. The fan already spun 3 of the original 5, so the pass
  //    ends at 2 again (the 3 spent spins are not re-minted).
  const grow = await editGrant(grantA.id as string, { spins: 5 });
  check("grow 3->5 is accepted", "ok" in grow);
  check(
    `grow: pass A is back to 2, not more (got ${db.row("fan_passes", passA.id as string).spins_remaining})`,
    db.row("fan_passes", passA.id as string).spins_remaining === 2
  );
  check("grow: pass A granted_total is back to 5", db.row("fan_passes", passA.id as string).spins_granted_total === 5);
  check("grow: fans == SUM(passes)", invariantHolds(fanId));

  // 4. Grow a grant on a fan whose aggregate is the sum of several passes: the
  //    delta lands on the grant's pass only and the aggregate follows.
  const grow2 = await editGrant(grantA.id as string, { spins: 8 });
  check("grow 5->8 is accepted", "ok" in grow2);
  check("grow2: pass A is 2 + 3 = 5", db.row("fan_passes", passA.id as string).spins_remaining === 5);
  check("grow2: pass B is untouched (4)", db.row("fan_passes", passB.id as string).spins_remaining === 4);
  check("grow2: aggregate is 5 + 4 = 9", db.row("fans", fanId).spins_remaining === 9);
  check("grow2: fans == SUM(passes)", invariantHolds(fanId));

  // 5. A grant whose pass is gone (fan_pass_id null — the FK is ON DELETE SET
  //    NULL). The delta must land on a spendable pass (the fan's oldest active
  //    one), not float on the fan aggregate alone where the next spin's trigger
  //    resync would wipe it.
  const orphan = db.seed("grants", {
    creator_id: CREATOR,
    fan_id: fan.id,
    fan_pass_id: null,
    spins: 2,
    amount_cents: 0,
  });
  const orphanEdit = await editGrant(orphan.id as string, { spins: 6 });
  check("orphan grant edit is accepted", "ok" in orphanEdit);
  check("orphan: +4 landed on the oldest active pass (A: 5 + 4 = 9)", db.row("fan_passes", passA.id as string).spins_remaining === 9);
  check(
    `orphan: fans == SUM(passes) (fan ${db.row("fans", fanId).spins_remaining}, sum ${db.sumPasses(fanId)})`,
    invariantHolds(fanId)
  );

  // 6. Money/campaign-only edits never touch balances.
  const before = db.row("fans", fanId).spins_remaining;
  const moneyEdit = await editGrant(grantA.id as string, { amountCents: 999 });
  check("amount-only edit is accepted", "ok" in moneyEdit);
  check("amount-only edit leaves the aggregate alone", db.row("fans", fanId).spins_remaining === before);
  check("amount-only edit keeps the invariant", invariantHolds(fanId));

  // 7. A spin lands between editGrant's read of the pass and its write. The
  //    write must not be based on the stale read: the over-cut check has to
  //    see the new balance (here it now fails: 1 left, cut asks for 2 back).
  const racer = db.seed("fans", { creator_id: CREATOR, display_name: "Racer" });
  const racePass = db.seed("fan_passes", {
    token: "tok-race",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: racer.id,
    spins_remaining: 2,
    spins_granted_total: 5,
  });
  const raceGrant = db.seed("grants", {
    creator_id: CREATOR,
    fan_id: racer.id,
    fan_pass_id: racePass.id,
    spins: 5,
    amount_cents: 500,
  });
  const raceId = racer.id as string;
  let spinsInjected = 0;
  db.beforeStatement = (stmt) => {
    // Just before the first pass write: the fan spins (2 -> 1).
    if (stmt.table === "fan_passes" && stmt.op === "update" && spinsInjected === 0) {
      spinsInjected++;
      assert.strictEqual(db.spin("tok-race"), 1, "interleaved spin");
    }
  };
  const racedCut = await editGrant(raceGrant.id as string, { spins: 3 });
  db.beforeStatement = null;
  check("race: a spin was interleaved before the pass write", spinsInjected === 1);
  check(
    `race: cut 5->3 after the fan spun to 1 left is refused (got ${JSON.stringify(racedCut)})`,
    "error" in racedCut && racedCut.error === "insufficient_spins"
  );
  check("race: grant row untouched (5)", db.row("grants", raceGrant.id as string).spins === 5);
  check("race: pass keeps the spin that landed (1 of 5)", db.row("fan_passes", racePass.id as string).spins_remaining === 1);
  check("race: pass granted_total untouched (5)", db.row("fan_passes", racePass.id as string).spins_granted_total === 5);
  check("race: fans == SUM(passes)", invariantHolds(raceId));

  // 8. Same interleaving on a grow: the write retries from the fresh balance
  //    instead of overwriting the spin (1 + 1 = 2, not 2 + 1 = 3).
  spinsInjected = 0;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "fan_passes" && stmt.op === "update" && spinsInjected === 0) {
      spinsInjected++;
      assert.strictEqual(db.spin("tok-race"), 0, "interleaved spin");
    }
  };
  const racedGrow = await editGrant(raceGrant.id as string, { spins: 6 });
  db.beforeStatement = null;
  check("race grow: accepted", "ok" in racedGrow);
  check("race grow: grant row says 6", db.row("grants", raceGrant.id as string).spins === 6);
  check(
    `race grow: pass is 0 + 1 = 1, the interleaved spin is kept (got ${db.row("fan_passes", racePass.id as string).spins_remaining})`,
    db.row("fan_passes", racePass.id as string).spins_remaining === 1
  );
  check("race grow: pass granted_total is 6", db.row("fan_passes", racePass.id as string).spins_granted_total === 6);
  check("race grow: fans == SUM(passes)", invariantHolds(raceId));

  // 9. A failing read after the pass write must not be able to zero the
  //    aggregate: editGrant leaves fans.spins_remaining to the 0035 trigger and
  //    never writes it itself.
  let passWritten = false;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "fan_passes" && stmt.op === "update") passWritten = true;
    else if (passWritten && stmt.table === "fan_passes" && stmt.op === "select") {
      return { message: "injected read failure" };
    }
  };
  const sumBefore = db.sumPasses(raceId);
  const afterFailedRead = await editGrant(raceGrant.id as string, { spins: 8 });
  db.beforeStatement = null;
  check("failed read: edit outcome is consistent with the rows", "ok" in afterFailedRead
    ? db.row("grants", raceGrant.id as string).spins === 8 && db.sumPasses(raceId) === sumBefore + 2
    : db.row("grants", raceGrant.id as string).spins === 6 && db.sumPasses(raceId) === sumBefore);
  check(
    `failed read: aggregate not zeroed (fan ${db.row("fans", raceId).spins_remaining}, sum ${db.sumPasses(raceId)})`,
    invariantHolds(raceId) && (db.row("fans", raceId).spins_remaining as number) > 0
  );
  check(
    "editGrant never writes fans.spins_remaining (the trigger owns it)",
    !db.statements.some(
      (s) => s.table === "fans" && s.op === "update" && s.payload != null && "spins_remaining" in (s.payload as object)
    )
  );

  // 10. A grant on a pass that was deactivated (self-exclusion) moves its spins
  //     via the fan's oldest ACTIVE pass; with no active pass at all a balance
  //     change is refused rather than silently dropped.
  const dormant = db.seed("fans", { creator_id: CREATOR, display_name: "Dormant" });
  const deadPass = db.seed("fan_passes", {
    token: "tok-dead",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: dormant.id,
    is_active: false,
    spins_remaining: 3,
    spins_granted_total: 3,
  });
  const deadGrant = db.seed("grants", {
    creator_id: CREATOR,
    fan_id: dormant.id,
    fan_pass_id: deadPass.id,
    spins: 3,
    amount_cents: 0,
  });
  const noPass = await editGrant(deadGrant.id as string, { spins: 5 });
  check(
    `no active pass: balance change refused (got ${JSON.stringify(noPass)})`,
    "error" in noPass && noPass.error === "no_active_pass"
  );
  check("no active pass: grant untouched (3)", db.row("grants", deadGrant.id as string).spins === 3);
  check("no active pass: dead pass untouched (3)", db.row("fan_passes", deadPass.id as string).spins_remaining === 3);
  const amountOnly = await editGrant(deadGrant.id as string, { amountCents: 100 });
  check("no active pass: amount-only edit still allowed", "ok" in amountOnly);
  const livePass = db.seed("fan_passes", {
    token: "tok-live",
    creator_id: CREATOR,
    wheel_id: wheelB.id,
    fan_id: dormant.id,
    spins_remaining: 1,
    spins_granted_total: 1,
  });
  const viaLive = await editGrant(deadGrant.id as string, { spins: 5 });
  check("dead pass grant: edit accepted once an active pass exists", "ok" in viaLive);
  check("dead pass grant: +2 landed on the active pass (1 + 2 = 3)", db.row("fan_passes", livePass.id as string).spins_remaining === 3);
  check("dead pass grant: inactive pass untouched (3)", db.row("fan_passes", deadPass.id as string).spins_remaining === 3);
  check("dead pass grant: fans == SUM(active passes)", invariantHolds(dormant.id as string));

  // 11. A non-finite spins patch is rejected before anything is read or written.
  const nan = await editGrant(grantA.id as string, { spins: Number.NaN });
  check("NaN spins rejected as invalid", "error" in nan && nan.error === "invalid");

  // --- Mock path: same rules -------------------------------------------------
  const m = mockCreatePass("MockEdited", 5, undefined, undefined, 500);
  mockAckFan(m.token);
  for (let i = 0; i < 3; i++) {
    const r = await mockSpin(m.token);
    assert.ok(r && !("error" in r), "mock spin succeeded");
  }
  const detail = mockGetFanDetail(m.fanId);
  assert.ok(detail, "mock fan detail");
  check("mock setup: 2 spins left after spinning 3 of 5", detail.spinsRemaining === 2);
  const grant = detail.grants[0];
  assert.ok(grant, "mock grant found");

  const mockTooDeep = mockEditGrant(grant.id, { spins: 1 });
  check(
    "mock shrink 5->1 refused as insufficient_spins",
    "error" in mockTooDeep && mockTooDeep.error === "insufficient_spins"
  );
  const afterRefused = mockGetFanDetail(m.fanId);
  assert.ok(afterRefused, "mock fan detail after refusal");
  check("mock refused shrink: grant still 5", afterRefused.grants[0]?.spins === 5);
  check("mock refused shrink: balance still 2", afterRefused.spinsRemaining === 2);

  check("mock shrink 5->3 accepted", "ok" in mockEditGrant(grant.id, { spins: 3 }));
  const afterShrink = mockListFans().find((f) => f.fanId === m.fanId);
  assert.ok(afterShrink, "mock fan listed");
  check("mock shrink: pass is 0, not negative", afterShrink.passes.every((p) => p.spinsRemaining === 0));
  check(
    "mock shrink: fans == SUM(passes)",
    afterShrink.spinsRemaining === afterShrink.passes.reduce((s, p) => s + p.spinsRemaining, 0)
  );

  check("mock grow 3->5 accepted", "ok" in mockEditGrant(grant.id, { spins: 5 }));
  const afterGrow = mockListFans().find((f) => f.fanId === m.fanId);
  assert.ok(afterGrow, "mock fan listed after grow");
  check(
    `mock grow: back to 2 spendable, spent spins not re-minted (got ${afterGrow.spinsRemaining})`,
    afterGrow.spinsRemaining === 2
  );
  check(
    "mock grow: fans == SUM(passes)",
    afterGrow.spinsRemaining === afterGrow.passes.reduce((s, p) => s + p.spinsRemaining, 0)
  );

  const mockNan = mockEditGrant(grant.id, { spins: Number.NaN });
  check("mock NaN spins rejected as invalid", "error" in mockNan && mockNan.error === "invalid");

  console.log(`editGrantLedger.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
