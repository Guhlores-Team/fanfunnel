import assert from "node:assert/strict";
import { mockCreatePass, mockDeleteFanWithTombstones, mockGetFanLinkStatus, mockListFans } from "./mock";
import { deleteFan } from "./fans";

// DB-06 parity: a creator-side fan deletion leaves a tombstone on each of the
// fan's links (0073 scrub_fan_traces does this in the database), so a saved
// link says the data was deleted instead of answering a bare 404.

let passed = 0;
function check(label: string, value: unknown) {
  assert.ok(value, label);
  passed++;
}

async function main() {
  const made = mockCreatePass("Tombstone fan", 3);
  check("a live link has no tombstone", (await mockGetFanLinkStatus(made.token)) === null);
  const result = await deleteFan(made.fanId);
  check("the creator-side delete succeeds", "ok" in result);
  check("the fan is gone from the list", !mockListFans().some((f) => f.fanId === made.fanId));
  check("the link keeps a fan_deleted tombstone", (await mockGetFanLinkStatus(made.token)) === "fan_deleted");
  check("an unknown link still has none", (await mockGetFanLinkStatus("never-minted")) === null);
  const again = await deleteFan(made.fanId);
  check("deleting twice reports not_found", "error" in again && again.error === "not_found");
  check("the helper refuses an unknown fan", (await mockDeleteFanWithTombstones("nope")) === false);
  console.log(`fanDeleteTombstone: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
