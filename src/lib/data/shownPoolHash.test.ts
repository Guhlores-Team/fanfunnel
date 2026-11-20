import assert from "node:assert/strict";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { buildFocusPoolSnapshot, hashPoolSnapshot } from "@/lib/games/wheel/fairnessV3";
import { focusDisplay } from "./focusDisplay";
import { lastOfLine, oddsChangedSinceShown } from "@/components/fan/stockDisplay";

// A32 (spec F2 honest limit): the fan page holds the v3 poolHash its next
// wheel spin would commit to, built by the same snapshot builder and hash as
// the spin itself, so "Odds were updated since you opened this page" shows
// exactly when the committed odds differ from the odds on screen.
// A33 (spec RM-2): the win card's "You got 1 of the last N!" uses the stock
// before the win and only a count the fan is allowed to see.

let passed = 0;
const check = (label: string, value: boolean) => { assert.ok(value, label); passed++; };

const wheel: WheelConfig = {
  id: "w", title: "W",
  prizes: [
    { id: "a", label: "A", rarity: "common", weight: 70, stock: null, cost: 100 },
    { id: "b", label: "B", rarity: "rare", weight: 25, stock: 4, cost: 500 },
    { id: "c", label: "C", rarity: "legendary", weight: 5, stock: 0, cost: 900 },
  ],
};
const opts = { pityCounter: 2, happyHourMultiplier: null, reserved: false };

async function main() {
  const shown = focusDisplay(null, wheel, opts).odds?.poolHash;
  const committed = await hashPoolSnapshot(buildFocusPoolSnapshot(wheel, { pityCounter: 2, happyHourMultiplier: null }));
  check("the shown hash is exactly the hash a spin with the same state commits to", shown === committed);
  check("no change: no notice", !oddsChangedSinceShown(shown, committed));

  const edited = { ...wheel, prizes: wheel.prizes.map((p) => (p.id === "a" ? { ...p, weight: 60 } : p)) };
  const afterEdit = await hashPoolSnapshot(buildFocusPoolSnapshot(edited, { pityCounter: 2, happyHourMultiplier: null }));
  check("a creator edit between load and spin changes the committed hash", afterEdit !== shown);
  check("…and the page says the odds were updated", oddsChangedSinceShown(shown, afterEdit));

  const happy = await hashPoolSnapshot(buildFocusPoolSnapshot(wheel, { pityCounter: 2, happyHourMultiplier: 2 }));
  check("a happy hour starting in between is an odds change too", oddsChangedSinceShown(shown, happy));
  check("happy-hour display hashes match their spin", focusDisplay(null, wheel, { ...opts, happyHourMultiplier: 2 }).odds?.poolHash === happy);

  check("unknown shown odds never claim a change", !oddsChangedSinceShown(undefined, committed));
  check("a spin without a v3 hash never claims a change", !oddsChangedSinceShown(shown, undefined));
  check("scratch games carry no wheel hash (they commit to a game snapshot)", focusDisplay(null, { ...wheel, gameKind: "scratch" }, opts).odds?.poolHash === undefined);

  check("8 left after the win: no line (9 before)", lastOfLine({ stock: 8 }) === null);
  check("4 left after the win: 1 of the last 5", lastOfLine({ stock: 4 }) === "You got 1 of the last 5!");
  check("2 left after the win: 1 of the last 3", lastOfLine({ stock: 2 }) === "You got 1 of the last 3!");
  check("0 left after the win: the last one", lastOfLine({ stock: 0, soldOut: true }) === "You got the last one!");
  check("stock hidden by the creator: no line", lastOfLine({ soldOut: true }) === null && lastOfLine({}) === null);
  check("an unlimited prize: no line", lastOfLine(undefined) === null);

  console.log(`shown pool hash + last-of line: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
