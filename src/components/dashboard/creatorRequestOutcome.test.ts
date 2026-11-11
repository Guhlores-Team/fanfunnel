import assert from "node:assert/strict";
import { creatorRequestOutcome, releaseCreatorRequest, terminalCreatorRequest } from "./creatorRequestOutcome";

const id = crypto.randomUUID();
const kind = "pass";
let local: string | null = null;
const storage = { getItem: () => local, setItem: (_key: string, value: string) => { local = value; }, removeItem: () => { local = null; } };
const saved = JSON.stringify({ id, signature: "a".repeat(64) });
for (const status of ["committed", "rejected", "cancelled", "gone"] as const) {
  assert.equal(creatorRequestOutcome({ requestId: id, kind, status }, id, kind), status);
  assert.ok(terminalCreatorRequest(status), "only a matching terminal server receipt releases an intent");
  local = saved;
  assert.equal(releaseCreatorRequest(storage, "test", { requestId: id, kind, status }, id, kind), status);
  assert.equal(local, null, "matching terminal proof clears the saved intent");
}
for (const status of ["pending", "absent", "conflict", "unavailable"] as const) {
  assert.equal(creatorRequestOutcome({ requestId: id, kind, status }, id, kind), status);
  assert.equal(terminalCreatorRequest(status), false, "absence or uncertainty without a cancellation fence cannot release an intent");
  local = saved;
  assert.equal(releaseCreatorRequest(storage, "test", { requestId: id, kind, status }, id, kind), status);
  assert.equal(local, saved, "nonterminal outcome cannot release a receipt");
}
for (const receipt of [null, {}, { error: "forbidden" }, { requestId: crypto.randomUUID(), kind, status: "committed" }, { requestId: id, kind: "another-operation", status: "cancelled" }, { requestId: id, kind, status: "missing" }, { requestId: id, kind, status: "unknown" }, { requestId: id, kind, status: null }]) {
  assert.throws(() => creatorRequestOutcome(receipt, id, kind), /outcome_unconfirmed/, "malformed/mismatched/unsupported results must retain the retry receipt");
  local = saved;
  assert.throws(() => releaseCreatorRequest(storage, "test", receipt, id, kind), /outcome_unconfirmed/);
  assert.equal(local, saved);
}
local = JSON.stringify({ id: crypto.randomUUID(), signature: "a".repeat(64) });
const newer = local;
assert.throws(() => releaseCreatorRequest(storage, "test", { requestId: id, kind, status: "cancelled" }, id, kind), /receipt_changed/);
assert.equal(local, newer, "a delayed cancellation response cannot clear a different saved request");
console.log("creatorRequestOutcome.test: matching terminal-only release, unknown retention and malformed/mismatched refusal passed");
