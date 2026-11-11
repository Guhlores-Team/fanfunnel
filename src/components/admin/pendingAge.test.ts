import assert from "node:assert";
import { PENDING_AGE_WARN_DAYS, REQUEST_AGE_WARN_DAYS, filterAccounts, pendingAgeLabel, pendingAgeOverdue, requestAgeLabel, requestOverdue } from "./pendingAge";

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

// WG-18: request age and account search.
{
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  assert.equal(requestAgeLabel(ago(0.5), now), "today");
  assert.equal(requestAgeLabel(ago(1.2), now), "1 day ago");
  assert.equal(requestAgeLabel(ago(9), now), "9 days ago");
  assert.equal(requestAgeLabel(ago(3), null), null, "no label before the clock is known (hydration)");
  assert.equal(requestAgeLabel("not a date", now), null);
  assert.equal(requestOverdue(ago(REQUEST_AGE_WARN_DAYS - 0.1), now), false);
  assert.equal(requestOverdue(ago(REQUEST_AGE_WARN_DAYS), now), true);
  const accounts = [{ displayName: "Mia Rose", email: "mia@example.com" }, { displayName: null, email: "ZOE@example.com" }, { displayName: "Ann", email: null }];
  assert.equal(filterAccounts(accounts, "").length, 3);
  assert.deepEqual(filterAccounts(accounts, " zoe ").map((a) => a.email), ["ZOE@example.com"]);
  assert.deepEqual(filterAccounts(accounts, "ROSE").map((a) => a.displayName), ["Mia Rose"]);
  assert.equal(filterAccounts(accounts, "nobody").length, 0);
  console.log("pendingAge.test: request age and account search checks passed");
}
