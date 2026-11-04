import assert from "node:assert";
import { mock } from "node:test";

// A42 (0067) demo parity: cancelling a won limited prize returns its unit to
// stock exactly once, reopening takes it again (sold_out when none is left),
// and unlimited prizes move nothing. (Instant rewards stay uncancellable:
// rewardRoutes.test.ts in demo mode, the focus-ledger probe in SQL.)
// The database half (set_redemption_state, races, negatives) is the interplay
// section 7 in scripts/db/interplayProbe.mjs, run by schema-drift-check.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => false,
    createClient: async () => { throw new Error("demo mode only"); },
    createServiceClient: () => { throw new Error("demo mode only"); },
  },
});

async function main() {
  const data = await import("./index");
  const m = await import("./mock");
  const { PATCH } = await import("@/app/api/redemptions/[id]/route");
  const patch = async (id: string, body: unknown) => {
    const res = await PATCH(new Request(`http://localhost/api/redemptions/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as { ok?: boolean; stock?: string; error?: string } };
  };

  // Only the limited prize can be won: every other prize weighs 0.
  const base = await data.getWheel();
  assert.ok(base, "demo wheel");
  const target = base.prizes[0];
  const saved = await data.saveWheel({ ...base, prizes: base.prizes.map((p) => (p.id === target.id ? { ...p, weight: 10, stock: 3, delivery: "manual" } : { ...p, weight: 0, stock: null })) });
  assert.ok("wheel" in saved, "limited wheel saved");
  const stock = async () => (await data.getWheel())!.prizes.find((p) => p.id === target.id)!.stock;
  const fan = m.mockCreatePass("Restock fan", 3);
  m.mockAckFan(fan.token);
  const win = await m.mockSpin(fan.token);
  assert.ok(!("error" in win), "the fan wins");
  check("the win takes one unit (3 -> 2)", (await stock()) === 2);
  const row = (await data.getOverview()).redemptions.find((r) => r.prizeLabel === target.label && r.status === "pending");
  assert.ok(row, "the won prize is in the queue");

  let out = await patch(row.id, { status: "cancelled" });
  check("cancelling returns the unit and says so", out.status === 200 && out.body.stock === "returned" && (await stock()) === 3);
  out = await patch(row.id, { status: "cancelled" });
  check("a repeat cancel moves nothing", out.status === 200 && out.body.stock === undefined && (await stock()) === 3);
  out = await patch(row.id, { status: "pending" });
  check("reopening takes the unit again", out.status === 200 && out.body.stock === "taken" && (await stock()) === 2);
  out = await patch(row.id, { status: "in_progress", notes: "packing" });
  check("a status change that is not a cancel or reopen moves nothing", out.status === 200 && out.body.stock === undefined && (await stock()) === 2);
  await patch(row.id, { status: "cancelled" });
  const current = (await data.getWheel())!;
  await data.saveWheel({ ...current, prizes: current.prizes.map((p) => (p.id === target.id ? { ...p, stock: 0 } : p)) });
  out = await patch(row.id, { status: "pending" });
  check("reopening with no unit left is 409 sold_out and changes nothing", out.status === 409 && out.body.error === "sold_out" && (await stock()) === 0 && (await data.getOverview()).redemptions.find((r) => r.id === row.id)?.status === "cancelled");

  // A prize made unlimited after the win stops tracking the unit.
  const unlimited = (await data.getWheel())!;
  await data.saveWheel({ ...unlimited, prizes: unlimited.prizes.map((p) => (p.id === target.id ? { ...p, stock: null } : p)) });
  out = await patch(row.id, { status: "pending" });
  check("reopening a prize made unlimited takes nothing", out.status === 200 && out.body.stock === undefined && (await stock()) === null);
  const again = await m.mockSpin(fan.token);
  assert.ok(!("error" in again), "an unlimited win");
  const unlimitedRow = (await data.getOverview()).redemptions.find((r) => r.prizeLabel === target.label && r.status === "pending" && r.id !== row.id);
  assert.ok(unlimitedRow, "the unlimited win is queued");
  out = await patch(unlimitedRow.id, { status: "cancelled" });
  check("an unlimited win holds no unit: its cancel moves nothing", out.status === 200 && out.body.stock === undefined && (await stock()) === null);

  console.log(`redemption restock (demo): ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
