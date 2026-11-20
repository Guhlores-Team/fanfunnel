import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "./legal";

// TS-01: the Terms and Privacy text may not change behind the version fans
// and creators accepted. The hash of both pages' source is stored next to
// LEGAL.version (legal.ts) and includes the version itself, so an edit to
// either page, or a version bump, fails here until the hash is set again:
// that is the moment to bump version + effectiveDate in the same commit
// (docs/LEGAL_NOTES.md, "Version discipline"). legalTermsVersion.test.ts
// separately ties LEGAL.version to the database.

const root = join(import.meta.dirname, "..");
const PAGES = ["app/terms/page.tsx", "app/privacy/page.tsx"];

/** SHA-256 over the version and both pages' source, in a fixed order. */
export function legalTextHash(version: string, sources: string[]): string {
  const h = createHash("sha256");
  h.update(version + "\n");
  for (const s of sources) h.update(s.replace(/\r\n/g, "\n") + "\n");
  return h.digest("hex");
}

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

check("LEGAL.version is a date", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL.version));
check("LEGAL.effectiveDate is a date", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL.effectiveDate));
check("the effective date is not before the version date", LEGAL.effectiveDate >= LEGAL.version);
check("textHash is a SHA-256 hex digest", /^[0-9a-f]{64}$/.test(LEGAL.textHash));

const actual = legalTextHash(LEGAL.version, PAGES.map((p) => readFileSync(join(root, p), "utf8")));
check(
  `Terms/Privacy text matches LEGAL.textHash for version ${LEGAL.version}. If you edited terms/page.tsx or privacy/page.tsx: bump LEGAL.version and LEGAL.effectiveDate (and legal_terms_version() in a migration), then set LEGAL.textHash to ${actual}`,
  actual === LEGAL.textHash,
);

console.log(`legal text hash: ${passed} checks passed`);
