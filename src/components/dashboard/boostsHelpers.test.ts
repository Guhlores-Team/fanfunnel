import assert from "node:assert";
import { demandPct, formatWindow, happyHourStatus } from "./boostsHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- happyHourStatus ------------------------------------------------------
{
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const iso = (h: number) => new Date(Date.UTC(2026, 0, 10, h, 0, 0)).toISOString();

  check("before the window → scheduled", happyHourStatus(iso(13), iso(15), now) === "scheduled");
  check("inside the window → live", happyHourStatus(iso(11), iso(13), now) === "live");
  check("exactly at start → live", happyHourStatus(iso(12), iso(13), now) === "live");
  check("exactly at end → live", happyHourStatus(iso(11), iso(12), now) === "live");
  check("after the window → ended", happyHourStatus(iso(9), iso(11), now) === "ended");
  check("unparseable dates never throw and read as scheduled", happyHourStatus("nope", iso(13), now) === "scheduled");
}

// --- demandPct -------------------------------------------------------------
{
  const counts = [34, 21, 12];
  check("top item is a full bar", demandPct(34, counts) === 100);
  check("others scale against the max", demandPct(21, counts) === 62);
  check("smallest still scales", demandPct(12, counts) === 35);
  check("zero count → empty bar", demandPct(0, counts) === 0);
  check("all zeros → empty bars, no division by zero", demandPct(0, [0, 0]) === 0);
  check("empty list → 0 (no max to scale against)", demandPct(5, []) === 0);
}

// --- formatWindow ---------------------------------------------------------
{
  const s = new Date(2026, 2, 20, 20, 0).toISOString();
  const e = new Date(2026, 2, 20, 22, 0).toISOString();
  const oneDay = formatWindow(s, e, "en-US");
  check("same-day window uses a single date with a time range", /·/.test(oneDay) && /–/.test(oneDay) && !/→/.test(oneDay));

  const e2 = new Date(2026, 2, 21, 1, 0).toISOString();
  const twoDays = formatWindow(s, e2, "en-US");
  check("cross-day window shows both dates with an arrow", /→/.test(twoDays) && !/·/.test(twoDays));

  check("bad input falls back to the raw strings", formatWindow("x", "y") === "x → y");
}

console.log(`boostsHelpers: ${passed} checks passed`);
