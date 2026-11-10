import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL, acceptedCurrentTerms, activeLegalChangeNotice, fanNeedsAck, formatLegalDate } from "./legal";

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

// TS-06: the announced-change notice shows only for a later version whose
// effective date is still ahead (end of that day, UTC), never for the version
// in force or after the date has passed.
const later = { version: "2099-01-31", effectiveDate: "2099-01-31", summary: "Prizes section rewritten." };
check("no notice when nothing is announced", activeLegalChangeNotice(new Date("2026-11-10T00:00:00Z"), null) === null);
check("a later version with a future date shows", activeLegalChangeNotice(new Date("2098-12-20T00:00:00Z"), later) === later);
check("it still shows on the effective day itself", activeLegalChangeNotice(new Date("2099-01-31T23:00:00Z"), later) === later);
check("it stops after the effective day", activeLegalChangeNotice(new Date("2099-02-01T00:00:00Z"), later) === null);
check("the version already in force never shows", activeLegalChangeNotice(new Date("2000-01-01T00:00:00Z"), { ...later, version: LEGAL.version }) === null);
check("an older version never shows", activeLegalChangeNotice(new Date("2000-01-01T00:00:00Z"), { ...later, version: "2000-01-01" }) === null);
check("a malformed date never shows", activeLegalChangeNotice(new Date("2000-01-01T00:00:00Z"), { ...later, effectiveDate: "soon" }) === null);
if (LEGAL.upcoming) {
  check("an announced change is for a later version", LEGAL.upcoming.version > LEGAL.version);
  check("an announced change has a date and a summary", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL.upcoming.effectiveDate) && LEGAL.upcoming.summary.length > 0);
}
check("the team reply label is a decision switch with a label", typeof LEGAL.teamReplyLabel.enabled === "boolean" && LEGAL.teamReplyLabel.label.length > 0);

// Public-text rule: nothing a fan reads on the legal pages or in the change
// notice uses purchase or gambling vocabulary. The one allowed phrase names
// the laws creators must follow ("laws on lotteries, sweepstakes…"), which
// the Terms have to spell out for creators.
const BANNED = /\b(buy|buys|bought|paid|purchase|purchases|purchased|gamble|gambling|bet|bets|betting|lottery|lotteries)\b/i;
const ALLOWED_PHRASES = ["laws on lotteries, sweepstakes, contests and promotions"];
for (const page of ["app/terms/page.tsx", "app/privacy/page.tsx", "components/LegalPage.tsx", "components/LegalChangeNotice.tsx"]) {
  let src = readFileSync(join(root, page), "utf8");
  for (const phrase of ALLOWED_PHRASES) src = src.split(phrase).join("");
  const hit = BANNED.exec(src);
  check(`${page} keeps purchase/gambling words out of fan-facing text (found: ${hit?.[0] ?? "none"})`, hit === null);
}

console.log(`legal: ${passed} checks passed`);
