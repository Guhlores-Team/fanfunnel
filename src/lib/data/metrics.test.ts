import assert from "node:assert/strict";
import { bucketByDay, bucketCentsByDay, clampDays } from "./metrics";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Fixed "now" so the test is deterministic: 2026-05-31T12:00:00Z.
const now = new Date("2026-05-31T12:00:00Z");

test("returns exactly `days` zero-filled, ascending entries ending at now", () => {
  const out = bucketByDay([], 7, now);
  assert.equal(out.length, 7);
  assert.equal(out[0].date, "2026-05-25");
  assert.equal(out[6].date, "2026-05-31");
  for (const e of out) assert.equal(e.spins, 0);
  // strictly ascending
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].date < out[i].date);
});

test("counts timestamps on their correct UTC day", () => {
  const out = bucketByDay(
    [
      "2026-05-31T00:01:00Z", // today
      "2026-05-31T23:59:00Z", // today
      "2026-05-30T10:00:00Z", // yesterday
    ],
    7,
    now
  );
  const byDate = new Map(out.map((e) => [e.date, e.spins]));
  assert.equal(byDate.get("2026-05-31"), 2);
  assert.equal(byDate.get("2026-05-30"), 1);
  assert.equal(byDate.get("2026-05-29"), 0);
});

test("ignores timestamps outside the window", () => {
  const out = bucketByDay(
    [
      "2026-05-01T10:00:00Z", // before the 7-day window
      "2026-06-15T10:00:00Z", // after now
      "not-a-date", // unparseable
    ],
    7,
    now
  );
  assert.equal(out.reduce((s, e) => s + e.spins, 0), 0);
});

test("UTC boundary: a time that is 'tomorrow' in local positive tz still buckets by UTC", () => {
  // 23:30Z on the 30th is still the 30th in UTC.
  const out = bucketByDay(["2026-05-30T23:30:00Z"], 3, now);
  const byDate = new Map(out.map((e) => [e.date, e.spins]));
  assert.equal(byDate.get("2026-05-30"), 1);
  assert.equal(byDate.get("2026-05-31"), 0);
});

test("clampDays clamps to 1..90 and floors", () => {
  assert.equal(clampDays(0), 1);
  assert.equal(clampDays(-5), 1);
  assert.equal(clampDays(1000), 90);
  assert.equal(clampDays(30.9), 30);
  assert.equal(bucketByDay([], 0, now).length, 1);
  assert.equal(bucketByDay([], 500, now).length, 90);
});

test("bucketCentsByDay sums cents per UTC day, zero-filled & ascending", () => {
  const out = bucketCentsByDay(
    [
      { at: "2026-05-31T00:01:00Z", cents: 500 }, // today
      { at: "2026-05-31T23:59:00Z", cents: 250 }, // today
      { at: "2026-05-30T10:00:00Z", cents: 1000 }, // yesterday
    ],
    7,
    now
  );
  assert.equal(out.length, 7);
  assert.equal(out[0].date, "2026-05-25");
  assert.equal(out[6].date, "2026-05-31");
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].date < out[i].date);
  const byDate = new Map(out.map((e) => [e.date, e.cents]));
  assert.equal(byDate.get("2026-05-31"), 750);
  assert.equal(byDate.get("2026-05-30"), 1000);
  assert.equal(byDate.get("2026-05-29"), 0); // zero-filled
});

test("bucketCentsByDay ignores out-of-window and unparseable events", () => {
  const out = bucketCentsByDay(
    [
      { at: "2026-05-01T10:00:00Z", cents: 999 }, // before the 7-day window
      { at: "2026-06-15T10:00:00Z", cents: 999 }, // after now
      { at: "not-a-date", cents: 999 }, // unparseable
    ],
    7,
    now
  );
  assert.equal(out.reduce((s, e) => s + e.cents, 0), 0);
});

test("bucketCentsByDay clamps day window like bucketByDay", () => {
  assert.equal(bucketCentsByDay([], 0, now).length, 1);
  assert.equal(bucketCentsByDay([], 500, now).length, 90);
});

console.log(`\n${passed} test(s) passed`);
