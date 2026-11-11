import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";
import { mockCreatePass, mockGrantSpins, mockListFans } from "./mock";

// Ledger invariant: a fan's aggregate balance equals the sum of their active
// passes' spins_remaining (fans == SUM(passes)), owned since 0035 by a trigger
// on fan_passes. grantSpins tops up one pass in several round trips while the
// fan may be spinning (claim_spin) at the same time. Nothing it writes may be
// computed from a balance read before a spin landed: not the fan aggregate
// (the trigger owns it) and not the pass itself.

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
  const { grantSpins } = await import("./index");
  const wheel = db.seed("wheels", { creator_id: CREATOR, is_active: true });

  // A fan who bought 5 spins and has spun 3 of them (2 left).
  const fan = db.seed("fans", { creator_id: CREATOR, display_name: "Tipper" });
  const pass = db.seed("fan_passes", {
    token: "tok-tip",
    creator_id: CREATOR,
    wheel_id: wheel.id,
    fan_id: fan.id,
    spins_remaining: 2,
    spins_granted_total: 5,
  });
  const fanId = fan.id as string;
  const passId = pass.id as string;
  check("setup: aggregate starts in sync (2)", db.row("fans", fanId).spins_remaining === 2);

  // 1. Plain top-up: pass 2 + 3 = 5, aggregate follows.
  const plain = await grantSpins("tok-tip", 3);
  assert.ok(!("error" in plain), `plain top-up succeeded: ${JSON.stringify(plain)}`);
  check("plain: returns the pass balance (5)", plain.spinsRemaining === 5);
  check("plain: pass is 5", db.row("fan_passes", passId).spins_remaining === 5);
  check("plain: pass granted_total is 8", db.row("fan_passes", passId).spins_granted_total === 8);
  check("plain: fans == SUM(passes)", invariantHolds(fanId));

  // 2. A spin lands between the pass write and whatever statement follows it.
  //    The 0035 trigger set the aggregate on both writes; a fans update computed
  //    from a value read before the spin would overwrite it.
  let interleaved = 0;
  let passWritten = false;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "fan_passes" && stmt.op === "update") {
      passWritten = true;
    } else if (passWritten && interleaved === 0) {
      interleaved++;
      assert.strictEqual(db.spin("tok-tip"), 4, "concurrent spin sees only the committed 5, never the in-flight credit");
    }
  };
  const afterPass = await grantSpins("tok-tip", 3);
  db.beforeStatement = null;
  assert.ok(!("error" in afterPass), `top-up with a spin after the pass write succeeded: ${JSON.stringify(afterPass)}`);
  if (interleaved === 0) {
    // Nothing followed the pass write, so the spin lands after grantSpins
    // returned; the trigger owns the aggregate either way.
    assert.strictEqual(db.spin("tok-tip"), 7, "spin after grantSpins");
  }
  check("race A: pass is 5 + 3 - 1 = 7", db.row("fan_passes", passId).spins_remaining === 7);
  check(
    `race A: fan aggregate equals SUM(passes) (got ${db.row("fans", fanId).spins_remaining}, want 7)`,
    db.row("fans", fanId).spins_remaining === 7
  );
  check("race A: invariant holds", invariantHolds(fanId));
  check(
    "grantSpins never writes fans.spins_remaining (the trigger owns it)",
    !db.statements.some(
      (s) => s.table === "fans" && s.op === "update" && s.payload != null && "spins_remaining" in (s.payload as object)
    )
  );

  // 3. A spin lands between grantSpins's read of the pass and its write of the
  //    pass. The write must be based on the fresh balance (7 - 1 + 3 = 9), not
  //    overwrite the spin (7 + 3 = 10).
  interleaved = 0;
  db.beforeStatement = (stmt) => {
    if (stmt.table === "fan_passes" && stmt.op === "update" && interleaved === 0) {
      interleaved++;
      assert.strictEqual(db.spin("tok-tip"), 6, "interleaved spin before the pass write");
    }
  };
  const beforeWrite = await grantSpins("tok-tip", 3);
  db.beforeStatement = null;
  assert.ok(!("error" in beforeWrite), `top-up with a spin before the pass write succeeded: ${JSON.stringify(beforeWrite)}`);
  check("race B: a spin was interleaved", interleaved === 1);
  check(
    `race B: pass is 7 - 1 + 3 = 9, the spin is kept (got ${db.row("fan_passes", passId).spins_remaining})`,
    db.row("fan_passes", passId).spins_remaining === 9
  );
  check("race B: returns the fresh pass balance (9)", beforeWrite.spinsRemaining === 9);
  check("race B: pass granted_total is 14", db.row("fan_passes", passId).spins_granted_total === 14);
  check("race B: fans == SUM(passes)", invariantHolds(fanId));

  // 4. Unknown token.
  const missing = await grantSpins("tok-nope", 3);
  check("unknown token is not_found", "error" in missing && missing.error === "not_found");

  // --- Mock path: same invariant ------------------------------------------
  const m = mockCreatePass("Mocked", 5);
  check("mock top-up returns the pass balance (8)", mockGrantSpins(m.token, 3) === 8);
  const summary = mockListFans().find((f) => f.fanId === m.fanId);
  assert.ok(summary, "mock fan listed");
  check(
    "mock top-up: fan aggregate equals SUM(passes)",
    summary.spinsRemaining === summary.passes.reduce((s, p) => s + p.spinsRemaining, 0)
  );
  check("mock unknown token is null", mockGrantSpins("tok-nope", 3) === null);

  console.log(`grantSpinsLedger.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
