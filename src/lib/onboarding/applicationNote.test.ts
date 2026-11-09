import assert from "node:assert";
import { composeApplicationNote, parseApplicationNote } from "./applicationNote";
import { REJECTION_REASONS, isRejectionReason, rejectionReasonText } from "./rejectionReasons";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const full = { platform: "OnlyFans", country: "UK", referral: "A friend", note: "Line one\nLine two" };
const composed = composeApplicationNote(full);
check("compose keeps the stored format", composed === "Main platform: OnlyFans\nBased in: UK\nHeard about us: A friend\nNotes: Line one\nLine two");
check("parse round-trips every field, multi-line notes too", JSON.stringify(parseApplicationNote(composed)) === JSON.stringify(full));
check("blank fields are left out", composeApplicationNote({ platform: "X", country: " ", referral: "", note: "" }) === "Main platform: X");
check("an empty note parses to empty fields", JSON.stringify(parseApplicationNote(null)) === JSON.stringify({ platform: "", country: "", referral: "", note: "" }));
check("a hand-written note is kept as the note", parseApplicationNote("just text").note === "just text");

// C7 reason codes: short, PII-free codes the audit log keeps.
check("every reason code fits the audit log's details rule", Object.keys(REJECTION_REASONS).every((k) => /^[a-z_]{1,64}$/.test(k)));
check("known code → applicant text", rejectionReasonText("unverified") === REJECTION_REASONS.unverified.applicant);
check("unknown or missing → no text", rejectionReasonText("free text from someone") === null && rejectionReasonText(undefined) === null);
check("prototype keys are not reasons", !isRejectionReason("toString") && !isRejectionReason("__proto__"));

console.log(`applicationNote.test: ${passed} checks passed`);
