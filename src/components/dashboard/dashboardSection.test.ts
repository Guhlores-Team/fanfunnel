import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECTIONS, fanFromSearch, fanHref, resolveSection, sectionFromSearch, sectionHref } from "./dashboardSection";

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

// QA b5 m5: the section (and an open fan drawer) live in the URL.
assert.equal(sectionHref("fans"), "/dashboard?section=fans");
assert.equal(sectionHref("editor", "/dashboard"), "/dashboard?section=editor");
assert.equal(sectionFromSearch("?section=campaigns", false), "campaigns");
assert.equal(sectionFromSearch("", false), "today", "no section is Today");
assert.equal(sectionFromSearch("?section=admin", false), "today", "a non-admin's Back to an admin URL lands on Today");
assert.equal(sectionFromSearch("?section=admin", true), "admin");
assert.equal(fanHref("fan-1"), "/dashboard?section=fans&fan=fan-1");
assert.equal(fanFromSearch("?section=fans&fan=fan-1"), "fan-1");
assert.equal(fanFromSearch("?section=fans"), null);
assert.equal(fanFromSearch("?fan=" + "x".repeat(201)), null, "an oversized id is ignored");
{
  const client = readFileSync(new URL("./DashboardClient.tsx", import.meta.url), "utf8");
  assert.match(client, /window\.history\.pushState\(\{ ffSection: t \}/, "a section change pushes a history entry");
  assert.match(client, /addEventListener\("popstate", onPop\)/, "Back/Forward switch sections");
  assert.match(client, /goTab\(next, undefined, "replace"\)/, "Back goes through the unsaved-changes guard");
  const fans = readFileSync(new URL("./FansPanel.tsx", import.meta.url), "utf8");
  assert.match(fans, /window\.history\.pushState\(\{ ffFan: id \}/, "opening a fan pushes an entry");
  assert.match(fans, /window\.history\.back\(\)/, "closing the drawer steps back over its entry");
}

console.log("dashboardSection.test: all checks passed");
