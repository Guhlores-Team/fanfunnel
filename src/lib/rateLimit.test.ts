import assert from "node:assert";
import { rateLimit } from "./rateLimit";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Fake clock so the window boundary is deterministic.
let t = 1_000_000;
const clock = () => t;

const key = "test:" + Math.random().toString(36).slice(2);
const LIMIT = 5;
const WINDOW = 10_000;

// The first `limit` calls all pass.
for (let i = 0; i < LIMIT; i++) {
  const r = rateLimit(key, LIMIT, WINDOW, clock);
  check(`call ${i + 1} within limit passes`, r.ok === true && r.retryAfter === 0);
}

// The next call is blocked, with a positive retryAfter.
const blocked = rateLimit(key, LIMIT, WINDOW, clock);
check("call over limit is blocked", blocked.ok === false);
check("blocked call has retryAfter > 0", blocked.retryAfter > 0);
check("retryAfter is within window", blocked.retryAfter <= WINDOW);

// Advancing past the window resets the counter.
t += WINDOW;
const afterReset = rateLimit(key, LIMIT, WINDOW, clock);
check("call after window passes again", afterReset.ok === true && afterReset.retryAfter === 0);

console.log(`rateLimit.test: ${passed} checks passed`);
