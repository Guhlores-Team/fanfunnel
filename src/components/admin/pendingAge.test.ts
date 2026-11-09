import assert from "node:assert";
import { PENDING_AGE_WARN_DAYS, pendingAgeLabel, pendingAgeOverdue } from "./pendingAge";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const now = Date.parse("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
check("no pending prize shows no age", pendingAgeLabel(null, now) === null && pendingAgeLabel(undefined, now) === null);
check("an unknown clock shows no age (no hydration mismatch)", pendingAgeLabel(daysAgo(3), null) === null);
check("under a day reads <1d", pendingAgeLabel(daysAgo(0.5), now) === "<1d");
check("whole days round down", pendingAgeLabel(daysAgo(3.9), now) === "3d");
check("a future timestamp never goes negative", pendingAgeLabel(new Date(now + 60_000).toISOString(), now) === "<1d");
check("a bad timestamp shows nothing", pendingAgeLabel("nope", now) === null);
check("overdue at the warning threshold", pendingAgeOverdue(daysAgo(PENDING_AGE_WARN_DAYS), now));
check("not overdue just before it", !pendingAgeOverdue(daysAgo(PENDING_AGE_WARN_DAYS - 1), now));
console.log(`pendingAge.test: ${passed} checks passed`);
