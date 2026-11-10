import assert from "node:assert";
import { amrFromAccessToken, LINK_SESSION_MAX_AGE_MS, openedByRecentLink } from "./assurance";

// WU-06: only a session an e-mail link opened recently (amr "recovery" or
// "invite", a claim the Auth server signs) may set a password without the
// current one. The claim is read like `aal`: from a token getUser() accepted.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
const token = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const now = 1_800_000_000_000;
const sec = (msAgo: number) => Math.floor((now - msAgo) / 1000);

check("no token → no methods", amrFromAccessToken(null).length === 0 && amrFromAccessToken("garbage").length === 0);
check("the amr claim is read", amrFromAccessToken(token({ amr: [{ method: "recovery", timestamp: 5 }] }))[0]?.method === "recovery");
check("junk entries are dropped", amrFromAccessToken(token({ amr: [null, "x", { timestamp: 1 }, { method: "otp" }] })).length === 1);
check("a fresh recovery session may set a password", openedByRecentLink(token({ aal: "aal1", amr: [{ method: "recovery", timestamp: sec(60_000) }] }), now));
check("a fresh invite session may too", openedByRecentLink(token({ amr: [{ method: "invite", timestamp: sec(60_000) }] }), now));
check("after a two-factor code the recovery method is still there", openedByRecentLink(token({ aal: "aal2", amr: [{ method: "totp", timestamp: sec(1_000) }, { method: "recovery", timestamp: sec(90_000) }] }), now));
check("an ordinary password sign-in may NOT", !openedByRecentLink(token({ aal: "aal1", amr: [{ method: "password", timestamp: sec(60_000) }] }), now));
check("a stale recovery session may NOT", !openedByRecentLink(token({ amr: [{ method: "recovery", timestamp: sec(LINK_SESSION_MAX_AGE_MS + 1_000) }] }), now));
check("a recovery entry without a timestamp may NOT", !openedByRecentLink(token({ amr: [{ method: "recovery" }] }), now));
check("no amr claim at all may NOT (fails closed)", !openedByRecentLink(token({ aal: "aal1" }), now) && !openedByRecentLink(undefined, now));
console.log(`linkSession.test: ${passed} checks passed`);
