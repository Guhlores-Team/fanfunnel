import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL, acceptedCurrentTerms, fanNeedsAck, formatLegalDate } from "./legal";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

check("formats an ISO date in words", formatLegalDate("2026-10-27") === "October 27, 2026");
check("drops a leading zero from the day", formatLegalDate("2027-01-05") === "January 5, 2027");
check("rejects a non-ISO date", (() => {
  try {
    formatLegalDate("27/10/2026");
    return false;
  } catch {
    return true;
  }
})());
check("rejects month 13", (() => {
  try {
    formatLegalDate("2026-13-01");
    return false;
  } catch {
    return true;
  }
})());

check("effective date is a valid ISO date", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL.effectiveDate));
check("contact is an email address", /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(LEGAL.contactEmail));
check("governing law is Massachusetts", LEGAL.governingLaw.includes("Massachusetts"));
check("minimum age is 18", LEGAL.minimumAge === 18);
check("terms version is a valid ISO date", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL.version));
check("change notice is 30 days", LEGAL.changeNoticeDays === 30);

check("current version is accepted", acceptedCurrentTerms(LEGAL.version));
check("an older version is not", !acceptedCurrentTerms("2000-01-01"));
check("no record is not", !acceptedCurrentTerms(null) && !acceptedCurrentTerms(undefined));
check("a fan who never agreed needs the gate", fanNeedsAck(null, null));
check("a fan with no recorded version needs the gate again", fanNeedsAck("2026-01-01T00:00:00Z", null));
check("a fan on an old version needs the gate again", fanNeedsAck("2026-01-01T00:00:00Z", "2000-01-01"));
check("a fan on the current version does not", !fanNeedsAck("2026-01-01T00:00:00Z", LEGAL.version));

// The pages must take these facts from LEGAL, never hard-code them, so the
// operator, date and contact can be swapped in one place.
const root = join(import.meta.dirname, "..");
for (const page of ["app/terms/page.tsx", "app/privacy/page.tsx", "components/LegalPage.tsx"]) {
  const src = readFileSync(join(root, page), "utf8");
  check(`${page} has no draft-placeholder banner`, !/Draft placeholder/i.test(src));
  check(`${page} does not hard-code the contact email`, !src.includes(LEGAL.contactEmail));
  check(`${page} does not hard-code the effective date`, !src.includes(LEGAL.effectiveDate));
}

// The contact address is a one-line swap: nothing outside legal.ts (and this
// test) may spell it out, in the app or in the e2e suite.
const repo = join(root, "..");
const ownFiles = new Set([join(root, "lib/legal.ts"), join(root, "lib/legal.test.ts")]);
const hardCoded: string[] = [];
for (const dir of ["src", "e2e"]) {
  for (const rel of readdirSync(join(repo, dir), { recursive: true }) as string[]) {
    const file = join(repo, dir, rel);
    if (!/\.(tsx?|mjs|js)$/.test(file) || ownFiles.has(file)) continue;
    if (readFileSync(file, "utf8").includes(LEGAL.contactEmail)) hardCoded.push(join(dir, rel));
  }
}
check(`no file but legal.ts hard-codes the contact email (found: ${hardCoded.join(", ") || "none"})`, hardCoded.length === 0);

console.log(`legal: ${passed} checks passed`);
