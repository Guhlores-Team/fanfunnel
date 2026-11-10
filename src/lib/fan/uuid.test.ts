import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { hasOwn, lastOf, randomUuid } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A browser with only getRandomValues (iOS 15.0 Safari).
const legacy = { getRandomValues: <T extends ArrayBufferView | null>(array: T) => (array ? webcrypto.getRandomValues(array as unknown as Uint8Array) : array) as T };
const seen = new Set<string>();
for (let i = 0; i < 200; i++) {
  const id = randomUuid(legacy);
  assert.match(id, V4, "fallback mints a well-formed v4 uuid");
  seen.add(id);
}
assert.equal(seen.size, 200, "fallback ids are distinct");
assert.match(randomUuid(), V4, "native path still returns a v4 uuid");
let used = false;
randomUuid({ getRandomValues: legacy.getRandomValues, randomUUID: () => { used = true; return webcrypto.randomUUID(); } });
assert.ok(used, "the native randomUUID is preferred where it exists");
assert.equal(hasOwn({ a: 1 }, "a"), true);
assert.equal(hasOwn({ a: 1 }, "toString"), false, "inherited keys are not own");
assert.equal(hasOwn(Object.create(null), "x"), false);
assert.equal(lastOf([1, 2, 3]), 3);
assert.equal(lastOf([]), undefined);
console.log("uuid: fallback/hasOwn/lastOf checks passed");
