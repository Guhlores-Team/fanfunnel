import assert from "node:assert/strict";
import { deliveryLeaveDecision } from "./deliveryNavigation";

for (const intent of ["section", "signout"] as const) {
  for (const dirty of [false, true]) {
    for (const wheelDirty of [false, true]) {
      assert.equal(deliveryLeaveDecision({ pending: true, dirty }, wheelDirty, intent), "wait", "an in-flight save cannot be discarded through any leave path");
    }
  }
  assert.equal(deliveryLeaveDecision({ pending: false, dirty: true }, false, intent), "confirm", "secret drafts always need a keep/discard choice");
  assert.equal(deliveryLeaveDecision({ pending: false, dirty: true }, true, intent), "confirm");
  assert.equal(deliveryLeaveDecision({ pending: false, dirty: false }, false, intent), "leave");
}
assert.equal(deliveryLeaveDecision({ pending: false, dirty: false }, true, "section"), "leave", "ordinary wheel edits still survive moving between sections");
assert.equal(deliveryLeaveDecision({ pending: false, dirty: false }, true, "signout"), "confirm", "signing out still protects ordinary wheel drafts");
console.log("deliveryNavigation.test: 16 checks passed");
