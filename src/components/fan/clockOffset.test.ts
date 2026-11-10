import assert from "node:assert/strict";
import { clockOffset } from "./LinkPauseProvider";

const device = Date.parse("2026-01-01T12:00:00Z");
assert.equal(clockOffset("2026-01-01T12:10:00Z", device, true), 600_000, "RF-13: a phone ten minutes behind gets the server's offset");
assert.equal(clockOffset("2026-01-01T11:50:00Z", device, true), -600_000, "a phone ahead is pulled back");
assert.equal(clockOffset("2026-01-01T12:00:02Z", device, true), 0, "network latency is not a skew");
assert.equal(clockOffset("2026-01-01T12:10:00Z", device, false), 0, "never applied during server rendering");
assert.equal(clockOffset(null, device, true), 0);
assert.equal(clockOffset("garbage", device, true), 0);
console.log("clockOffset: RF-13 checks passed");
