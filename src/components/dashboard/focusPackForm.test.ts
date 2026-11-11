import assert from "node:assert/strict";
import { packFormDraft, parsePackForm, type PackFormDraft } from "./focusPackForm";
import { MAX_COMBINED_BOOST, MAX_FOCUS_SPINS, MIN_FOCUS_MULTIPLIER, MIN_FOCUS_SPINS } from "@/lib/focus/config";

const base: PackFormDraft = { ...packFormDraft(), label: "Focus pack", amount: "5.25", kind: "focus" };
for (const duration of [MIN_FOCUS_SPINS, MAX_FOCUS_SPINS]) for (const multiplier of [MIN_FOCUS_MULTIPLIER, MAX_COMBINED_BOOST]) {
  const result = parsePackForm({ ...base, duration: String(duration), multiplier: String(multiplier) });
  assert.ok("value" in result);
  assert.equal(result.value.amountCents, 525, "prices are cents");
  assert.equal(result.value.spins, duration, "modifier duration and credited spins agree");
  assert.equal(result.value.focusSpins, duration);
  assert.equal(result.value.focusMultiplier, multiplier);
  assert.equal(result.value.bonusSpins, 0);
  assert.ok(!("chaseWithin" in result.value), "inactive fields must be omitted, not null");
}
for (const duration of [MIN_FOCUS_SPINS - 1, MAX_FOCUS_SPINS + 1, 5.5, NaN]) assert.ok("error" in parsePackForm({ ...base, duration: String(duration) }));
for (const multiplier of [MIN_FOCUS_MULTIPLIER - 0.01, MAX_COMBINED_BOOST + 0.01, Infinity]) assert.ok("error" in parsePackForm({ ...base, multiplier: String(multiplier) }));
const chase = parsePackForm({ ...base, kind: "chase", multiplier: "invalid", duration: "10" });
assert.ok("value" in chase);
assert.deepEqual(chase.value, { label: "Focus pack", amountCents: 525, spins: 10, bonusSpins: 0, packKind: "chase", chaseWithin: 10 }, "Chase uses only its active terms and does not inherit Focus settings");
const ordinary = parsePackForm({ ...base, kind: "spins", spins: "12", bonus: "3", duration: "invalid", multiplier: "invalid" });
assert.ok("value" in ordinary);
assert.deepEqual(ordinary.value, { label: "Focus pack", amountCents: 525, spins: 12, bonusSpins: 3, packKind: "spins" }, "ordinary bonus/quantity terms survive modifier support");
for (const patch of [{ amount: "" }, { amount: "-1" }, { label: " " }, { kind: "spins" as const, spins: "1.5" }, { kind: "spins" as const, spins: "1", bonus: "-1" }]) assert.ok("error" in parsePackForm({ ...base, ...patch }));
console.log("focusPackForm.test: limits, cents, ordinary compatibility and active-only modifier payloads passed");
