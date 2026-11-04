import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { RETENTION_DAYS } from "./retention";

// The published policy must describe the actual privacy controls and retention
// behavior, including financial records that remain after a fan is deleted.
const text = renderToStaticMarkup(createElement(PrivacyPage))
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

assert.ok(!text.includes("There is no self-service download or delete button yet"), "the policy must not deny the self-service controls that shipped in 0054");
assert.match(text, /Safety & privacy/, "fans can find their download/delete controls");
assert.match(text, /Your data/, "creators can find their account controls");
assert.ok(!text.includes("Deleting a fan also deletes that fan’s links, spins, wins"), "the policy must not promise that retained wins are erased");
assert.match(text, /spins and redemptions.*without.*fan/i, "retained financial records are explained");
assert.match(text, /two-factor.*required.*admin/i, "admin two-factor enforcement is disclosed");
for (const days of new Set(Object.values(RETENTION_DAYS))) {
  assert.ok(text.includes(`${days} days`), `the rendered policy discloses the configured ${days}-day retention period`);
}
// A6: every kind of record the Service keeps is disclosed, with its retention.
for (const [label, pattern] of [
  ["visit check-ins", /check-ins/i],
  ["breaks and play reminders", /breaks and play reminders/i],
  ["instant-reward values and views", /Instant rewards:.*encrypted.*viewed/i],
  ["Focus and Chase boosts", /Focus and Chase/],
  ["spin attempts", /Spin attempts:/],
  ["win-back records", /win-back records/i],
  ["creator photos and theme", /gallery photos.*theme/i],
  ["push devices", /Push devices:/],
  ["two-factor factors", /Two-factor sign-in:/],
  ["report review outcome", /resolved or dismissed/],
  ["urgent report alerts carry no fan data", /email alert that names only the reason and the time, never the fan/],
  ["reward values are erased on fan deletion", /encrypted value is erased when the fan deletes their data/],
  // A11 (0065): the operational-history periods run_retention_cleanup enforces.
  ["check-in retention", new RegExp(`check-ins are also deleted after ${RETENTION_DAYS.fanCheckins} days`, "i")],
  ["finished spin-attempt retention", new RegExp(`${RETENTION_DAYS.finishedSpinAttempts} days after an attempt finishes.*declined attempt.*deleted`)],
  ["request record retention", new RegExp(`request records.*deleted ${RETENTION_DAYS.settledRequestJournal} days after the request settles`)],
  ["import batch retention", new RegExp(`import batches.*deleted after ${RETENTION_DAYS.fanImportBatches} days`)],
  // A7 follow-up: games shipped in 0060/0061.
  ["bingo cards and scratch tickets", /Game cards and tickets:.*bingo.*scratch ticket/],
  ["bingo card retention", /Check-ins, bingo cards,/],
  // A9: every browser-storage record a fan page writes.
  ["the durable spin-intent record", /Saved spin request.*fingerprint of your link.*removed once you close the result/],
  ["the play-reminder acknowledgement", /Keep playing” on a play reminder.*24 hours/],
] as const) {
  assert.match(text, pattern, `the policy discloses ${label}`);
}
const terms = renderToStaticMarkup(createElement(TermsPage))
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");
assert.ok(!/We do not own, check, store, ship/.test(terms), "the Terms must not deny storing instant-delivery prize codes");
assert.match(terms, /store the link, text or one-time codes.*encrypted/, "stored prize codes are disclosed");
assert.match(terms, /Focus.*Chase/, "Focus and Chase odds changes are disclosed");
assert.match(terms, /public photos are safe for work/i, "the SFW-only photo rule is stated");
assert.match(terms, /blocked fan’s link no longer spins.*chat.*wishlist.*leaderboard/, "what blocking stops is stated");
// A7 follow-up: the Terms describe the games a spin can play.
assert.match(terms, /scratch ticket.*decided on our server.*Reveal all/, "scratch tickets are described");
assert.match(terms, /personal bingo.*3×3 card.*row, column or diagonal.*line bonus/, "personal bingo is described");
// A10: no promise the app cannot keep. There is no creator email broadcast;
// the in-app re-agreement (LEGAL.version) is what actually reaches people.
for (const [name, doc] of [["Privacy", text], ["Terms", terms]] as const) {
  assert.ok(!/by email to creators/.test(doc), `${name} must not promise change notices by email`);
  assert.match(doc, /asks creators \(in the dashboard\) and fans \(on their spin page\) to agree/, `${name} describes the in-app re-agreement`);
}
console.log("privacy policy: rendered self-service, retention, de-identification and MFA promises passed");
