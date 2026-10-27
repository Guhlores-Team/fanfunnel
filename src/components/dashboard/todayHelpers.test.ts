import assert from "node:assert";
import type { RedemptionItem } from "@/lib/data/types";
import {
  ageLabel,
  impactTag,
  lastValue,
  oldestPendingAge,
  sparkPoints,
  trendVsAvg,
  trendVsYesterday,
} from "./todayHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- lastValue / trends ----------------------------------------------------
check("lastValue of empty is 0", lastValue([]) === 0);
check("lastValue is the final point", lastValue([1, 2, 7]) === 7);

check("trendVsAvg needs history", trendVsAvg([5]) === null);
check("trendVsAvg with zero history is null (no divide-by-zero)", trendVsAvg([0, 0, 4]) === null);
const up = trendVsAvg([10, 10, 12]);
check("trendVsAvg +20% vs avg", up?.dir === "up" && up.label === "20%");
const down = trendVsAvg([10, 10, 5]);
check("trendVsAvg -50% labels absolute value", down?.dir === "down" && down.label === "50%");
check("trendVsAvg flat", trendVsAvg([4, 4])?.dir === "flat");

check("trendVsYesterday needs two points", trendVsYesterday([3]) === null);
const dy = trendVsYesterday([2, 9, 4]);
check("trendVsYesterday is today minus yesterday", dy?.dir === "down" && dy.label === "5");

// --- oldestPendingAge --------------------------------------------------------
const now = Date.parse("2026-10-23T12:00:00Z");
const r = (status: RedemptionItem["status"], at: string): RedemptionItem => ({
  id: at,
  fanName: "f",
  prizeLabel: "p",
  rarity: "common",
  status,
  at,
});
check("no redemptions → null", oldestPendingAge([], now) === null);
check(
  "ignores non-pending",
  oldestPendingAge([r("fulfilled", "2026-10-01T00:00:00Z")], now) === null
);
check(
  "oldest pending in hours",
  oldestPendingAge(
    [r("pending", "2026-10-23T08:00:00Z"), r("pending", "2026-10-23T11:00:00Z")],
    now
  ) === "4h"
);
check("minutes under an hour", oldestPendingAge([r("pending", "2026-10-23T11:45:00Z")], now) === "15m");
check("days past 48h", oldestPendingAge([r("pending", "2026-10-20T12:00:00Z")], now) === "3d");
check("unparseable timestamps are skipped", oldestPendingAge([r("pending", "nope")], now) === null);

check("ageLabel hours", ageLabel("2026-10-23T08:00:00Z", now) === "4h");
check("ageLabel null/garbage", ageLabel(null, now) === null && ageLabel("x", now) === null);

// --- sparkPoints -------------------------------------------------------------
check("sparkPoints needs two points", sparkPoints([3]) === "");
const pts = sparkPoints([0, 5, 10]).split(" ");
check("sparkPoints spans 0..120", pts.length === 3 && pts[0].startsWith("0.0,") && pts[2].startsWith("120.0,"));
check("sparkPoints peak sits highest", Number(pts[2].split(",")[1]) < Number(pts[0].split(",")[1]));
check("sparkPoints all-zero series stays finite", !sparkPoints([0, 0]).includes("NaN"));

// --- impactTag -----------------------------------------------------------------
check("fulfilment → Fulfil", impactTag("open_fulfilment").label === "Fulfil");
check("dm/copy → Re-engage", impactTag("dm_fan").label === "Re-engage" && impactTag("copy_link").label === "Re-engage");
check("win-back queue → Re-engage", impactTag("open_winback").label === "Re-engage");
check("happy hour → Timing", impactTag("schedule_happy_hour").label === "Timing");
check("edit wheel → Tune", impactTag("edit_wheel").label === "Tune");
check("unknown → Insight", impactTag("whatever").label === "Insight");

console.log(`todayHelpers.test: ${passed} checks passed`);
