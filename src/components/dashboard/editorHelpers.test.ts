import assert from "node:assert";
import { type Prize, RARITY_ORDER } from "@/lib/games/wheel/types";
import { reorder, duplicatePrize, balanceOdds } from "./editorHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- reorder -------------------------------------------------------------
{
  const input = [0, 1, 2, 3, 4];
  const out = reorder(input, 1, 3);
  check("reorder moves item correctly", JSON.stringify(out) === JSON.stringify([0, 2, 3, 1, 4]));
  check("reorder does not mutate input", JSON.stringify(input) === JSON.stringify([0, 1, 2, 3, 4]));

  const clamped = reorder(input, 0, 99);
  check("reorder clamps out-of-range target", JSON.stringify(clamped) === JSON.stringify([1, 2, 3, 4, 0]));
}

// --- duplicatePrize ------------------------------------------------------
{
  const p: Prize = { id: "abc", label: "VIP", rarity: "rare", weight: 7, emoji: "💎" };
  const dup = duplicatePrize(p);
  check("duplicatePrize has new id", dup.id !== p.id);
  check("duplicatePrize keeps the label as-is", dup.label === "VIP");
  check("duplicatePrize keeps other fields", dup.rarity === "rare" && dup.weight === 7 && dup.emoji === "💎");
  check("duplicatePrize does not mutate input", p.label === "VIP" && p.id === "abc");
}

// --- balanceOdds ---------------------------------------------------------
{
  const prizes: Prize[] = [
    { id: "a", label: "A", rarity: "common", weight: 30 },
    { id: "b", label: "B", rarity: "common", weight: 10 },
    { id: "c", label: "C", rarity: "rare", weight: 5 },
    { id: "d", label: "D", rarity: "legendary", weight: 1 },
  ];
  const out = balanceOdds(prizes);

  check("balanceOdds preserves count", out.length === prizes.length);
  check("balanceOdds preserves order/ids", out.every((p, i) => p.id === prizes[i].id));

  const total = out.reduce((s, p) => s + p.weight, 0);
  check("balanceOdds total weight > 0", total > 0);
  check("balanceOdds never all-zero", out.every((p) => p.weight >= 0) && out.some((p) => p.weight > 0));

  // Within-tier relative share preserved (common: A:B was 3:1).
  const a = out.find((p) => p.id === "a")!.weight;
  const b = out.find((p) => p.id === "b")!.weight;
  check("balanceOdds preserves within-tier ratio", Math.abs(a / b - 3) < 1e-9);

  // Tier totals are non-increasing by RARITY_ORDER.
  const tierTotal = (rarity: string) =>
    out.filter((p) => p.rarity === rarity).reduce((s, p) => s + p.weight, 0);
  const presentTiers = RARITY_ORDER.filter((r) => out.some((p) => p.rarity === r));
  let monotone = true;
  for (let i = 1; i < presentTiers.length; i++) {
    if (tierTotal(presentTiers[i]) > tierTotal(presentTiers[i - 1]) + 1e-9) monotone = false;
  }
  check("balanceOdds tier totals non-increasing by rarity order", monotone);
}

console.log(`editorHelpers.test: ${passed} checks passed`);
