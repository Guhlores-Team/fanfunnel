import assert from "node:assert";
import { wheelSaveErrorMessage } from "./wheelSaveErrors";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// The three server-enforced wheel rules read as sentences, not codes.
check("too_few_prizes", wheelSaveErrorMessage("too_few_prizes") === "Couldn't save: a wheel needs at least 2 prizes.");
check("prize_name_required", wheelSaveErrorMessage("prize_name_required") === "Couldn't save: give every prize a name.");
check(
  "no_winnable_prize",
  wheelSaveErrorMessage("no_winnable_prize") === "Couldn't save: at least one prize needs more than 0 tickets."
);

// Existing codes keep their copy.
check("bad_color", wheelSaveErrorMessage("bad_color") === "Couldn't save: a color or stock value is invalid.");
check("bad_stock", wheelSaveErrorMessage("bad_stock") === "Couldn't save: a color or stock value is invalid.");
check("unauthorized", wheelSaveErrorMessage("unauthorized") === "Couldn't save. Are you signed in?");

// Every message is a sentence and never echoes the raw code.
for (const code of ["too_few_prizes", "prize_name_required", "no_winnable_prize", "bad_weight", "too_many_prizes", "stale_editor", "not_found"]) {
  const msg = wheelSaveErrorMessage(code);
  check(`${code}: no raw code`, !msg.includes(code) && !msg.includes("_"));
  check(`${code}: ends with a period`, msg.endsWith("."));
}

// Unknown / non-string input falls back to a generic sentence.
check("unknown code → generic", wheelSaveErrorMessage("db_error") === "Couldn't save. Try again.");
check("undefined → generic", wheelSaveErrorMessage(undefined) === "Couldn't save. Try again.");
check("prototype key → generic", wheelSaveErrorMessage("toString") === "Couldn't save. Try again.");

console.log(`wheelSaveErrors: ${passed} checks passed`);
