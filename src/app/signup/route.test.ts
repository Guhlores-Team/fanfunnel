import assert from "node:assert";
import { GET } from "./route";

// WC-08 / WU-18 and the review's INFO item: /signup opens the sign-in page's
// sign-up mode and keeps a `next` that stays on this site; an off-site or
// malformed `next` is dropped, so /signup can never become an open redirect.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
const O = "https://app.example";
const go = (qs: string) => GET(new Request(`${O}/signup${qs}`)).headers.get("location");

check("/signup → sign-up mode", go("") === `${O}/login?mode=signup`);
check("a same-site next is kept", go("?next=/dashboard?section=settings") === `${O}/login?mode=signup&next=%2Fdashboard%3Fsection%3Dsettings`);
check("…and /pending", go("?next=/pending") === `${O}/login?mode=signup&next=%2Fpending`);
for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil", ""]) {
  check(`next=${JSON.stringify(bad)} is dropped`, go(`?next=${encodeURIComponent(bad)}`) === `${O}/login?mode=signup`);
}
check("other parameters are not forwarded", go("?mode=signin&error=auth_link&next=/pending") === `${O}/login?mode=signup&next=%2Fpending`);
console.log(`signup route: ${passed} checks passed`);
