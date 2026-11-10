import assert from "node:assert";
import { dueDateInRange, dueDateValue, dueDeadlineLocal, isOverdue, localDayPlus, parseDueDay } from "./dueDate";

// RD-06: partial keystrokes never make a due date; overdue flips at the
// creator's local midnight after the due day; the server window is sane.
const now = Date.UTC(2026, 10, 10, 12); // 2026-11-10 noon UTC

assert.strictEqual(parseDueDay("0002-12-25")?.y, 2);
assert.strictEqual(parseDueDay("2026-02-30"), null, "Feb 30 is not a day");
assert.strictEqual(parseDueDay("2026-12-25T00:00:00Z"), null, "only a bare day");
assert.strictEqual(dueDateValue("2026-12-25T00:00:00.000Z"), "2026-12-25");
assert.strictEqual(dueDateValue(null), "");

assert.strictEqual(dueDateInRange("0002-12-25", now), false, "year 2 is refused");
assert.strictEqual(dueDateInRange("0026-12-25", now), false, "year 26 is refused");
assert.strictEqual(dueDateInRange("2026-12-25", now), true);
assert.strictEqual(dueDateInRange("2025-11-01", now), false, "more than a year ago is refused");
assert.strictEqual(dueDateInRange("2025-11-20", now), true, "within the last year is fine");
assert.strictEqual(dueDateInRange("2036-11-09", now), true, "within ten years");
assert.strictEqual(dueDateInRange("2037-01-01", now), false, "beyond ten years is refused");

// Overdue starts at local midnight after the due day, in the process's zone.
const deadline = dueDeadlineLocal("2026-11-10")!;
assert.strictEqual(deadline, new Date(2026, 10, 11).getTime());
assert.strictEqual(isOverdue("2026-11-10", "pending", deadline - 1), false, "still on time at 23:59:59 local");
assert.strictEqual(isOverdue("2026-11-10", "pending", deadline), true, "overdue from local midnight");
assert.strictEqual(isOverdue("2026-11-10", "in_progress", deadline), true);
assert.strictEqual(isOverdue("2026-11-10", "fulfilled", deadline), false);
assert.strictEqual(isOverdue("2026-11-10", "cancelled", deadline), false);
assert.strictEqual(isOverdue(null, "pending", deadline), false);

const plus = localDayPlus(7, new Date(2026, 10, 10, 23, 30).getTime());
assert.strictEqual(plus, "2026-11-17");
assert.strictEqual(localDayPlus(0, new Date(2026, 0, 31, 1).getTime()), "2026-01-31");

console.log("dueDate: ok");
