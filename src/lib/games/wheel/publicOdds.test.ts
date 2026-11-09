import assert from "node:assert";
import { formatChance, publicBaseOdds } from "./publicOdds";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const rows = publicBaseOdds([
  { label: "Shout-out", weight: 6 },
  { label: "Video", weight: 3 },
  { label: "Call", weight: 1 },
  { label: "Signed photo", weight: 5, stock: 0 },
  { label: "Gone", weight: 4, soldOut: true },
]);
check("every prize is named", rows.map((r) => r.label).sort().join() === "Call,Gone,Shout-out,Signed photo,Video");
check("chances use the available weight only", rows.find((r) => r.label === "Shout-out")!.chance === 0.6 && rows.find((r) => r.label === "Call")!.chance === 0.1);
check("sold-out prizes are 0", rows.find((r) => r.label === "Signed photo")!.chance === 0 && rows.find((r) => r.label === "Gone")!.chance === 0);
check("the chances of available prizes sum to 1", Math.abs(rows.reduce((s, r) => s + r.chance, 0) - 1) < 1e-9);
check("most likely first", rows[0].label === "Shout-out");
check("nothing available: all 0, no NaN", publicBaseOdds([{ label: "A", weight: 0 }]).every((r) => r.chance === 0));
check("format: plain percent", formatChance(0.6) === "60%" && formatChance(1 / 3) === "33.333%");
check("format: tiny but real", formatChance(1e-7) === "<0.001%");
check("format: zero", formatChance(0) === "0%");
console.log(`publicOdds.test: ${passed} checks passed`);
