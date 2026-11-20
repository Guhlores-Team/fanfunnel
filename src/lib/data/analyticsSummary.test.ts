import assert from "node:assert/strict";
import { heatmapFromSummary, metricsFromSummary } from "./analyticsSummary";

// PA-03: the SQL analytics summary (0073) maps onto the panels' shapes; a
// summary that is not the expected shape answers null (the caller then reads
// the rows), never a half-filled chart.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const now = new Date("2026-11-10T15:00:00Z");
const summary = {
  days: 7,
  since: "2026-11-03T15:00:00Z",
  spinsByDay: [{ day: "2026-11-03", count: 9 }, { day: "2026-11-08", count: 4 }, { day: "2026-11-10", count: "2" }],
  revenueByDay: [{ day: "2026-11-09", cents: 1500 }],
  funnel: { fans: 40, spun: 22, fulfilled: 5 },
  activeFans: { thisWeek: 12, lastWeek: 7 },
  heatmap: [{ weekday: 0, hour: 0, count: 3 }, { weekday: 6, hour: 23, count: 8 }],
};

const metrics = metricsFromSummary(summary, 7, now)!;
check("seven UTC days ending today, zero-filled", metrics.trend.length === 7 && metrics.trend[0].date === "2026-11-04" && metrics.trend.at(-1)?.date === "2026-11-10");
check("counts land on their day; a numeric string is a number", metrics.trend.find((d) => d.date === "2026-11-08")?.spins === 4 && metrics.trend.at(-1)?.spins === 2 && metrics.trend[1].spins === 0);
check("the partial day before the window is left out, as the row read does", !metrics.trend.some((d) => d.date === "2026-11-03"));
check("tips land on their day", metrics.revenueTrend.find((d) => d.date === "2026-11-09")?.cents === 1500 && metrics.revenueTrend.length === 7);
check("funnel and weekly-active fans pass through", metrics.funnel.spun === 22 && metrics.activeFans.thisWeek === 12 && metrics.dataStatus === "complete");

for (const [label, bad] of [
  ["null", null],
  ["a missing funnel", { ...summary, funnel: undefined }],
  ["a negative count", { ...summary, spinsByDay: [{ day: "2026-11-08", count: -1 }] }],
  ["a day that is no date", { ...summary, revenueByDay: [{ day: "yesterday", cents: 1 }] }],
  ["a non-numeric active-fan count", { ...summary, activeFans: { thisWeek: "many", lastWeek: 0 } }],
] as const) check(`${label} is not a summary`, metricsFromSummary(bad, 7, now) === null);

const heat = heatmapFromSummary(summary)!;
check("the grid is all 168 cells with the max", heat.cells.length === 168 && heat.max === 8 && heat.cells[0].count === 3 && heat.cells[167].count === 8 && heat.cells[1].count === 0);
check("an hour outside the day is refused", heatmapFromSummary({ heatmap: [{ weekday: 1, hour: 24, count: 1 }] }) === null);
check("an empty summary is an empty grid", heatmapFromSummary({ heatmap: [] })?.max === 0);

console.log(`analyticsSummary.test: ${passed} checks passed`);
