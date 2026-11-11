import assert from "node:assert/strict";
import { isOwnPagePost } from "./sameOrigin";

// Review A2: POST /auth/confirm/verify creates a session, so it must come from
// this site's own Continue page whether or not the request carries a cookie
// (login CSRF needs none). isOwnPagePost is the strict rule: Sec-Fetch-Site
// same-origin, or (header absent) an Origin that is ours; neither header is
// refused. Browser semantics covered: Chromium / Firefox ≥ 90 / Safari ≥ 16.4
// send Sec-Fetch-Site; older Safari and Firefox 70–89 send only Origin on a
// form POST; a cross-site form always sends its own Origin.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const URL_ = "https://fanfunnel.app/auth/confirm/verify";
const own = (headers: Record<string, string>, extra: Partial<Parameters<typeof isOwnPagePost>[0]> = {}) =>
  isOwnPagePost({ headers: new Headers({ host: "fanfunnel.app", ...headers }), requestUrl: URL_, ...extra });

// Our own page.
check("Chromium / Firefox / Safari 16.4+: Sec-Fetch-Site same-origin passes", own({ "sec-fetch-site": "same-origin", origin: "https://fanfunnel.app" }));
check("Sec-Fetch-Site same-origin passes without an Origin", own({ "sec-fetch-site": "same-origin" }));
check("Sec-Fetch-Site is case- and space-tolerant", own({ "sec-fetch-site": " Same-Origin " }));
check("older Safari: no Sec-Fetch-Site, Origin = the request's own origin passes", own({ origin: "https://fanfunnel.app" }));
check("localhost over http: Origin = the request's own origin passes", isOwnPagePost({ headers: new Headers({ host: "localhost:3508", origin: "http://localhost:3508" }), requestUrl: "http://localhost:3508/auth/confirm/verify" }));
check("the configured site URL passes", own({ origin: "https://www.fanfunnel.app" }, { allowedOrigins: ["https://www.fanfunnel.app/"] }));
check("behind a TLS-terminating proxy (request URL reads http, internal host): https + Host passes", isOwnPagePost({ headers: new Headers({ host: "fanfunnel.app", origin: "https://fanfunnel.app" }), requestUrl: "http://10.0.0.5:3000/auth/confirm/verify" }));
check("a Vercel Preview on its own host passes", isOwnPagePost({ headers: new Headers({ host: "ff-git-x-team.vercel.app", origin: "https://ff-git-x-team.vercel.app" }), requestUrl: "https://ff-git-x-team.vercel.app/auth/confirm/verify", allowedOrigins: ["https://fanfunnel.app"] }));
check("origin comparison ignores case", own({ origin: "https://FanFunnel.App" }));
const VERCEL_SET = { "x-vercel-id": "fra1::abc", "x-vercel-deployment-url": "ff.vercel.app" };
check("x-forwarded-host counts only on Vercel with Vercel's header set", isOwnPagePost({ headers: new Headers({ host: "internal:3000", "x-forwarded-host": "fanfunnel.app", origin: "https://fanfunnel.app", ...VERCEL_SET }), requestUrl: "http://internal:3000/auth/confirm/verify", onVercel: true }));

// Not our page: refused, with or without cookies.
check("a cross-site form (Sec-Fetch-Site cross-site) is refused", !own({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }));
check("…even with a spoofed matching Origin", !own({ "sec-fetch-site": "cross-site", origin: "https://fanfunnel.app" }));
check("…and with a session cookie present", !own({ "sec-fetch-site": "cross-site", cookie: "sb-ref-auth-token=x" }));
check("a sibling subdomain (same-site) is refused", !own({ "sec-fetch-site": "same-site", origin: "https://evil.fanfunnel.app" }));
check("Sec-Fetch-Site none is refused for a POST", !own({ "sec-fetch-site": "none" }));
check("an empty Sec-Fetch-Site is refused", !own({ "sec-fetch-site": "", origin: "https://fanfunnel.app" }));
check("an unknown Sec-Fetch-Site value is refused", !own({ "sec-fetch-site": "same-origin, cross-site" }));
check("a foreign Origin is refused", !own({ origin: "https://evil.example" }));
check("a foreign Origin is refused with no cookie at all (login CSRF)", !isOwnPagePost({ headers: new Headers({ host: "fanfunnel.app", origin: "https://evil.example" }), requestUrl: URL_ }));
check("neither header is refused (no 'not a browser' pass)", !own({}));
check("neither header is refused even with a cookie", !own({ cookie: "sb-ref-auth-token=x" }));
check("Origin null is refused", !own({ origin: "null" }));
check("a malformed Origin is refused", !own({ origin: "not a url" }));
check("a non-http Origin is refused", !own({ origin: "file://" }));
check("another port is another origin", !isOwnPagePost({ headers: new Headers({ host: "localhost:3508", origin: "http://localhost:4000" }), requestUrl: "http://localhost:3508/auth/confirm/verify" }));
check("another Vercel deployment is refused", !isOwnPagePost({ headers: new Headers({ host: "ff-git-x-team.vercel.app", origin: "https://attacker.vercel.app" }), requestUrl: "https://ff-git-x-team.vercel.app/auth/confirm/verify" }));
check("the http:// twin of an https host is refused (only https + Host counts)", !own({ origin: "http://fanfunnel.app" }));
check("x-forwarded-host off Vercel is client input", !isOwnPagePost({ headers: new Headers({ host: "fanfunnel.app", "x-forwarded-host": "evil.example", origin: "https://evil.example", ...VERCEL_SET }), requestUrl: URL_ }));
check("x-forwarded-host on Vercel without Vercel's header set is client input", !isOwnPagePost({ headers: new Headers({ host: "fanfunnel.app", "x-forwarded-host": "evil.example", origin: "https://evil.example" }), requestUrl: URL_, onVercel: true }));
check("an undefined configured site URL allows nothing extra", !own({ origin: "https://evil.example" }, { allowedOrigins: [undefined, ""] }));

console.log(`ownPagePost: ${passed} checks passed`);
