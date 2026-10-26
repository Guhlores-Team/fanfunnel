import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";
import type { Prize, WheelConfig } from "@/lib/games/wheel/types";

// Owner decision: the server enforces the wheel rules the editor shows, on
// save only. saveWheel rejects (before any read or write) a wheel with fewer
// than 2 prizes, a prize with a blank name, or no prize with tickets > 0 —
// on BOTH the in-memory mock path and the Supabase path.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "creator-1";
const db = new FakeSupabase(CREATOR);
db.tables.prizes = [];
let useSupabase = false;

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => db.client(),
    createServiceClient: () => db.client(),
  },
});

function prize(over: Partial<Prize> = {}): Prize {
  return { id: over.id ?? "p" + Math.random(), label: "Prize", rarity: "common", weight: 10, ...over };
}

const CASES: { name: string; prizes: Prize[]; code: string }[] = [
  { name: "no prizes", prizes: [], code: "too_few_prizes" },
  { name: "one prize", prizes: [prize({ label: "Only" })], code: "too_few_prizes" },
  { name: "empty prize name", prizes: [prize({ label: "A" }), prize({ label: "" })], code: "prize_name_required" },
  { name: "whitespace prize name", prizes: [prize({ label: "A" }), prize({ label: " \t " })], code: "prize_name_required" },
  {
    name: "every prize at 0 tickets",
    prizes: [prize({ label: "A", weight: 0 }), prize({ label: "B", weight: 0 })],
    code: "no_winnable_prize",
  },
];

async function main() {
  const { saveWheel } = await import("./index");
  const { mockGetWheel } = await import("./mock");

  // --- mock path --------------------------------------------------------------
  useSupabase = false;
  const base = mockGetWheel();
  for (const c of CASES) {
    const r = await saveWheel({ ...base, title: "Changed", prizes: c.prizes });
    check(`mock: ${c.name} → ${c.code}`, "error" in r && r.error === c.code);
    const after = mockGetWheel();
    check(
      `mock: ${c.name} → nothing persisted`,
      after.title === base.title && after.prizes.length === base.prizes.length
    );
  }
  {
    const prizes = [prize({ label: "A", weight: 0 }), prize({ label: "B", weight: 1 })];
    const r = await saveWheel({ ...base, prizes });
    check("mock: a valid wheel (one prize at 0 tickets) still saves", "wheel" in r && r.wheel.prizes.length === 2);
    const restored = await saveWheel(base);
    check("mock: restoring the original wheel saves", "wheel" in restored);
  }

  // --- Supabase path ----------------------------------------------------------
  useSupabase = true;
  const wheelRow = db.seed("wheels", { creator_id: CREATOR, title: "Live", is_active: true });
  const wheelId = wheelRow.id as string;
  db.seed("prizes", { wheel_id: wheelId, label: "Old A", rarity: "common", weight: 5, sort_order: 0 });
  db.seed("prizes", { wheel_id: wheelId, label: "Old B", rarity: "common", weight: 5, sort_order: 1 });
  const cfg: WheelConfig = { id: wheelId, title: "Changed", brandColor: "#ec4899", prizes: [] };
  const labels = () => db.rows("prizes").map((p) => p.label).join();

  for (const c of CASES) {
    const before = db.statements.length;
    const r = await saveWheel({ ...cfg, prizes: c.prizes });
    check(`supabase: ${c.name} → ${c.code}`, "error" in r && r.error === c.code);
    const writes = db.statements.slice(before).filter((s) => s.op !== "select");
    check(`supabase: ${c.name} → no write ran`, writes.length === 0);
    check(`supabase: ${c.name} → wheel title untouched`, db.row("wheels", wheelId).title === "Live");
    check(`supabase: ${c.name} → old prizes kept`, labels() === "Old A,Old B");
  }
  {
    const prizes = [prize({ label: "New A", weight: 0 }), prize({ label: "New B", weight: 3 })];
    const r = await saveWheel({ ...cfg, prizes });
    check("supabase: a valid wheel still saves", "wheel" in r);
    check("supabase: wheel row updated", db.row("wheels", wheelId).title === "Changed");
    check("supabase: prizes replaced", labels() === "New A,New B");
  }

  console.log(`wheelRules.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
