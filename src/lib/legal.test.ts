import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL, formatLegalDate } from "./legal";

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

// The pages must take these facts from LEGAL, never hard-code them, so the
// operator, date and contact can be swapped in one place.
const root = join(import.meta.dirname, "..");
for (const page of ["app/terms/page.tsx", "app/privacy/page.tsx", "components/LegalPage.tsx"]) {
  const src = readFileSync(join(root, page), "utf8");
  check(`${page} has no draft-placeholder banner`, !/Draft placeholder/i.test(src));
  check(`${page} does not hard-code the contact email`, !src.includes(LEGAL.contactEmail));
  check(`${page} does not hard-code the effective date`, !src.includes(LEGAL.effectiveDate));
}

console.log(`legal: ${passed} checks passed`);
