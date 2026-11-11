import assert from "node:assert";
import { amrFromAccessToken, LINK_SESSION_MAX_AGE_MS, LINK_SESSION_METHODS, openedByRecentLink } from "./assurance";

// WU-06 / review A1: only a session an e-mail link or e-mail code opened
// recently may set a password without the current one. Supabase Auth records
// `otp` for every verifyOtp (the token_hash links of the current templates)
// and `recovery` / `invite` / `magiclink` for the legacy PKCE exchange, so all
// four count; `password`, `totp` and everything else never do. The claim is
// read like `aal`: from a token getUser() accepted. Synthetic claims here; the
// hosted Auth server is held to the list by
// scripts/security/link-session-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
const token = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const now = 1_800_000_000_000;
const sec = (msAgo: number) => Math.floor((now - msAgo) / 1000);
const MIN = 60_000;

check("the window is one hour", LINK_SESSION_MAX_AGE_MS === 60 * MIN);
check("exactly four methods count", [...LINK_SESSION_METHODS].sort().join() === "invite,magiclink,otp,recovery");

check("no token → no methods", amrFromAccessToken(null).length === 0 && amrFromAccessToken("garbage").length === 0);
check("the amr claim is read", amrFromAccessToken(token({ amr: [{ method: "otp", timestamp: 5 }] }))[0]?.method === "otp");
check("junk entries are dropped", amrFromAccessToken(token({ amr: [null, "x", { timestamp: 1 }, { method: "otp" }] })).length === 1);

// The four accepted methods.
for (const method of ["otp", "recovery", "invite", "magiclink"]) {
  check(`a fresh ${method} session may set a password`, openedByRecentLink(token({ aal: "aal1", amr: [{ method, timestamp: sec(MIN) }] }), now));
  check(`a ${method} session at the edge of the hour still may`, openedByRecentLink(token({ amr: [{ method, timestamp: sec(LINK_SESSION_MAX_AGE_MS - 2_000) }] }), now));
  check(`a ${method} session older than the hour may NOT`, !openedByRecentLink(token({ amr: [{ method, timestamp: sec(LINK_SESSION_MAX_AGE_MS + 2_000) }] }), now));
  check(`a ${method} entry with a zero timestamp may NOT`, !openedByRecentLink(token({ amr: [{ method, timestamp: 0 }] }), now));
  check(`a ${method} entry with no timestamp may NOT`, !openedByRecentLink(token({ amr: [{ method }] }), now));
  check(`a ${method} entry with a negative timestamp may NOT`, !openedByRecentLink(token({ amr: [{ method, timestamp: -5 }] }), now));
}
check("90 minutes (inside the old 2 h window) is now too old", !openedByRecentLink(token({ amr: [{ method: "otp", timestamp: sec(90 * MIN) }] }), now));
check("after a two-factor code the link method is still there", openedByRecentLink(token({ aal: "aal2", amr: [{ method: "totp", timestamp: sec(1_000) }, { method: "otp", timestamp: sec(20 * MIN) }] }), now));

// Methods that never count.
check("an ordinary password sign-in may NOT", !openedByRecentLink(token({ aal: "aal1", amr: [{ method: "password", timestamp: sec(MIN) }] }), now));
check("a password sign-in plus a two-factor code may NOT", !openedByRecentLink(token({ aal: "aal2", amr: [{ method: "totp", timestamp: sec(1_000) }, { method: "password", timestamp: sec(MIN) }] }), now));
check("a two-factor code alone may NOT", !openedByRecentLink(token({ aal: "aal2", amr: [{ method: "totp", timestamp: sec(1_000) }] }), now));
for (const method of ["mfa/totp", "mfa/phone", "mfa/webauthn", "oauth", "sso/saml", "anonymous", "token_refresh", "email/signup", "email_change", "web3", "OTP", " otp", "otp ", "recovery2", ""]) {
  check(`amr method ${JSON.stringify(method)} may NOT`, !openedByRecentLink(token({ amr: [{ method, timestamp: sec(MIN) }] }), now));
}
check("a stale link entry next to a fresh password entry may NOT", !openedByRecentLink(token({ amr: [{ method: "password", timestamp: sec(MIN) }, { method: "otp", timestamp: sec(3 * 60 * MIN) }] }), now));

// Malformed amr: fails closed.
check("no amr claim at all may NOT", !openedByRecentLink(token({ aal: "aal1" }), now) && !openedByRecentLink(undefined, now) && !openedByRecentLink("", now));
check("amr as bare strings (RFC 8176 form, no time) may NOT", !openedByRecentLink(token({ amr: ["otp", "recovery"] }), now));
check("amr as an object may NOT", !openedByRecentLink(token({ amr: { method: "otp", timestamp: sec(MIN) } }), now));
check("amr as a string may NOT", !openedByRecentLink(token({ amr: "otp" }), now));
check("a string timestamp may NOT", !openedByRecentLink(token({ amr: [{ method: "otp", timestamp: String(sec(MIN)) }] }), now));
check("a NaN / null timestamp may NOT", !openedByRecentLink(token({ amr: [{ method: "otp", timestamp: null }] }), now));
check("a non-string method may NOT", !openedByRecentLink(token({ amr: [{ method: ["otp"], timestamp: sec(MIN) }, { method: 7, timestamp: sec(MIN) }] }), now));
check("a token that is not a JWT may NOT", !openedByRecentLink("not-a-jwt", now) && !openedByRecentLink("a.b.c", now) && !openedByRecentLink(`h.${Buffer.from("[]").toString("base64url")}.s`, now));
console.log(`linkSession.test: ${passed} checks passed`);
