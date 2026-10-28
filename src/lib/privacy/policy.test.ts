import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
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
console.log("privacy policy: rendered self-service, retention, de-identification and MFA promises passed");
