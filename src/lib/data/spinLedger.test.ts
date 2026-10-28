import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";
import { mockCreatePass, mockListFans } from "./mock";

// Ledger invariant: a fan's aggregate balance equals the sum of their active
// passes' spins_remaining (fans == SUM(passes)). Migration 0035 maintains the
// aggregate with a trigger on fan_passes, so application code that ALSO adds
// the new spins to a re-read aggregate credits them twice. Regression for the
// top-up path of createPass: the dashboard showed too many spins until the next
// spin resynced the aggregate ("shows N then drops").

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "creator-1";
const db = new FakeSupabase(CREATOR);

// Swap the real Supabase client for the in-memory fake (0035 trigger included)
// BEFORE the data layer is imported, so createPass takes its Supabase path.
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
  const { createPass } = await import("./index");

  const wheelA = db.seed("wheels", { creator_id: CREATOR, is_active: true });
  const wheelB = db.seed("wheels", { creator_id: CREATOR });

  // --- Supabase path: top up an existing pass -------------------------------
  // A fan who bought 5 spins on wheel A and has spun 3 of them.
  const fan = db.seed("fans", { creator_id: CREATOR, display_name: "Topper" });
  db.seed("fan_passes", {
    token: "tok-a",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: fan.id,
    spins_remaining: 2,
    spins_granted_total: 5,
  });
  check("setup: aggregate starts in sync (2)", db.row("fans", fan.id as string).spins_remaining === 2);

  const topUp = await createPass({
    name: "Topper",
    spins: 3,
    fanId: fan.id as string,
    wheelId: wheelA.id as string,
    amountCents: 300,
  });
  assert.ok(!("error" in topUp), `top-up succeeded: ${JSON.stringify(topUp)}`);
  check("top-up reuses the existing wheel-A pass", topUp.token === "tok-a");
  check("top-up: pass balance is 2 + 3 = 5", db.sumPasses(fan.id as string) === 5);
  check(
    `top-up: fan aggregate equals SUM(passes) (got ${db.row("fans", fan.id as string).spins_remaining}, want 5)`,
    db.row("fans", fan.id as string).spins_remaining === 5
  );
  check("top-up: fans == SUM(passes) for remaining and granted_total", invariantHolds(fan.id as string));

  // --- Supabase path: existing fan, first pass on ANOTHER wheel ---------------
  const second = await createPass({
    name: "Topper",
    spins: 4,
    fanId: fan.id as string,
    wheelId: wheelB.id as string,
  });
  assert.ok(!("error" in second), `second-wheel pass succeeded: ${JSON.stringify(second)}`);
  check("new wheel pass: passes sum to 5 + 4 = 9", db.sumPasses(fan.id as string) === 9);
  check(
    `new wheel pass: fan aggregate equals SUM(passes) (got ${db.row("fans", fan.id as string).spins_remaining}, want 9)`,
    db.row("fans", fan.id as string).spins_remaining === 9
  );
  check("new wheel pass: invariant holds", invariantHolds(fan.id as string));

  // --- Supabase path: brand-new fan ------------------------------------------
  const fresh = await createPass({ name: "Newbie", spins: 6, wheelId: wheelA.id as string });
  assert.ok(!("error" in fresh), `new fan succeeded: ${JSON.stringify(fresh)}`);
  check("new fan: aggregate is the pass balance (6)", db.row("fans", fresh.fanId).spins_remaining === 6);
  check("new fan: invariant holds", invariantHolds(fresh.fanId));

  // --- Supabase path: a spin lands while the top-up is still in flight -------
  // createPass is several round trips. The aggregate is owned by the 0035
  // trigger (claim_spin and the pass write both fire it), so a fan spinning
  // between the pass write and the end of createPass must not be overwritten
  // by any fans.spins_remaining the code computed from an earlier read.
  const racer = db.seed("fans", { creator_id: CREATOR, display_name: "Racer" });
  db.seed("fan_passes", {
    token: "tok-race",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: racer.id,
    spins_remaining: 2,
    spins_granted_total: 5,
  });
  let interleaved = 0;
  let passWritten = false;
  db.beforeStatement = (stmt) => {
    // The fan spins between the pass write and whatever statement follows it.
    if (stmt.table === "fan_passes" && stmt.op === "update") {
      passWritten = true;
    } else if (passWritten && interleaved === 0) {
      interleaved++;
      const left = db.spin("tok-race");
      assert.strictEqual(left, 1, "concurrent spin sees only the committed 2; the credit is atomic");
    }
  };
  const raced = await createPass({
    name: "Racer",
    spins: 3,
    fanId: racer.id as string,
    wheelId: wheelA.id as string,
    amountCents: 300,
  });
  db.beforeStatement = null;
  assert.ok(!("error" in raced), `raced top-up succeeded: ${JSON.stringify(raced)}`);
  check("race: a spin was interleaved", interleaved === 1);
  check("race: passes sum to 2 + 3 - 1 = 4", db.sumPasses(racer.id as string) === 4);
  check(
    `race: fan aggregate equals SUM(passes) after an interleaved spin (got ${db.row("fans", racer.id as string).spins_remaining}, want 4)`,
    db.row("fans", racer.id as string).spins_remaining === 4
  );
  check("race: invariant holds", invariantHolds(racer.id as string));
  check(
    "createPass never writes fans.spins_remaining for an existing fan (the trigger owns it)",
    !db.statements.some(
      (s) => s.table === "fans" && s.op === "update" && s.payload != null && "spins_remaining" in (s.payload as object)
    )
  );

  // --- Supabase path: a spin lands between the pass read and the pass write --
  // The top-up must be applied to the balance as it is at write time (5 - 1 + 3
  // = 7), not overwrite the spin with read + 3 = 8 (a free spin for the fan).
  const racer2 = db.seed("fans", { creator_id: CREATOR, display_name: "Racer2" });
  const racer2Pass = db.seed("fan_passes", {
    token: "tok-race2",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: racer2.id,
    spins_remaining: 5,
    spins_granted_total: 5,
  });
  interleaved = 0;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "fan_passes" && stmt.op === "update" && interleaved === 0) {
      interleaved++;
      assert.strictEqual(db.spin("tok-race2"), 4, "interleaved spin before the pass write");
    }
  };
  const raced2 = await createPass({
    name: "Racer2",
    spins: 3,
    fanId: racer2.id as string,
    wheelId: wheelA.id as string,
  });
  db.beforeStatement = null;
  assert.ok(!("error" in raced2), `top-up with a spin before the pass write succeeded: ${JSON.stringify(raced2)}`);
  check("race B: a spin was interleaved", interleaved === 1);
  check(
    `race B: pass is 5 - 1 + 3 = 7, the spin is kept (got ${db.row("fan_passes", racer2Pass.id as string).spins_remaining})`,
    db.row("fan_passes", racer2Pass.id as string).spins_remaining === 7
  );
  check("race B: pass granted_total is 8", db.row("fan_passes", racer2Pass.id as string).spins_granted_total === 8);
  check("race B: invariant holds", invariantHolds(racer2.id as string));

  // --- Supabase path: the grant insert fails after a spin landed -------------
  // The failed grant and credit roll back together. A concurrent spin spends
  // one previously committed spin (7 -> 6); uncommitted credit is never visible.
  const grantsBefore = db.rows("grants").filter((g) => g.fan_id === racer2.id).length;
  let grantFailed = 0;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "grants" && stmt.op === "insert" && grantFailed === 0) {
      grantFailed++;
      assert.strictEqual(db.spin("tok-race2"), 6, "a concurrent spin sees 7 committed spins, never the failed top-up");
      return { message: "injected grant insert failure" };
    }
  };
  const rolledBack = await createPass({
    name: "Racer2",
    spins: 3,
    fanId: racer2.id as string,
    wheelId: wheelA.id as string,
  });
  db.beforeStatement = null;
  check("rollback: a failed grant insert fails the top-up", "error" in rolledBack && rolledBack.error === "db_error");
  check("rollback: the grant insert was the statement that failed", grantFailed === 1);
  check(
    `rollback: pass is 9 - 3 = 6, the spin is not refunded (got ${db.row("fan_passes", racer2Pass.id as string).spins_remaining})`,
    db.row("fan_passes", racer2Pass.id as string).spins_remaining === 6
  );
  check("rollback: pass granted_total is back to 8", db.row("fan_passes", racer2Pass.id as string).spins_granted_total === 8);
  check(
    "rollback: no grant row was added",
    db.rows("grants").filter((g) => g.fan_id === racer2.id).length === grantsBefore
  );
  check("rollback: invariant holds", invariantHolds(racer2.id as string));

  // --- Mock path: same invariant --------------------------------------------
  const m = mockCreatePass("Mocked", 5);
  const again = mockCreatePass("Mocked", 3, m.fanId);
  check("mock top-up keeps the same token", again.token === m.token);
  const summary = mockListFans().find((f) => f.fanId === m.fanId);
  assert.ok(summary, "mock fan listed");
  const mockSum = summary.passes.reduce((s, p) => s + p.spinsRemaining, 0);
  check("mock top-up: pass balance is 5 + 3 = 8", mockSum === 8);
  check("mock top-up: fan aggregate equals SUM(passes)", summary.spinsRemaining === mockSum);

  console.log(`spinLedger.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
