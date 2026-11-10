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

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let exchangeOk = true;
let verifyResult: { error: { code?: string; status?: number; message: string } | null; session?: object | null } = { error: null, session: { access_token: "t" } };
const verified: { type: string; token_hash: string }[] = [];
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        exchangeCodeForSession: async () => ({ error: exchangeOk ? null : { message: "bad" } }),
        verifyOtp: async (p: { type: string; token_hash: string }) => {
          verified.push(p);
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
  const post = async (fields: Record<string, string>) => {
    const body = new URLSearchParams(fields);
    const res = await verify.POST(new Request(`${O}/auth/confirm/verify`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));
    return { status: res.status, location: res.headers.get("location") };
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

  // WU-04: the secure e-mail change's first link answers with no session.
  verifyResult = { error: null, session: null };
  r = await post({ token_hash: "abcdef123456", type: "email_change", next: "/dashboard" });
  check("email_change with no session → the half-done page, not the dashboard", r.location === `${O}/auth/email-change`);
  verifyResult = { error: null, session: { access_token: "t" } };
  r = await post({ token_hash: "abcdef123456", type: "email_change", next: "/dashboard" });
  check("email_change with a session (second link) → next", r.location === `${O}/dashboard`);

  // A GET on the verify route only shows the landing page again.
  const getVerify = await verify.GET(new Request(`${O}/auth/confirm/verify?token_hash=abcdef123456&type=recovery`));
  check("GET /auth/confirm/verify → the landing page, unspent", getVerify.headers.get("location") === `${O}/auth/confirm?token_hash=abcdef123456&type=recovery` && verified.length === spent + 4);

  console.log(`✅ auth callback/confirm: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
