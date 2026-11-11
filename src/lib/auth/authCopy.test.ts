import assert from "node:assert";
import { authErrorInfo, authErrorMessage, authLinkNotice, EMAIL_REQUEST_ANSWER, EMAIL_REQUEST_FAILED, emailRequestOutcome, isRateLimited, retryAfterMinutes, tooManyEmailsMessage } from "./authCopy";
import { LEGAL } from "@/lib/legal";

// WU-03 / TS-11 / WU-15 / WC-04: every sentence the sign-in family shows is
// ours; no raw provider text, no "same browser", and the failed-link notice
// fits the kind of link.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

// Failed-link notices, per type.
const signup = authLinkNotice("signup", "expired");
check("a used/expired confirmation says: already confirmed? sign in", /already used or has expired/.test(signup.title) && /sign in below/.test(signup.body) && signup.actions[0] === "sign_in" && signup.actions.includes("resend_confirmation"));
check("the e-mail type reads the same", authLinkNotice("email", "expired").title === signup.title);
const invite = authLinkNotice("invite", "expired");
check("an expired invitation leads to a new one", /invitation has expired/i.test(invite.title) && invite.actions.includes("contact_admin") && invite.actions.includes("reset_link"));
const recovery = authLinkNotice("recovery", "expired");
check("an expired reset offers a new reset link", recovery.actions.includes("reset_link") && !recovery.actions.includes("resend_confirmation"));
check("an expired e-mail change points at Settings", authLinkNotice("email_change", "expired").actions.includes("settings"));
check("a malformed link explains the cut link", /incomplete/.test(authLinkNotice("recovery", "malformed").title) && /copy the whole link/i.test(authLinkNotice("recovery", "malformed").body));
check("an unknown type still gets a notice with both actions", authLinkNotice(null, null).actions.length === 2);
for (const type of ["signup", "email", "recovery", "invite", "email_change", "magiclink", null]) {
  for (const reason of ["expired", "invalid", "malformed", null]) {
    const n = authLinkNotice(type, reason);
    check(`${type}/${reason}: never says same browser or device`, !/same (browser|device)/i.test(n.title + n.body));
    if (reason !== "malformed") check(`${type}/${reason}: says links work on any device`, /any device/i.test(n.body));
  }
}

// Review A3: a failure that decided nothing, and a blocked account.
const busy = authLinkNotice("recovery", "busy");
check("busy: says the link is still good and to try again in a few minutes", /still good/.test(busy.body) && /few minutes/.test(busy.body));
check("busy: never says used or expired, and offers no new link", !/used|expired/i.test(busy.title + busy.body) && busy.actions.length === 0);
const banned = authLinkNotice("invite", "banned");
check("banned: says sign-in is blocked for the account, names support", /blocked/.test(banned.body) && banned.body.includes(LEGAL.contactEmail) && banned.actions.join() === "contact_support");
check("banned: never says used or expired, never offers a new link", !/used|expired/i.test(banned.title + banned.body) && !banned.actions.includes("reset_link"));
for (const type of ["signup", "email", "recovery", "invite", "email_change", "magiclink", null]) {
  for (const reason of ["busy", "banned"]) {
    const n = authLinkNotice(type, reason);
    check(`${type}/${reason}: same sentence for every link type, no 'same browser'`, n.title === authLinkNotice("recovery", reason).title && !/same (browser|device)/i.test(n.title + n.body));
  }
}

// Rate limits (WU-05).
check("over_email_send_rate_limit is a rate limit", isRateLimited({ code: "over_email_send_rate_limit" }));
check("a 429 status is a rate limit", isRateLimited({ status: 429, message: "Request rate limit reached" }));
check("invalid credentials is not", !isRateLimited({ code: "invalid_credentials" }));
check("the wait comes from Retry-After", retryAfterMinutes({ headers: new Headers({ "retry-after": "180" }) }) === 3);
check("…or from the message", retryAfterMinutes({ message: "For security purposes, you can only request this after 45 seconds." }) === 1);
check("…else unknown", retryAfterMinutes({ message: "Email rate limit exceeded" }) === 0);
check("the honest line names the wait", tooManyEmailsMessage({ headers: new Headers({ "retry-after": "120" }) }) === "Too many e-mails were sent just now, so this one wasn't. Try again in 2 minutes.");
check("…or 'a few minutes'", /a few minutes/.test(tooManyEmailsMessage({ code: "over_email_send_rate_limit" })));

