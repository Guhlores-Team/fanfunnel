import assert from "node:assert";
import { availablePrizes, isAvailable, pickPrize, prizeOdds } from "./engine";
import {
  SHOW_STOCK_DEFAULT,
  applyStockMap,
  hasLimitedPrize,
  isPublicPrizeAvailable,
  showsStock,
  toPublicPrize,
  toPublicStock,
  toPublicStockMap,
  toPublicWheel,
} from "./publicView";
import type { Prize, PublicPrize, WheelConfig } from "./types";
import { detectNearMiss } from "@/components/fan/nearMiss";
import {
  LIMITED_ROW_MAX,
  LOW_STOCK_EMPHASIS_AT,
  SOLD_OUT_LABEL,
  hasStockToShow,
  isLowStock,
  limitedRowPrizes,
  stockLabel,
} from "@/components/fan/stockDisplay";

// RM-2: the fan-safe stock projection. A limited prize carries its exact count
// only while the wheel's "Show stock to fans" switch is on; off, no count is
// produced at all (stripped here, not hidden in the UI) and only `soldOut`
// remains. Whatever the fan sees as winnable must match the server's draw
// (engine isAvailable / pickPrize) and the editor's odds (prizeOdds).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const wheel = (showStock: boolean | undefined, prizes: Prize[]): WheelConfig => ({
  id: "w",
  title: "Stock wheel",
  ...(showStock === undefined ? {} : { showStock }),
  prizes,
});
const PRIZES: Prize[] = [
  { id: "a", label: "Selfie", rarity: "common", weight: 50, cost: 10 },
  { id: "b", label: "Polaroid", rarity: "epic", weight: 5, stock: 3, cost: 900 },
  { id: "c", label: "VIP", rarity: "legendary", weight: 1, stock: 0, cost: 5000 },
  { id: "d", label: "Call", rarity: "rare", weight: 10, stock: 12 },
];
/** Every numeric value under a key named stock, anywhere in a JSON payload. */
const stockNumbers = (v: unknown): number[] =>
  JSON.stringify(v).match(/"stock":\s*-?\d+/g)?.map((m) => Number(m.split(":")[1])) ?? [];

// --- the switch -------------------------------------------------------------
check("the switch defaults to on", SHOW_STOCK_DEFAULT === true && showsStock({}) === true);
check("an explicit off is off", showsStock({ showStock: false }) === false);
check(
  "a non-boolean is the default, never a truthy 'off'",
  showsStock({ showStock: "no" as unknown as boolean }) === SHOW_STOCK_DEFAULT
);

// --- switch ON: exact counts --------------------------------------------------
{
  const pub = toPublicWheel(wheel(true, PRIZES));
  const by = new Map(pub.prizes.map((p) => [p.id, p]));
  check("on: an unlimited prize has no stock fields", !("stock" in by.get("a")!) && !("soldOut" in by.get("a")!));
  check("on: the exact count is sent (3)", by.get("b")!.stock === 3 && by.get("b")!.soldOut === undefined);
  check("on: the exact count is sent (12)", by.get("d")!.stock === 12);
  check("on: sold out = stock 0 + soldOut", by.get("c")!.stock === 0 && by.get("c")!.soldOut === true);
  check("on: no cost reaches the fan", !/cost/i.test(JSON.stringify(pub)));
  check("default (unset) behaves like on", JSON.stringify(toPublicWheel(wheel(undefined, PRIZES))) === JSON.stringify(pub));
}

// --- switch OFF: no count at all ----------------------------------------------
{
  const pub = toPublicWheel(wheel(false, PRIZES));
  const by = new Map(pub.prizes.map((p) => [p.id, p]));
  check("off: no prize carries a stock key", pub.prizes.every((p) => !("stock" in p)));
  check("off: no numeric stock anywhere in the payload", stockNumbers(pub).length === 0);
  check("off: an in-stock limited prize looks unlimited", Object.keys(by.get("b")!).sort().join() === "id,label,rarity,weight");
  check("off: a sold-out prize still says so (0% odds)", by.get("c")!.soldOut === true);
  check("off: no cost either", !/cost/i.test(JSON.stringify(pub)));
}

// --- single prize / edge values -------------------------------------------------
check("negative stock is clamped to 0 and sold out", JSON.stringify(toPublicStock(-2, true)) === '{"stock":0,"soldOut":true}');
check("fractional stock is never shown as a fraction", toPublicStock(2.7, true).stock === 2);
check("null/undefined stock = unlimited", JSON.stringify(toPublicStock(null, true)) === "{}" && JSON.stringify(toPublicStock(undefined, false)) === "{}");
check("NaN stock is treated as unlimited, never shown", JSON.stringify(toPublicStock(NaN, true)) === "{}");
check("toPublicPrize follows its option", toPublicPrize(PRIZES[1], { showStock: false }).stock === undefined && toPublicPrize(PRIZES[1], { showStock: true }).stock === 3);

