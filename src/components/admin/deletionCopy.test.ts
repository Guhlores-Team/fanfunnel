import assert from "node:assert";
import { ageLabel, deletionErrorLabel, deletionStateLabel, nextRetryLabel, parseStuckDeletions, retryResultMessage } from "./deletionCopy";

// A18: the Admin stuck-deletions card only renders a well-formed answer and
// says plainly what happens next for each job.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ID = "11111111-1111-4111-8111-111111111111";
const item = { id: ID, state: "paused", lastError: "delete_failed", attempts: 3, startedAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-31T10:00:00Z", nextRetryAt: "2026-10-31T11:00:00Z" };
check("a well-formed answer parses", parseStuckDeletions({ deletions: [item] })?.[0].id === ID);
check("an empty list parses", parseStuckDeletions({ deletions: [] })?.length === 0);
check("a non-uuid id is refused", parseStuckDeletions({ deletions: [{ ...item, id: "<script>" }] }) === null);
check("an unknown state is refused", parseStuckDeletions({ deletions: [{ ...item, state: "exploded" }] }) === null);
check("an error body is refused", parseStuckDeletions({ error: "forbidden" }) === null);
check("a missing next retry reads as null", parseStuckDeletions({ deletions: [{ ...item, nextRetryAt: null }] })?.[0].nextRetryAt === null);

check("paused reads Paused", deletionStateLabel({ state: "paused" }) === "Paused");
check("each recorded error has words", ["storage_cleanup_failed", "delete_failed", "upload_unconfirmed", "db_error"].every((e) => deletionErrorLabel(e) !== "Unexpected error"));
check("no error says so", deletionErrorLabel(null) === "No error recorded");

const now = Date.parse("2026-10-31T12:00:00Z");
check("age is coarse: minutes, hours, days", ageLabel("2026-10-31T11:30:00Z", now) === "30 min" && ageLabel("2026-10-31T09:00:00Z", now) === "3 h" && ageLabel("2026-10-27T12:00:00Z", now) === "4 d");
check("exhausted retries ask for the admin", /retry it here/.test(nextRetryLabel({ state: "paused", nextRetryAt: null }, now)));
check("a due retry says the next run takes it", /next maintenance run/.test(nextRetryLabel({ state: "paused", nextRetryAt: "2026-10-31T11:00:00Z" }, now)));
check("a stalled in-flight job is retried by the run", /daily maintenance run/.test(nextRetryLabel({ state: "pending", nextRetryAt: null }, now)));

check("200 → completed", retryResultMessage(200, undefined) === "Deletion completed.");
check("202 → still running", /still running/.test(retryResultMessage(202, undefined)));
check("last admin → the recovery step", /another admin/.test(retryResultMessage(409, "last_admin")));
check("auth refusals ask for 2FA", /two-factor/.test(retryResultMessage(403, "mfa_required")));

console.log(`deletionCopy.test: ${passed} checks passed`);
