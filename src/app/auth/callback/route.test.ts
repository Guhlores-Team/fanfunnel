import assert from "node:assert";
import { mock } from "node:test";

// The e-mail link handlers (src/lib/auth/authLink.ts), WU-02 / WA-05:
//   GET /auth/callback   legacy PKCE code → session → same-origin `next`;
//                        a token_hash → the landing page, UNSPENT;
//                        the legacy e-mail change's `message` → the half-done page.
//   POST /auth/confirm/verify  the only call to verifyOtp; a failure goes to
//                        /login?error=auth_link&type=…&reason=… so the sign-in
//                        page can word it per link type (WU-03).
// `next` can never leave the origin. A GET never verifies a token_hash: that
// is what keeps mail scanners from consuming the one-time link.
// Review A2: the POST must come from this site's own Continue page
// (Sec-Fetch-Site same-origin, or an Origin that is ours); a cross-site form,
// a foreign Origin or a request with neither header is sent back to the
// Continue page with the token unspent: no client is built, no cookie is set.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Review A3: the app's limiter runs before the provider call, and a failure
// that decided nothing (429, 5xx, network) returns to the Continue page with
// the token unspent; only a refusal of the token reads "used or expired"; a
// blocked account gets its own reason.
let limited = false;
const limiterCalls: { scope: string; tier: string }[] = [];
mock.module("@/lib/api/limit", {
  namedExports: {
    limitRoute: async (_req: Request, scope: string, tier: string) => {
      limiterCalls.push({ scope, tier });
      return limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null;
    },
  },
});
let verifyThrows: unknown = null;
let exchangeOk = true;
let verifyResult: { error: { code?: string; status?: number; name?: string; message: string } | null; session?: object | null } = { error: null, session: { access_token: "t" } };
const verified: { type: string; token_hash: string }[] = [];
let clientsBuilt = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => (clientsBuilt++, {
      auth: {
        exchangeCodeForSession: async () => ({ error: exchangeOk ? null : { message: "bad" } }),
        verifyOtp: async (p: { type: string; token_hash: string }) => {
          verified.push(p);
          if (verifyThrows) throw verifyThrows;
          return { data: { user: verifyResult.session ? { id: "u" } : null, session: verifyResult.session ?? null }, error: verifyResult.error };
        },
      },
    }),
  },
});

const O = "https://app.example";

