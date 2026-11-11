import assert from "node:assert";
import { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// /reset-password and /set-password (WU-06 / WU-07 / WU-09): the screen asks
// the reset route what the session needs and shows the matching step; the
// provider's sentences never reach the creator; the demo has no accounts.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }) } });
mock.module("@/lib/supabase/client", { namedExports: { createClient: () => { throw new Error("no client in SSR"); }, isSupabaseConfigured: () => false } });

async function main() {
  const { default: NewPasswordForm, resetRequirementFromResponse, resetErrorMessage, switchedNoticeFor } = await import("./NewPasswordForm");
  // Review A4: the switched-account sentence needs the flag AND the e-mail the
  // route read from the session; the URL can switch it on but never name anyone.
  check("flag + the session's e-mail → 'You're now signed in as …'", switchedNoticeFor("?switched=1", "bob@example.com")?.title === "You're now signed in as bob@example.com");
  check("no flag → nothing", switchedNoticeFor("", "bob@example.com") === null && switchedNoticeFor("?switched=0", "bob@example.com") === null);
  check("flag without a session e-mail → nothing", switchedNoticeFor("?switched=1", undefined) === null && switchedNoticeFor("?switched=1", "") === null && switchedNoticeFor("?switched=1", 7) === null);
  check("an e-mail in the URL is ignored", !JSON.stringify(switchedNoticeFor("?switched=1&email=attacker@evil.example", "bob@example.com")).includes("attacker"));
  check("401 → the link is gone", resetRequirementFromResponse(401, { error: "unauthorized" }) === "no_session");
  check("mfa_required → the code step (WU-07)", resetRequirementFromResponse(403, { error: "mfa_required", step: "challenge" }) === "mfa");
  check("current_password_required → the current-password field (WU-06)", resetRequirementFromResponse(403, { error: "current_password_required" }) === "current_password");
  check("200 → the plain form", resetRequirementFromResponse(200, { ok: true, requires: "none" }) === "none");
  check("anything else → an error line", resetRequirementFromResponse(500, null) === "error");
  check("a wrong current password is worded", resetErrorMessage(403, "wrong_password") === "Your current password is incorrect.");
  check("same_password is worded", /current password/.test(resetErrorMessage(400, "same_password")));
  check("429 is worded", /Too many tries/.test(resetErrorMessage(429, "rate_limited")));
  check("an unknown code never shows raw text", resetErrorMessage(400, "AAL2 session is required") === "Couldn't update your password. Try again, or request a new reset link.");

  const html = renderToStaticMarkup(createElement(NewPasswordForm, { variant: "reset" }));
  check("demo: no accounts, a link back to the dashboard", /isn.t available here/.test(html) && /\/dashboard/.test(html));
  console.log(`NewPasswordForm.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
