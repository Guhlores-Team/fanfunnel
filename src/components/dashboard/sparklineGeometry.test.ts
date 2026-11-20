import assert from "node:assert";
import { sparklinePoints } from "./sparklineGeometry";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ys = (pts: string) => pts.split(" ").map((p) => Number(p.split(",")[1]));
const xs = (pts: string) => pts.split(" ").map((p) => Number(p.split(",")[0]));

// --- flat series render as one solid, full-width horizontal line ------------
{
  const zero = sparklinePoints([0, 0, 0, 0, 0, 0, 0]);
  check("all-zero series sits on the baseline", ys(zero).every((y) => y === 100));
  check("all-zero series spans the full width", xs(zero)[0] === 0 && xs(zero).at(-1) === 100);

  const flat = sparklinePoints([5, 5, 5, 5]);
  check("flat non-zero series sits at the peak", ys(flat).every((y) => y === 0));
  check("flat non-zero series spans the full width", xs(flat)[0] === 0 && xs(flat).at(-1) === 100);
}

// --- single point: still a visible line, not an invisible 1-vertex polyline --
{
  const one = sparklinePoints([3]);
  check("single-point series yields two vertices", one.split(" ").length === 2);
  check("single-point series spans the full width", xs(one)[0] === 0 && xs(one)[1] === 100);
  check("single-point series is horizontal", ys(one)[0] === ys(one)[1]);
}

// --- varied series keep the existing mapping ---------------------------------
{
  const v = sparklinePoints([0, 5, 10]);
  check("varied series maps x evenly", JSON.stringify(xs(v)) === JSON.stringify([0, 50, 100]));
  check("varied series inverts y against the peak", JSON.stringify(ys(v)) === JSON.stringify([100, 50, 0]));
  check("empty series yields no vertices", sparklinePoints([]) === "");
}

console.log(`sparklineGeometry.test: ${passed} checks passed`);