// --- the live map a spin response carries -----------------------------------------
{
  const on = toPublicStockMap(PRIZES, true);
  check("map on: one entry per limited prize, exact counts", JSON.stringify(on) === '{"b":{"stock":3},"c":{"stock":0,"soldOut":true},"d":{"stock":12}}');
  const off = toPublicStockMap(PRIZES, false);
  check("map off: only sold-out prizes, no counts", JSON.stringify(off) === '{"c":{"soldOut":true}}');
  check("map off: no numeric stock", stockNumbers(off).length === 0);
  check("hasLimitedPrize", hasLimitedPrize(PRIZES) && !hasLimitedPrize([PRIZES[0]]));

  const shown = toPublicWheel(wheel(true, PRIZES)).prizes;
  const after = applyStockMap(shown, { b: { stock: 2 }, c: { stock: 0, soldOut: true }, d: { stock: 12 } });
  check("applyStockMap updates a count", after.find((p) => p.id === "b")!.stock === 2);
  const hidden = applyStockMap(shown, off);
  check("applyStockMap: a prize missing from the map loses its count", hidden.find((p) => p.id === "b")!.stock === undefined);
  check("applyStockMap: sold out kept", hidden.find((p) => p.id === "c")!.soldOut === true);
  check("applyStockMap leaves the label/order alone", hidden.map((p) => p.id).join() === "a,b,c,d");
}

// --- parity with the server's draw and prizeOdds ----------------------------------
// For random wheels and both switch states: the prizes the fan sees as winnable
// are exactly the engine's available pool, prizeOdds gives every other prize
// 0%, and the draw never lands on a prize the fan sees as sold out.
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const n = 2 + Math.floor(rnd() * 6);
    const prizes: Prize[] = Array.from({ length: n }, (_, j) => {
      const r = rnd();
      return {
        id: `p${j}`,
        label: `P${j}`,
        rarity: (["common", "uncommon", "rare", "epic", "legendary"] as const)[j % 5],
        weight: 1 + Math.floor(rnd() * 20),
        stock: r < 0.3 ? null : r < 0.5 ? 0 : r < 0.6 ? -1 : Math.floor(rnd() * 8),
      };
    });
    const cfg = wheel(rnd() < 0.5, prizes);
    if (availablePrizes(cfg).length === 0) continue;
    const odds = prizeOdds(cfg);
    for (const show of [true, false]) {
      const fan = toPublicWheel({ ...cfg, showStock: show }).prizes;
      const same = prizes.every((p, k) => isAvailable(p) === isPublicPrizeAvailable(fan[k]));
      check(`wheel ${i} (${show ? "on" : "off"}): fan's winnable set == engine pool`, same);
      check(
        `wheel ${i} (${show ? "on" : "off"}): a prize the fan sees sold out has 0% odds`,
        fan.every((p) => isPublicPrizeAvailable(p) || odds.get(p.id) === 0)
      );
    }
    const fanOff = new Map(toPublicWheel({ ...cfg, showStock: false }).prizes.map((p) => [p.id, p]));
    for (let k = 0; k < 20; k++) {
      const { prize } = pickPrize(cfg, rnd);
      assert.ok(isPublicPrizeAvailable(fanOff.get(prize.id)!), `wheel ${i}: the draw never picks a prize the fan sees sold out`);
    }
    passed++;
  }
}

// --- fan-side wording and helpers (constants, not scattered literals) ------------------
{
  check("count label", stockLabel({ stock: 3 }) === "3 left");
  check("sold-out label (with count)", stockLabel({ stock: 0, soldOut: true }) === SOLD_OUT_LABEL);
  check("sold-out label (count hidden)", stockLabel({ soldOut: true }) === SOLD_OUT_LABEL);
  check("hasStockToShow: hidden in-stock prize shows nothing", !hasStockToShow({}) && hasStockToShow({ soldOut: true }) && hasStockToShow({ stock: 4 }));
  check("low-stock emphasis at the threshold", isLowStock({ stock: LOW_STOCK_EMPHASIS_AT }) && !isLowStock({ stock: LOW_STOCK_EMPHASIS_AT + 1 }) && !isLowStock({ stock: 0, soldOut: true }));

  const on = toPublicWheel(wheel(true, PRIZES)).prizes;
  const row = limitedRowPrizes(on);
  check("Limited row: limited prizes only, winnable first, rarest first", row.shown.map((p) => p.id).join() === "b,d,c");
  check("Limited row: empty when the wheel hides stock", limitedRowPrizes(toPublicWheel(wheel(false, PRIZES)).prizes).shown.length === 0);
  const many: PublicPrize[] = Array.from({ length: LIMITED_ROW_MAX + 3 }, (_, j) => ({ id: `x${j}`, label: `X${j}`, rarity: "rare", weight: 1, stock: 2 }));
  const capped = limitedRowPrizes(many);
  check("Limited row: capped, with the rest counted", capped.shown.length === LIMITED_ROW_MAX && capped.more === 3);
}

// --- near miss never points at a sold-out prize (it had 0% odds) -------------------------
{
  const ring: PublicPrize[] = [
    { id: "a", label: "A", rarity: "common", weight: 1 },
    { id: "l", label: "Legend", rarity: "legendary", weight: 1, soldOut: true },
    { id: "b", label: "B", rarity: "common", weight: 1 },
    { id: "e", label: "Epic", rarity: "epic", weight: 1, stock: 2 },
  ];
  check("a sold-out legendary next door is not a near miss (the epic is)", detectNearMiss(ring, 0)?.prize.id === "e");
  check("the in-stock epic on the other side still is", detectNearMiss(ring, 2)?.prize.id === "e");
  const inStock = ring.map((p) => (p.id === "l" ? { ...p, soldOut: undefined } : p));
  check("an in-stock legendary still is", detectNearMiss(inStock, 0)?.prize.id === "l");
}

console.log(`stockProjection.test: ${passed} checks passed`);
