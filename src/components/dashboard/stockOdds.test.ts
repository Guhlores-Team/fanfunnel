import assert from "node:assert";
import { prizeOdds } from "@/lib/games/wheel/engine";
import type { WheelConfig } from "@/lib/games/wheel/types";

// Behavior spec #6 (stock → odds), as the wheel editor shows it: the editor's
// per-prize % and the OddsBar both come from prizeOdds(wheel). While a prize
// has stock it keeps its ticket share; at stock 0 it leaves the pool (0%) and
// the remaining tickets renormalize to 100%.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const wheel: WheelConfig = {
  id: "w",
  title: "W",
  prizes: [
    { id: "a", label: "A", rarity: "common", weight: 60, stock: null },
    { id: "b", label: "B", rarity: "rare", weight: 30, stock: 5 },
    { id: "c", label: "C", rarity: "legendary", weight: 10, stock: 1 },
  ],
};

{
  const o = prizeOdds(wheel);
  check("in stock: tickets ÷ all tickets (60%)", near(o.get("a")!, 0.6));
  check("in stock: limited prize keeps its share (30%)", near(o.get("b")!, 0.3));
  check("in stock: last unit still counts (10%)", near(o.get("c")!, 0.1));
}

{
  const soldOut = { ...wheel, prizes: wheel.prizes.map((p) => (p.id === "c" ? { ...p, stock: 0 } : p)) };
  const o = prizeOdds(soldOut);
  check("stock 0 → 0%", o.get("c") === 0);
  check("the rest renormalize: 60/90", near(o.get("a")!, 60 / 90));
  check("the rest renormalize: 30/90", near(o.get("b")!, 30 / 90));
  check("still sums to 100%", near([...o.values()].reduce((s, v) => s + v, 0), 1));
}

{
  const restocked = { ...wheel, prizes: wheel.prizes.map((p) => (p.id === "c" ? { ...p, stock: 3 } : p)) };
  check("restocking brings its odds back", near(prizeOdds(restocked).get("c")!, 0.1));
}

{
  const allOut = { ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, stock: 0 })) };
  check("everything sold out → all 0% (no NaN)", [...prizeOdds(allOut).values()].every((v) => v === 0));
}

console.log(`stockOdds: ${passed} checks passed`);
