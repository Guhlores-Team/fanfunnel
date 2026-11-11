import assert from "node:assert";
import type { Prize, WheelConfig } from "@/lib/games/wheel/types";

// Round-trip: Balance odds → what each data path stores. The prize weight
// column is int4, so a fractional weight must never be stored as 0 (a 0-weight
// prize can never be won). Run in mock mode so nothing reaches a real project.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function ratiosClose(a: number[], b: number[], tol: number): boolean {
  const sa = a.reduce((s, w) => s + w, 0);
  const sb = b.reduce((s, w) => s + w, 0);
  return a.every((w, i) => Math.abs(w / sa - b[i] / sb) <= tol);
}

(async () => {
  const { balanceOdds } = await import("@/components/dashboard/editorHelpers");
  const { prizeRow } = await import("@/lib/data");
  const { mockSaveWheel } = await import("@/lib/data/mock");

  // Two legendaries share a tier total of 1 → 0.5 each before the fix.
  const prizes: Prize[] = [
    { id: "a", label: "A", rarity: "common", weight: 30 },
    { id: "b", label: "B", rarity: "common", weight: 10 },
    { id: "c", label: "C", rarity: "rare", weight: 5 },
    { id: "d", label: "D", rarity: "legendary", weight: 3 },
    { id: "e", label: "E", rarity: "legendary", weight: 3 },
    { id: "f", label: "F", rarity: "epic", weight: 0 },
  ];
  const balanced = balanceOdds(prizes);
  const intended = [
    5 * (30 / 40), 5 * (10 / 40), // common tier = 5, split 3:1
    3, // rare tier = 3
    0.5, 0.5, // legendary tier = 1, split evenly
  ];

  check("balanceOdds weights are integers", balanced.every((p) => Number.isInteger(p.weight)));
  check("balanceOdds weights all ≥ 1", balanced.every((p) => p.weight >= 1));
  check(
    "balanceOdds keeps the intended ratios (non-zero prizes) within rounding",
    ratiosClose(balanced.slice(0, 5).map((p) => p.weight), intended, 0.002),
  );

  // Supabase path: prizeRow is what saveWheel inserts.
  const rows = balanced.map((p, i) => prizeRow("w1", p, i));
  check("prizeRow keeps every weight > 0", rows.every((r) => r.weight > 0));
  check("prizeRow stores the balanced weights unchanged", rows.every((r, i) => r.weight === balanced[i].weight));

  // A raw fractional weight (e.g. an older client) is rounded, not truncated.
  check("prizeRow 0.5 → 1", prizeRow("w1", { ...prizes[0], weight: 0.5 }, 0).weight === 1);
  check("prizeRow 2.6 → 3", prizeRow("w1", { ...prizes[0], weight: 2.6 }, 0).weight === 3);
  check("prizeRow 0 stays 0", prizeRow("w1", { ...prizes[0], weight: 0 }, 0).weight === 0);

  // Mock path: mirrors the int4 column.
  const wheel: WheelConfig = { id: "demo-wheel", title: "T", prizes: [...balanced, { ...prizes[0], id: "g", weight: 0.5 }] };
  const saved = mockSaveWheel(wheel);
  check("mock save keeps every weight > 0", saved.prizes.every((p) => p.weight > 0));
  check("mock save stores integers", saved.prizes.every((p) => Number.isInteger(p.weight)));
  check("mock save rounds 0.5 up to 1", saved.prizes.find((p) => p.id === "g")?.weight === 1);

  console.log(`prizeWeights: ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
