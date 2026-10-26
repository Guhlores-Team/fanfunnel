import assert from "node:assert/strict";
import { SECTIONS, resolveSection } from "./dashboardSection";

// P52: an active admin (or demo mode) can deep-link into the Admin section.
assert.equal(resolveSection("admin", true), "admin");

// Negative: a non-admin asking for ?section=admin gets nothing (the shell
// falls back to its default section), so the Admin panel never mounts.
assert.equal(resolveSection("admin", false), undefined);
assert.equal(resolveSection(["admin", "fans"], false), undefined);

// Every other section is open to any signed-in creator.
for (const t of SECTIONS.filter((s) => s !== "admin")) {
  assert.equal(resolveSection(t, false), t);
}

// Unknown, empty or missing values resolve to nothing; the first repeated
// value wins, as with any query param.
assert.equal(resolveSection("Admin", true), undefined);
assert.equal(resolveSection("", true), undefined);
assert.equal(resolveSection(undefined, true), undefined);
assert.equal(resolveSection(["fans", "admin"], false), "fans");

console.log("dashboardSection.test: all checks passed");
