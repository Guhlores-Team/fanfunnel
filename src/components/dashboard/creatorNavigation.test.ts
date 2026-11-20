import assert from "node:assert/strict";
import { creatorNavigationState, creatorScopeIncludes } from "./creatorNavigation";
import { deliveryLeaveDecision } from "./deliveryNavigation";
import type { CreatorDraftState } from "./CreatorDrafts";

const clean = { dirty: false, pending: false };
const records = new Map<string, CreatorDraftState>([
  ["pack", { scope: "packs:campaign", description: "saved pack edits", dirty: true, pending: false }],
  ["topup", { scope: "fan-topup:one", description: "an unconfirmed top-up", dirty: true, pending: true }],
  ["focus", { scope: "fan-focus:one", description: "a focus selection", dirty: true, pending: false }],
]);
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, clean), false, "section"), "wait", "global navigation cannot discard another mounted form's pending grant");
const packClose = creatorNavigationState(records, clean, "packs:campaign");
assert.equal(packClose.pending, false, "closing an unrelated local editor does not wait for the fan drawer");
assert.deepEqual(packClose.descriptions, ["saved pack edits"]);
assert.equal(deliveryLeaveDecision(packClose, false, "section"), "confirm", "a local dirty close requires explicit discard");
const drawerScopes = ["fan-topup:one", "fan-focus:one"];
assert.equal(creatorNavigationState(records, clean, drawerScopes).pending, true, "drawer close protects both nested forms");
assert.deepEqual(creatorNavigationState(records, clean, drawerScopes).descriptions, ["an unconfirmed top-up", "a focus selection"]);
for (const [key, record] of records) if (creatorScopeIncludes(drawerScopes, record.scope)) records.delete(key);
assert.deepEqual([...records.keys()], ["pack"], "discarding a drawer must preserve other editors' registrations");
assert.equal(creatorNavigationState(records, clean).dirty, true);
records.delete("pack");
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, clean), false, "section"), "leave", "unmount cleanup leaves no phantom dirty state");
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, { dirty: true, pending: false }), false, "section"), "confirm", "0057 secret delivery drafts remain guarded globally");
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, { dirty: true, pending: true }), true, "signout"), "wait", "pending requests outrank both secret and wheel drafts");
assert.equal(creatorNavigationState(records, { dirty: true, pending: true }, "packs:campaign").pending, false, "a scoped close does not discard global delivery state");
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, clean), true, "section"), "leave", "ordinary wheel drafts still survive section changes");
assert.equal(deliveryLeaveDecision(creatorNavigationState(records, clean), true, "signout"), "confirm");
console.log("creatorNavigation.test: scoped close, global pending, cleanup and delivery/wheel compatibility checks passed");
