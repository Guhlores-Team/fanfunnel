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
console.log("privacy policy: rendered self-service, retention, de-identification and MFA promises passed");