async function main() {
  const callback = (await import("./route")).GET;
  const verify = (await import("../confirm/verify/route"));
  const go = async (qs: string) => (await callback(new Request(`${O}/auth/callback${qs}`))).headers.get("location");
  // What a browser sends from our own Continue page.
  const OWN_PAGE = { "sec-fetch-site": "same-origin", origin: O };
  const post = async (fields: Record<string, string>, headers: Record<string, string> = OWN_PAGE) => {
    const body = new URLSearchParams(fields);
    const res = await verify.POST(new Request(`${O}/auth/confirm/verify`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", host: "app.example", ...headers } }));
    return { status: res.status, location: res.headers.get("location"), setCookie: res.headers.get("set-cookie") };
  };

  // --- GET /auth/callback -------------------------------------------------
  check("code → next", (await go("?code=c&next=/reset-password")) === `${O}/reset-password`);
  check("code, no next → dashboard", (await go("?code=c")) === `${O}/dashboard`);
  check("absolute next is ignored", (await go("?code=c&next=https://evil.example")) === `${O}/dashboard`);
  check("protocol-relative next is ignored", (await go("?code=c&next=//evil.example/x")) === `${O}/dashboard`);
  check("email-change first step (message, no code) → the half-done page", (await go("?message=Confirmation+link+accepted&next=/dashboard")) === `${O}/auth/email-change`);
  check("nothing → login error (malformed)", (await go("")) === `${O}/login?error=auth_link&reason=malformed`);
  exchangeOk = false;
  check("bad code (other browser) → login error (invalid, typed)", (await go("?code=c&type=recovery")) === `${O}/login?error=auth_link&type=recovery&reason=invalid`);
  exchangeOk = true;

  // A token_hash on GET is never spent: it goes to the landing page as is.
  const before = verified.length;
  check(
    "recovery token_hash on GET → landing page, same fields",
    (await go("?next=/reset-password&token_hash=abcdef123456&type=recovery")) === `${O}/auth/confirm?token_hash=abcdef123456&type=recovery&next=%2Freset-password`,
  );
  check("invite with no next → landing page with the set-password next", (await go("?token_hash=abcdef123456&type=invite")) === `${O}/auth/confirm?token_hash=abcdef123456&type=invite&next=%2Fset-password`);
  check("signup with no next → landing page with /pending", (await go("?token_hash=abcdef123456&type=signup")) === `${O}/auth/confirm?token_hash=abcdef123456&type=signup&next=%2Fpending`);
  check("token_hash with an off-site next stays on the site", (await go("?token_hash=abcdef123456&type=signup&next=https://evil.example/pending")) === `${O}/auth/confirm?token_hash=abcdef123456&type=signup&next=%2Fpending`);
  check("malformed token_hash on GET → login error", (await go("?token_hash=<script>&type=recovery")) === `${O}/login?error=auth_link&type=recovery&reason=malformed`);
  check("unknown type on GET → login error", (await go("?token_hash=abcdef123456&type=admin")) === `${O}/login?error=auth_link&reason=malformed`);
  check("GET never calls verifyOtp", verified.length === before);

  // --- POST /auth/confirm/verify ------------------------------------------
  let r = await post({ token_hash: "abcdef123456", type: "recovery", next: "/reset-password" });
  check("POST recovery → 303 to next", r.status === 303 && r.location === `${O}/reset-password`);
  check("POST spent the token with the right type", verified.at(-1)?.token_hash === "abcdef123456" && verified.at(-1)?.type === "recovery");
  r = await post({ token_hash: "abcdef123456", type: "invite" });
  check("POST invite with no next → set-password", r.location === `${O}/set-password`);
  r = await post({ token_hash: "abcdef123456", type: "signup", next: "https://evil.example/pending" });
  check("POST with an off-site next stays on the site", r.location === `${O}/pending`);
  r = await post({ token_hash: "abcdef123456", type: "recovery", next: "/\\evil.example" });
  check("POST with a backslash next stays on the site", r.location === `${O}/reset-password`);

  // --- A2: only our own Continue page may spend a token --------------------
  const LINK = { token_hash: "abcdef123456", type: "recovery", next: "/reset-password" };
  const BACK = `${O}/auth/confirm?token_hash=abcdef123456&type=recovery&next=%2Freset-password&retry=origin`;
  const refused: [string, Record<string, string>][] = [
    ["a cross-site form (Sec-Fetch-Site: cross-site)", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["Sec-Fetch-Site cross-site with a spoofed matching Origin", { "sec-fetch-site": "cross-site", origin: O }],
    ["a sibling subdomain (Sec-Fetch-Site: same-site)", { "sec-fetch-site": "same-site", origin: "https://evil.app.example" }],
    ["Sec-Fetch-Site: none", { "sec-fetch-site": "none" }],
    ["a foreign Origin with no Sec-Fetch-Site (Origin: https://evil.example)", { origin: "https://evil.example" }],
    ["Origin: null", { origin: "null" }],
    ["no Origin and no Sec-Fetch-Site at all", {}],
    ["no headers, but a session cookie", { cookie: "sb-ref-auth-token=x" }],
    ["a foreign Origin with a session cookie", { origin: "https://evil.example", cookie: "sb-ref-auth-token=x" }],
  ];
  for (const [label, headers] of refused) {
    const calls = verified.length;
    const built = clientsBuilt;
    r = await post(LINK, headers);
    check(`${label} → back to the Continue page, 303`, r.status === 303 && r.location === BACK);
    check(`${label} → verifyOtp never called, no client built`, verified.length === calls && clientsBuilt === built);
    check(`${label} → no cookie set`, r.setCookie === null);
  }
  r = await post({ token_hash: "abcdef123456", type: "invite", next: "https://evil.example/x" }, { origin: "https://evil.example" });
  check("a refused POST keeps next on this site", r.location === `${O}/auth/confirm?token_hash=abcdef123456&type=invite&next=%2Fset-password&retry=origin`);
  r = await post({ token_hash: "<script>", type: "recovery" }, { origin: "https://evil.example" });
  check("a refused POST with a malformed token → the malformed explanation, nothing echoed", r.location === `${O}/login?error=auth_link&type=recovery&reason=malformed`);
  // Same-origin semantics per browser family.
  let before2 = verified.length;
  r = await post(LINK, { "sec-fetch-site": "same-origin" });
  check("Chromium / Firefox / Safari 16.4+ (Sec-Fetch-Site same-origin) → verified", r.location === `${O}/reset-password` && verified.length === before2 + 1);
  before2 = verified.length;
  r = await post(LINK, { origin: O });
  check("older Safari / Firefox (Origin only, ours) → verified", r.location === `${O}/reset-password` && verified.length === before2 + 1);
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.app.example";
  before2 = verified.length;
  r = await post(LINK, { origin: "https://www.app.example" });
  check("the configured site URL's origin → verified", r.location === `${O}/reset-password` && verified.length === before2 + 1);
  delete process.env.NEXT_PUBLIC_SITE_URL;

  const spent = verified.length;
  r = await post({ token_hash: "<script>", type: "recovery" });
  check("POST malformed token_hash → login error (malformed, typed)", r.location === `${O}/login?error=auth_link&type=recovery&reason=malformed`);
  r = await post({ token_hash: "abcdef123456", type: "admin" });
  check("POST unknown type → login error", r.location === `${O}/login?error=auth_link&reason=malformed`);
  r = await post({ token_hash: "", type: "recovery" });
  check("POST empty token_hash → login error", r.location === `${O}/login?error=auth_link&type=recovery&reason=malformed`);
  check("malformed input never reaches Supabase", verified.length === spent);

  verifyResult = { error: { code: "otp_expired", status: 403, message: "Email link is invalid or has expired" } };
  r = await post({ token_hash: "abcdef123456", type: "signup", next: "/pending" });
  check("expired/used token_hash → login error with type and reason", r.location === `${O}/login?error=auth_link&type=signup&reason=expired`);
  verifyResult = { error: { code: "validation_failed", status: 422, message: "nope" } };
  r = await post({ token_hash: "abcdef123456", type: "invite" });
  check("another verify error → reason=invalid", r.location === `${O}/login?error=auth_link&type=invite&reason=invalid`);

  // --- A3: failures that decided nothing never read "used or expired" ------
  const { verifyFailureFor } = await import("@/lib/auth/authLink");
  const mapping: [string, { code?: string; status?: number; name?: string } | null | undefined, string][] = [
    ["otp_expired (a used or expired link)", { code: "otp_expired", status: 403 }, "expired"],
    ["a bare 403 from an older Auth server", { status: 403 }, "expired"],
    ["another refusal of the token (422)", { code: "validation_failed", status: 422 }, "invalid"],
    ["a 400", { status: 400 }, "invalid"],
    ["a blocked account (user_banned, 403)", { code: "user_banned", status: 403 }, "banned"],
    ["429 over_request_rate_limit", { code: "over_request_rate_limit", status: 429 }, "busy"],
    ["a bare 429", { status: 429 }, "busy"],
    ["500 unexpected_failure", { code: "unexpected_failure", status: 500 }, "busy"],
    ["502", { status: 502, name: "AuthRetryableFetchError" }, "busy"],
    ["503", { status: 503 }, "busy"],
    ["504 request_timeout", { code: "request_timeout", status: 504 }, "busy"],
    ["a network failure (status 0)", { status: 0, name: "AuthRetryableFetchError" }, "busy"],
    ["a non-JSON answer (AuthUnknownError)", { name: "AuthUnknownError" }, "busy"],
    ["an error with no status at all", {}, "busy"],
    ["null", null, "busy"],
  ];
  for (const [label, error, want] of mapping) check(`verify failure: ${label} → ${want}`, verifyFailureFor(error) === want);

  const BUSY = `${O}/auth/confirm?token_hash=abcdef123456&type=recovery&next=%2Freset-password&retry=busy`;
  const RECOVERY = { token_hash: "abcdef123456", type: "recovery", next: "/reset-password" };
  for (const [label, error] of [
    ["a provider 429", { code: "over_request_rate_limit", status: 429, message: "Request rate limit reached" }],
    ["a provider 500", { code: "unexpected_failure", status: 500, message: "Internal Server Error" }],
    ["a gateway 503", { status: 503, name: "AuthRetryableFetchError", message: "{}" }],
    ["a network failure", { status: 0, name: "AuthRetryableFetchError", message: "fetch failed" }],
  ] as const) {
    verifyResult = { error };
    r = await post(RECOVERY);
    check(`${label} → back to the Continue page, link intact, never "expired"`, r.status === 303 && r.location === BUSY);
  }
  verifyResult = { error: null, session: { access_token: "t" } };
  verifyThrows = new TypeError("fetch failed");
  r = await post(RECOVERY);
  check("a thrown network error → back to the Continue page too", r.location === BUSY);
  verifyThrows = null;
  verifyResult = { error: { code: "user_banned", status: 403, message: "User is banned" } };
  r = await post(RECOVERY);
  check("a blocked account → its own reason, not 'expired'", r.location === `${O}/login?error=auth_link&type=recovery&reason=banned`);

  // The app's own limiter: before the provider, after the origin check.
  verifyResult = { error: null, session: { access_token: "t" } };
  limiterCalls.length = 0;
  let calls = verified.length;
  r = await post(RECOVERY);
  check("the verify POST is rate-limited per client on the costly tier", limiterCalls.length === 1 && limiterCalls[0].scope === "auth-confirm-verify:POST" && limiterCalls[0].tier === "costly" && verified.length === calls + 1);
  limited = true;
  calls = verified.length;
  let built = clientsBuilt;
  r = await post(RECOVERY);
  check("over the limit → back to the Continue page (still good), Supabase never called", r.status === 303 && r.location === BUSY && verified.length === calls && clientsBuilt === built);
  limited = false;
  limiterCalls.length = 0;
  await post(RECOVERY, { origin: "https://evil.example" });
  check("a cross-site POST does not spend the visitor's limiter budget", limiterCalls.length === 0);

  // WU-04: the secure e-mail change's first link answers with no session.
  verifyResult = { error: null, session: null };
  r = await post({ token_hash: "abcdef123456", type: "email_change", next: "/dashboard" });
  check("email_change with no session → the half-done page, not the dashboard", r.location === `${O}/auth/email-change`);
  verifyResult = { error: null, session: { access_token: "t" } };
  r = await post({ token_hash: "abcdef123456", type: "email_change", next: "/dashboard" });
  check("email_change with a session (second link) → next", r.location === `${O}/dashboard`);

  // A GET on the verify route only shows the landing page again.
  const getVerify = await verify.GET(new Request(`${O}/auth/confirm/verify?token_hash=abcdef123456&type=recovery`));
  const spentBeforeGet = verified.length;
  check("GET /auth/confirm/verify → the landing page, unspent", getVerify.headers.get("location") === `${O}/auth/confirm?token_hash=abcdef123456&type=recovery` && verified.length === spentBeforeGet);

  console.log(`✅ auth callback/confirm: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
