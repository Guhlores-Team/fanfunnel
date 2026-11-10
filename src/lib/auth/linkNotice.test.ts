import assert from "node:assert";
import { defaultNextFor, sessionNoticeQuery, signedInLinkFailurePath, withQueryFlag } from "./linkNotice";
import { signedInLinkNotice, switchedAccountNotice, alreadySignedInNotice } from "./authCopy";

// Review A4 / A5 / A6: the pure routing rules for a visitor who is already
// signed in when an e-mail link fails or switches the account, and the fixed
// sentences they are shown. The query flags only ever select a sentence.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

// Where a signed-in visitor goes when a link fails.
check("expired recovery → the reset page (its own rule decides)", signedInLinkFailurePath("recovery", "expired") === "/reset-password");
check("invalid recovery → the reset page", signedInLinkFailurePath("recovery", "invalid", "/reset-password") === "/reset-password");
check("expired invite → the set-password page", signedInLinkFailurePath("invite", "expired", "/set-password") === "/set-password");
check("recovery with a crafted next → still the reset page", signedInLinkFailurePath("recovery", "expired", "/dashboard?section=admin") === "/reset-password");
check("recovery with an off-site next → still the reset page", signedInLinkFailurePath("recovery", "expired", "https://evil.example/reset-password") === "/reset-password");
check("invite pointed at the reset page keeps it (both are new-password pages)", signedInLinkFailurePath("invite", "expired", "/reset-password") === "/reset-password");
check("busy recovery → the dashboard notice (the link is still good; nothing to decide yet)", signedInLinkFailurePath("recovery", "busy") === "/dashboard?auth_link=busy&type=recovery");
check("malformed recovery → the dashboard notice", signedInLinkFailurePath("recovery", "malformed") === "/dashboard?auth_link=malformed&type=recovery");
check("banned → the dashboard notice", signedInLinkFailurePath("invite", "banned") === "/dashboard?auth_link=banned&type=invite");
for (const type of ["email_change", "magiclink", "signup", "email"]) {
  check(`expired ${type} → the dashboard notice`, signedInLinkFailurePath(type, "expired", defaultNextFor(type)) === `/dashboard?auth_link=expired&type=${type}`);
}
check("unknown type → a notice with no type", signedInLinkFailurePath("admin", "expired") === "/dashboard?auth_link=expired");
check("unknown reason → 'invalid'", signedInLinkFailurePath("email_change", "<script>") === "/dashboard?auth_link=invalid&type=email_change");
check("nothing known → still a notice, never the sign-in page", signedInLinkFailurePath(null, null) === "/dashboard?auth_link=invalid");
for (const type of ["recovery", "invite", "email_change", "magiclink", "signup", "email", null, "x"]) {
  for (const reason of ["expired", "invalid", "malformed", "banned", "busy", null, "x"]) {
    const to = signedInLinkFailurePath(type, reason, "/login?error=auth_link");
    check(`${type}/${reason}: never /login (no bounce loop for a signed-in visitor)`, !to.startsWith("/login") && /^\/(dashboard|reset-password|set-password)(\?|$)/.test(to));
  }
}

// Only known flags with known values travel between pages.
check("known flags are kept, in a fixed order", sessionNoticeQuery({ type: "recovery", auth_link: "expired", switched: "1" }) === "?switched=1&auth_link=expired&type=recovery");
check("unknown values are dropped", sessionNoticeQuery({ switched: "yes", auth_link: "<script>", type: "recovery" }) === "");
check("a type without a reason is dropped", sessionNoticeQuery({ type: "recovery" }) === "");
check("an unknown type is dropped, the reason kept", sessionNoticeQuery({ auth_link: "busy", type: "admin" }) === "?auth_link=busy");
check("reads URLSearchParams too, ignoring everything else", sessionNoticeQuery(new URLSearchParams("next=/x&auth_link=expired&type=email_change&error=auth_link&email=a@b.c")) === "?auth_link=expired&type=email_change");
check("nothing → empty", sessionNoticeQuery({}) === "");

// Adding the switched flag to a landing path.
check("flag on a bare path", withQueryFlag("/reset-password", "switched", "1") === "/reset-password?switched=1");
check("flag added to an existing query", withQueryFlag("/dashboard?section=settings", "switched", "1") === "/dashboard?section=settings&switched=1");
check("flag before a fragment", withQueryFlag("/dashboard?section=a#top", "switched", "1") === "/dashboard?section=a&switched=1#top");
check("an existing flag is not doubled", withQueryFlag("/pending?switched=1", "switched", "1") === "/pending?switched=1");
check("an off-site path becomes the dashboard", withQueryFlag("https://evil.example/x", "switched", "1") === "/dashboard?switched=1" && withQueryFlag("//evil.example", "switched", "1") === "/dashboard?switched=1");

// The sentences.
const sw = switchedAccountNotice("bob@example.com");
check("A4: 'You're now signed in as <e-mail>'", sw.title === "You're now signed in as bob@example.com" && /signed out of this browser/.test(sw.body));
check("A4: the Continue page's sentence", alreadySignedInNotice("alice@example.com") === "You're signed in as alice@example.com. Continuing will switch this browser to the account this link belongs to.");
check("A6: an expired e-mail change says nothing was changed and where to look", /e-mail change link was already used or has expired/.test(signedInLinkNotice("email_change", "expired").title) && /Nothing was changed/.test(signedInLinkNotice("email_change", "expired").body) && /Settings › Account/.test(signedInLinkNotice("email_change", "expired").body));
for (const type of ["recovery", "invite", "email_change", "magiclink", "signup", "email", null]) {
  const busy = signedInLinkNotice(type, "busy");
  check(`${type}/busy: still good, a few minutes, never used/expired`, /still good/.test(busy.body) && /few minutes/.test(busy.body) && !/used|expired/i.test(busy.title + busy.body));
  for (const reason of ["expired", "invalid", "malformed", "banned", "busy"]) {
    const n = signedInLinkNotice(type, reason);
    check(`${type}/${reason}: says nothing was changed, never tells a signed-in visitor to sign in`, /[Nn]othing was changed|wasn't changed/.test(n.body) && !/sign in below|same (browser|device)/i.test(n.title + n.body));
  }
}

console.log(`linkNotice.test: ${passed} checks passed`);
