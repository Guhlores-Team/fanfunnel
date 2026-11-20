import assert from "node:assert";
import {
  CHECKIN_READ_DAYS,
  GLOW_LEVEL_MIN,
  GLOW_MILESTONES,
  GLOW_MODE,
  REGULAR_MIN_VISITS,
} from "./config";
import { glowGateOpen } from "./gate";
import {
  addDays,
  checkinResult,
  clampCheckinDay,
  computeGlow,
  dueMilestone,
  glowAnchor,
  glowLevel,
  glowVisits,
  isDay,
  isRegular,
  visitsLast7,
} from "./glow";

// RM-3 visit glow: the pure rules every path (fan page, check-in route, the
// Supabase data layer, the mock store) shares.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const T = "2026-10-27";
const days = (...offsets: number[]) => new Set(offsets.map((o) => addDays(T, -o)));
const run = (from: number, to: number) => {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

// --- defaults (the owner decision is D5 = rolling) -----------------------------
check("D5 default is the rolling glow", GLOW_MODE === "rolling");
check("Regulars = full glow (5 of 7)", REGULAR_MIN_VISITS === 5 && GLOW_LEVEL_MIN.full === 5);
check("milestones: 20 in 30, 7 in 7", JSON.stringify(GLOW_MILESTONES.map((m) => [m.id, m.visits, m.windowDays])) === JSON.stringify([["month", 20, 30], ["week", 7, 7]]));
check("the read window covers every milestone decision", CHECKIN_READ_DAYS === 59);

// --- dates ----------------------------------------------------------------------
check("addDays crosses months", addDays("2026-10-31", 1) === "2026-11-01");
check("addDays crosses years backwards", addDays("2026-01-01", -1) === "2025-12-31");
check("addDays handles leap day", addDays("2028-02-28", 1) === "2028-02-29");
check("isDay accepts a real date", isDay("2026-10-27"));
check("isDay rejects 2026-02-30", !isDay("2026-02-30"));
check("isDay rejects other shapes", !isDay("2026-10-27T00:00:00Z") && !isDay(20261027) && !isDay(null) && !isDay("27/10/2026"));

const noon = new Date("2026-10-27T12:00:00Z");
check("clamp: today stays", clampCheckinDay("2026-10-27", noon) === "2026-10-27");
check("clamp: yesterday (fan behind UTC) stays", clampCheckinDay("2026-10-26", noon) === "2026-10-26");
check("clamp: tomorrow (fan ahead of UTC) stays", clampCheckinDay("2026-10-28", noon) === "2026-10-28");
check("clamp: a week ago can't be backfilled", clampCheckinDay("2026-10-20", noon) === "2026-10-26");
check("clamp: next month can't be pre-filled", clampCheckinDay("2026-11-27", noon) === "2026-10-28");
check("clamp: garbage → server's UTC day", clampCheckinDay("yesterday", noon) === "2026-10-27");
check("clamp: missing → server's UTC day", clampCheckinDay(undefined, noon) === "2026-10-27");
check("clamp: an injection string → server's UTC day", clampCheckinDay("2026-10-27'; drop table fans;--", noon) === "2026-10-27");
check("clamp: an impossible date → server's UTC day", clampCheckinDay("2026-02-31", noon) === "2026-10-27");

check("anchor: UTC today by default", glowAnchor([addDays(T, -1)], noon) === T);
check("anchor: a fan already on tomorrow anchors there", glowAnchor([addDays(T, 1)], noon) === addDays(T, 1));
check("anchor: never beyond tomorrow", glowAnchor(["2027-01-01"], noon) === T);

// --- levels (1–2 faint, 3–4 warm, 5–7 full) ------------------------------------
check("0 visits → no glow", glowLevel(0) === 0);
check("1–2 → faint", glowLevel(1) === 1 && glowLevel(2) === 1);
check("3–4 → warm", glowLevel(3) === 2 && glowLevel(4) === 2);
check("5–7 → full", glowLevel(5) === 3 && glowLevel(7) === 3);
check("isRegular at 5, not at 4", isRegular(5) && !isRegular(4));

// --- rolling glow: no reset cliff -----------------------------------------------
check("rolling: 3 scattered visits in 7 days = 3", glowVisits(days(0, 2, 5), T, "rolling") === 3);
check("rolling: visits older than 7 days don't count", glowVisits(days(0, 7, 8, 20), T, "rolling") === 1);
check("rolling: a missed day doesn't reset (5 of 7 with gaps)", glowVisits(days(0, 1, 3, 4, 6), T, "rolling") === 5);
check("rolling: missing today still shows the week", glowVisits(days(1, 2, 3), T, "rolling") === 3);
check("rolling: fades gradually, one day at a time", glowVisits(days(4, 5, 6), T, "rolling") === 3 && glowVisits(days(5, 6, 7), T, "rolling") === 2);
check("computeGlow pairs the count with its level", JSON.stringify(computeGlow(days(0, 1, 2, 3, 4), T)) === JSON.stringify({ visits: 5, level: 3 }));

// --- the flippable alternatives (D5 options a and c) ----------------------------
check("streak: consecutive days ending today", glowVisits(days(0, 1, 2, 4), T, "streak") === 3);
check("streak: not visited yet today keeps yesterday's streak", glowVisits(days(1, 2), T, "streak") === 2);
check("streak: a gap resets to 0", glowVisits(days(2, 3, 4), T, "streak") === 0);
check("streakGrace: one missed day is forgiven", glowVisits(days(0, 1, 3, 4), T, "streakGrace") === 4);
check("streakGrace: only one", glowVisits(days(0, 2, 4, 5), T, "streakGrace") === 2);

// --- milestones: once, and only on a visited day --------------------------------
check("week: 7 of 7 ending today is due", dueMilestone(days(...run(0, 6)), T) === "week");
check("week: 6 of 7 is not", dueMilestone(days(...run(0, 5)), T) === null);
check("week: not due when today wasn't visited", dueMilestone(days(...run(1, 7)), T) === null);
check("week: once — the day after a full week is quiet", dueMilestone(days(...run(0, 7)), T) === null);
check("week: still quiet on day 13 of a run", dueMilestone(days(...run(0, 12)), T) === null);
check(
  "week: back after a full week without it",
  dueMilestone(days(...run(0, 6), ...run(8, 14)), T) === "week"
);
// 20 visits in 30 days, never 7 in a row (weekends off).
const twentyOfThirty: number[] = run(0, 29).filter((i) => i % 7 !== 5 && i % 7 !== 6).slice(0, 20);
check("month: 20 in 30 is due on the 20th visit", twentyOfThirty.length === 20 && dueMilestone(days(...twentyOfThirty), T) === "month");
check("month: 19 in 30 is not", dueMilestone(days(...twentyOfThirty.slice(0, 19)), T) === null);
check("month: 20 days straight → month", dueMilestone(days(...run(0, 19)), T) === "month");
check("month: once — the next visit is quiet", dueMilestone(days(...run(0, 20)), T) === null);

check("checkinResult: a repeat visit the same day never re-celebrates", checkinResult(days(...run(0, 6)), T, false, noon).milestone === null);
check("checkinResult: the first visit of the day does", checkinResult(days(...run(0, 6)), T, true, noon).milestone === "week");
check("checkinResult carries the glow either way", checkinResult(days(...run(0, 6)), T, false, noon).glow.level === 3);
{
  // A fan ahead of UTC recorded tomorrow; today's check-in must not hide it.
  const s = new Set([addDays(T, -1), T, addDays(T, 1)]);
  check("checkinResult anchors like the page: today's check-in still sees tomorrow", checkinResult(s, T, false, noon).glow.visits === 3);
  check("…and the page read agrees", computeGlow(s, glowAnchor(s, noon)).visits === 3);
}

// --- creator view ----------------------------------------------------------------
check("visitsLast7 counts the last 7 days", visitsLast7([T, addDays(T, -3), addDays(T, -9)], noon) === 2);
check("visitsLast7 is mode-independent (a gap still counts)", visitsLast7([T, addDays(T, -2)], noon) === 2);

// --- the gate (F6, shared with RM-6) ----------------------------------------------
check("gate: an ordinary fan is open", glowGateOpen({}));
check("gate: blocked → closed", !glowGateOpen({ blockedAt: "2026-10-01T00:00:00Z" }));
check("gate: paused link → closed", !glowGateOpen({ paused: true }));
check("gate: on a break → closed", !glowGateOpen({ breakUntil: "2026-10-28T00:00:00Z" }, noon));
check("gate: a break that ended → open", glowGateOpen({ breakUntil: "2026-10-26T00:00:00Z" }, noon));

console.log(`glow rules: ${passed} checks passed`);
