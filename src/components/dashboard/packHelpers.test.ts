import assert from "node:assert";
import {
  stackPack,
  packKey,
  mergeDraftPack,
  findMatchingPack,
  addPackUnit,
  type MergedPack,
} from "./packHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- stackPack -----------------------------------------------------------
{
  const base = { spins: 10, amountCents: 500, bonusSpins: 1, label: "Ten" };

  const x1 = stackPack(base, 1);
  check("stackPack count=1 is identity on quantities", x1.spins === 10 && x1.amountCents === 500 && x1.bonusSpins === 1);
  check("stackPack count=1 keeps extra fields", x1.label === "Ten");

  const x5 = stackPack(base, 5);
  check("stackPack 10 spins x5 = 50", x5.spins === 50);
  check("stackPack price x5 = 2500", x5.amountCents === 2500);
  check("stackPack bonus x5 = 5", x5.bonusSpins === 5);

  check("stackPack does not mutate input", base.spins === 10 && base.amountCents === 500 && base.bonusSpins === 1);

  const x0 = stackPack(base, 0);
  check("stackPack count=0 zeroes quantities", x0.spins === 0 && x0.amountCents === 0 && x0.bonusSpins === 0);

  const xNeg = stackPack(base, -3);
  check("stackPack clamps negative to 0", xNeg.spins === 0);

  const xFrac = stackPack(base, 2.9);
  check("stackPack floors fractional count", xFrac.spins === 20 && xFrac.amountCents === 1000);
}

// --- packKey -------------------------------------------------------------
{
  const a = { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 0 };
  const b = { label: "  starter ", spins: 10, amountCents: 500, bonusSpins: 0 };
  const c = { label: "Starter", spins: 10, amountCents: 600, bonusSpins: 0 };
  check("packKey ignores case + surrounding space in label", packKey(a) === packKey(b));
  check("packKey distinguishes different price", packKey(a) !== packKey(c));
}

// --- mergeDraftPack: append new ------------------------------------------
{
  const draft = { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 0 };
  const r = mergeDraftPack([], draft);
  check("mergeDraftPack appends to empty list", r.list.length === 1 && r.merged === false && r.index === 0);
  check("mergeDraftPack new entry has quantity 1", r.list[0].quantity === 1);
  check("mergeDraftPack new entry keeps quantities", r.list[0].spins === 10 && r.list[0].amountCents === 500);

  const draft2 = { label: "Pro", spins: 25, amountCents: 1000, bonusSpins: 2 };
  const r2 = mergeDraftPack(r.list, draft2);
  check("mergeDraftPack appends a distinct bundle", r2.list.length === 2 && r2.merged === false && r2.index === 1);
}

// --- mergeDraftPack: accumulate same bundle ------------------------------
{
  const draft = { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 1 };
  // Click the same pack five times.
  let result = mergeDraftPack([], draft);
  for (let i = 0; i < 4; i++) result = mergeDraftPack(result.list, draft);

  check("mergeDraftPack stays a single row across repeats", result.list.length === 1);
  check("mergeDraftPack last op reports merged", result.merged === true && result.index === 0);
  const only = result.list[0];
  check("mergeDraftPack quantity accumulates to 5", only.quantity === 5);
  check("mergeDraftPack 10 spins x5 = 50", only.spins === 50);
  check("mergeDraftPack price x5 = 2500", only.amountCents === 2500);
  check("mergeDraftPack bonus x5 = 5", only.bonusSpins === 5);
}

// --- mergeDraftPack: purity + mixed list ---------------------------------
{
  const start: MergedPack[] = [
    { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 0, quantity: 1 },
    { label: "Pro", spins: 25, amountCents: 1000, bonusSpins: 0, quantity: 1 },
  ];
  const snapshot = JSON.stringify(start);
  const r = mergeDraftPack(start, { label: "Pro", spins: 25, amountCents: 1000, bonusSpins: 0 });
  check("mergeDraftPack does not mutate input list", JSON.stringify(start) === snapshot);
  check("mergeDraftPack bumps the matching mid-list entry", r.index === 1 && r.list[1].quantity === 2 && r.list[1].spins === 50);
  check("mergeDraftPack leaves other entries untouched", r.list[0].spins === 10 && r.list[0].quantity === 1);
}

// --- findMatchingPack + addPackUnit (persisted editor flow) --------------
{
  const saved = [
    { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 1 },
    { label: "Pro", spins: 25, amountCents: 1000, bonusSpins: 0 },
  ];
  check("findMatchingPack finds by bundle identity", findMatchingPack(saved, { label: "starter", spins: 10, amountCents: 500, bonusSpins: 1 }) === 0);
  check("findMatchingPack respects price differences", findMatchingPack(saved, { label: "Starter", spins: 10, amountCents: 999, bonusSpins: 1 }) === -1);
  check("findMatchingPack returns -1 on empty list", findMatchingPack([], saved[0]) === -1);

  const draft = { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 1 };
  // Simulate adding the same Starter pack two more times on top of the saved one.
  let totals = { spins: saved[0].spins, amountCents: saved[0].amountCents, bonusSpins: saved[0].bonusSpins };
  totals = addPackUnit(totals, draft);
  totals = addPackUnit(totals, draft);
  check("addPackUnit accumulates spins (10 → 30 after 2 adds)", totals.spins === 30);
  check("addPackUnit accumulates price (500 → 1500)", totals.amountCents === 1500);
  check("addPackUnit accumulates bonus (1 → 3)", totals.bonusSpins === 3);

  const before = { spins: 10, amountCents: 500, bonusSpins: 1 };
  const snap = JSON.stringify(before);
  addPackUnit(before, draft);
  check("addPackUnit does not mutate existing", JSON.stringify(before) === snap);
}

// --- findMatchingPack: 3rd-click accumulation (multi-add regression) -----
{
  // A saved pack that is already TWO units must still match the original 1-unit
  // draft, so a 3rd/4th add keeps stacking instead of creating a duplicate.
  const stacked = [{ label: "Starter", spins: 20, amountCents: 1000, bonusSpins: 2 }];
  const unit = { label: "Starter", spins: 10, amountCents: 500, bonusSpins: 1 };
  check("findMatchingPack matches an already-stacked saved pack", findMatchingPack(stacked, unit) === 0);
  const t = addPackUnit(stacked[0], unit);
  check("addPackUnit continues stacking (20 → 30 on the 3rd add)", t.spins === 30 && t.amountCents === 1500 && t.bonusSpins === 3);
  // A non-multiple (different per-unit price) must still NOT match a stacked pack.
  check("findMatchingPack rejects non-multiple totals", findMatchingPack(stacked, { label: "Starter", spins: 10, amountCents: 333, bonusSpins: 1 }) === -1);
  // Bonus-only difference (20/1000/3 is not 2× of 10/500/1) must not match.
  check("findMatchingPack requires a consistent multiple across fields", findMatchingPack([{ label: "Starter", spins: 20, amountCents: 1000, bonusSpins: 3 }], unit) === -1);
}

console.log(`packHelpers.test: ${passed} checks passed`);
