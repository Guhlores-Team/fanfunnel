import assert from "node:assert";
import { initials } from "./inboxHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- initials ------------------------------------------------------------
check("handle: leading @ is dropped", initials("@mia_rose") === "MI");
check("handle with a dot", initials("@jordan.x") === "JO");
check("plain name uses its first two letters", initials("Demo Fan") === "DE");
check("always upper-cased", initials("sasha_k") === "SA");
check("single character", initials("@x") === "X");
check("punctuation-only falls back", initials("@__") === "?");
check("empty falls back", initials("") === "?");
check("unicode letters count", initials("élodie") === "ÉL");
check("digits count", initials("4ever") === "4E");

console.log(`inboxHelpers: ${passed} checks passed`);
