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
