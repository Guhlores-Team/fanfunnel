import assert from "node:assert/strict";
import { completeCreatorIntent, durableCreatorIntent, readCreatorIntent } from "./creatorIntent";

async function main() {
const records = new Map<string, string>();
const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
const payload = { name: "private-fan-handle", packId: "saved-pack", packUnits: 3, optional: undefined };
const id = await durableCreatorIntent(storage, "new-fan", payload);
assert.match(id, /^[0-9a-f-]{36}$/);
assert.equal(await durableCreatorIntent(storage, "new-fan", { packUnits: 3, packId: "saved-pack", name: payload.name }), id, "reordered equivalent requests reuse their durable UUID after reload/timeout");
const persisted = records.get("ff:creator-intent:new-fan")!;
assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ["id", "signature"]);
assert.ok(!persisted.includes(payload.name) && !persisted.includes(payload.packId), "no fan details, tokens or prices are persisted");
assert.match(JSON.parse(persisted).signature, /^[a-f0-9]{64}$/);
assert.equal(readCreatorIntent(storage, "new-fan")?.id, id, "reconciliation can read the opaque UUID without reconstructing fan details");
assert.equal(readCreatorIntent(storage, "no-receipt"), null);
await assert.rejects(durableCreatorIntent(storage, "new-fan", { ...payload, packUnits: 4 }), /intent_pending/, "quantity cannot silently replace an unknown grant");
await assert.rejects(durableCreatorIntent(storage, "new-fan", { ...payload, name: "different-fan" }), /intent_pending/);
assert.equal(records.get("ff:creator-intent:new-fan"), persisted, "a different intent cannot destroy the original retry receipt");
completeCreatorIntent(storage, "new-fan", crypto.randomUUID());
assert.equal(records.get("ff:creator-intent:new-fan"), persisted, "an old callback cannot erase another operation");
completeCreatorIntent(storage, "new-fan", id);
assert.equal(records.size, 0, "only a definitive matching completion clears the operation");
const next = await durableCreatorIntent(storage, "new-fan", { ...payload, packUnits: 4 });
assert.notEqual(next, id, "a new action after completion gets a fresh UUID");
assert.notEqual(await durableCreatorIntent(storage, "topup:another-fan", payload), next, "independent fans have independent intents");
for (const bad of ["", "not-json", "null", JSON.stringify({ id: next, signature: "not-a-digest" }), JSON.stringify({ id: "invalid", signature: "a".repeat(64) })]) {
  records.set("ff:creator-intent:corrupt", bad);
  await assert.rejects(durableCreatorIntent(storage, "corrupt", payload), /intent_unreadable/);
  assert.equal(records.get("ff:creator-intent:corrupt"), bad, "corruption fails closed without deleting evidence");
}
await assert.rejects(durableCreatorIntent({ ...storage, setItem: () => { throw new Error("blocked"); } }, "blocked", payload), /blocked/, "storage failure prevents sending a non-durable grant");
await assert.rejects(durableCreatorIntent({ ...storage, getItem: () => null, setItem: () => {} }, "silent", payload), /intent_not_persisted/, "silently ignored writes must prevent the grant fetch too");
await assert.rejects(durableCreatorIntent({ ...storage, getItem: () => null, setItem: () => { records.set("unrelated", "other data"); } }, "wrong-key", payload), /intent_not_persisted/, "an unrelated successful write is not proof the receipt persisted");
assert.throws(() => completeCreatorIntent({ ...storage, removeItem: () => {} }, "new-fan", next), /intent_not_cleared/, "silently ignored deletes cannot be reported as receipt completion");
console.log("creatorIntent.test: durable retry, quantity binding, privacy and fail-closed checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