// Review A7 / A8: forgot-password and "Resend confirmation" answer the same
// for an address with and without an account; only failures that do not
// depend on the address are worded as failures.
check("the uniform answer, word for word", EMAIL_REQUEST_ANSWER === "If an account exists for that address, an e-mail is on its way. You can ask again in a minute.");
check("A8: the failure sentence, word for word", EMAIL_REQUEST_FAILED === "We couldn't send that just now. Check your connection and try again.");
const sent = (err: unknown) => emailRequestOutcome(err).kind === "sent";
const failed = (err: unknown) => { const o = emailRequestOutcome(err); return o.kind === "error" ? o.message : null; };
check("no error → sent", sent(null) && sent(undefined));
// Existence-dependent refusals look exactly like a send (A7).
check("the per-address 60 s cooldown looks like a send", sent({ code: "over_email_send_rate_limit", status: 429, message: "For security purposes, you can only request this after 37 seconds." }));
check("…also from an Auth server that sends no code", sent({ status: 429, message: "For security purposes, you can only request this after 37 seconds." }));
check("the project's hourly e-mail cap looks like a send", sent({ code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded" }) && sent({ status: 429, message: "Email rate limit exceeded" }));
check("an unknown 4xx is never more specific than a send", sent({ code: "user_not_found", status: 404, message: "User not found" }) && sent({ status: 400, message: "x" }) && sent({ code: "email_not_confirmed", status: 400, message: "x" }));
// Address-independent failures are worded honestly.
check("a per-network request limit says so, with the wait", failed({ code: "over_request_rate_limit", status: 429, message: "Request rate limit reached", headers: new Headers({ "retry-after": "120" }) }) === "Too many requests from this network just now. Wait 2 minutes, then try again.");
check("…or 'a few minutes'", /a few minutes/.test(failed({ status: 429, message: "Request rate limit reached" }) ?? ""));
check("the request-limit sentence never mentions e-mails or accounts", !/e-?mail|account/i.test(failed({ code: "over_request_rate_limit", status: 429, message: "x" }) ?? "x e-mail"));
for (const [label, err] of [
  ["a thrown TypeError (offline)", new TypeError("Failed to fetch")],
  ["status 0 (network)", { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" }],
  ["a 500", { code: "unexpected_failure", status: 500, message: "Error sending recovery email" }],
  ["a 502 gateway", { name: "AuthRetryableFetchError", status: 502, message: "{}" }],
  ["a 503", { status: 503, message: "x" }],
  ["a non-JSON answer", { name: "AuthUnknownError", message: "Unexpected token <" }],
  ["a string", "boom"],
] as const) {
  check(`A8: ${label} → "We couldn't send that just now…", never "check your inbox"`, failed(err) === EMAIL_REQUEST_FAILED);
}
check("an address the provider calls invalid is told so (format, not existence)", /doesn't look like an e-mail address/.test(failed({ code: "email_address_invalid", status: 400, message: "x" }) ?? ""));

// Error mapping (TS-11, WU-15, WC-04).
check("C11: an unknown sign-in error gets the generic line, not the raw text", authErrorMessage({ code: "weird", message: "Database error saving new user" }, "signin") === "We couldn't sign you in. Check your e-mail and password, or reset your password.");
check("an unknown sign-up error names support", authErrorMessage({ message: "Something odd" }, "signup").includes(LEGAL.contactEmail));
check("0073: a refused sign-up profile (reserved display name) points at the name", /display name/.test(authErrorMessage({ code: "unexpected_failure", message: "Database error saving new user" }, "signup")) && /reserved for FanFunnel staff/.test(authErrorMessage({ message: "Database error saving new user" }, "signup")));
check("WC-04: 'Error sending confirmation email' gets a next step", /couldn't send the e-mail/i.test(authErrorMessage({ code: "unexpected_failure", message: "Error sending confirmation email" }, "signup")) && authErrorMessage({ message: "Error sending confirmation email" }, "signup").includes(LEGAL.contactEmail));
check("the raw sentence is kept for the error log only", authErrorInfo({ message: "Error sending confirmation email" }, "signup").raw === "Error sending confirmation email");
for (const [code, needle] of [
  ["email_address_invalid", /e-mail address/],
  ["signup_disabled", /closed right now/],
  ["same_password", /current password/],
  ["over_email_send_rate_limit", /Too many e-mails/],
  ["over_request_rate_limit", /Too many attempts/],
  ["insufficient_aal", /two-factor code/],
  ["email_not_confirmed", /resend it below/],
  ["user_banned", /closed/],
  ["invalid_credentials", /don't match/],
] as const) {
  const m = authErrorMessage({ code, message: "RAW PROVIDER TEXT" }, "signin");
  check(`${code} is mapped`, needle.test(m) && !m.includes("RAW PROVIDER TEXT"));
}
check("a rate-limited sign-in with an e-mail message says e-mails", /e-mails/.test(authErrorMessage({ status: 429, message: "Email rate limit exceeded" }, "signin")));
check("a string error is still safe", authErrorMessage("boom", "password") === "Couldn't update your password. Try again, or request a new reset link.");

console.log(`authCopy.test: ${passed} checks passed`);
