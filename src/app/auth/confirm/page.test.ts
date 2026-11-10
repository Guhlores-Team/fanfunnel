import assert from "node:assert";
import { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

// WU-02 / WA-05: GET /auth/confirm renders a landing page whose form POSTs the
// token to /auth/confirm/verify. A mail scanner that fetches the link spends
// nothing and (having no session cookie) causes no Supabase call at all.
// Review A4: with a session cookie the page asks the Auth server who is signed
// in (getUser only, never verifyOtp) and says that continuing switches
// accounts. Review A5: the button is a client component that disables itself
// after the first submit; the markup is still a plain form with a submit
// button, so it works without JavaScript.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let clientsBuilt = 0;
let getUserCalls = 0;
let verifyCalls = 0;
let sessionUser: { email: string } | null = null;
let getUserHangs = false;
let jar: { name: string; value: string }[] = [];
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ getAll: () => jar }),
    headers: async () => new Headers(),
  },
});
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => {
      clientsBuilt++;
      return {
        auth: {
          getUser: async () => {
            getUserCalls++;
            if (getUserHangs) await new Promise(() => {});
            return { data: { user: sessionUser }, error: null };
          },
          verifyOtp: async () => {
            verifyCalls++;
            throw new Error("the landing page must never verify");
          },
        },
      };
    },
  },
});

async function render(params: Record<string, string>): Promise<{ html?: string; redirect?: string }> {
  const { default: Page } = await import("./page");
  try {
    const el = await Page({ searchParams: Promise.resolve(params) });
    return { html: renderToStaticMarkup(el) };
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] };
    throw e;
  }
}

async function main() {
  let out = await render({ token_hash: "abcdef123456", type: "recovery", next: "/reset-password" });
  check("recovery: a form that POSTs to the verify route", out.html?.includes('method="post"') && out.html?.includes('action="/auth/confirm/verify"'));
  check("…carrying the token, type and next as hidden fields", /name="token_hash" value="abcdef123456"/.test(out.html ?? "") && /name="type" value="recovery"/.test(out.html ?? "") && /name="next" value="\/reset-password"/.test(out.html ?? ""));
  check("…with a Continue button and the recovery wording", /Continue to reset my password/.test(out.html ?? ""));
  check("…and says nothing happens until the tap (scanner-safe)", /Nothing happens until you tap the button/.test(out.html ?? ""));
  check("…and no script auto-submits it", !/<script/.test(out.html ?? ""));
  check("A5: the button is a real submit button inside the form (works without JavaScript)", /<form[^>]*method="post"[^>]*>[\s\S]*<button[^>]*type="submit"[^>]*data-testid="auth-continue-button"[\s\S]*<\/form>/.test(out.html ?? ""));
  check("A5: it starts enabled, with a quiet status region for the progress text", !/<button[^>]*\sdisabled=/.test(out.html ?? "") && /role="status"/.test(out.html ?? ""));
  check("no session cookie → no notice, and Supabase is never called", !/auth-continue-signed-in/.test(out.html ?? "") && clientsBuilt === 0 && getUserCalls === 0);

  // A4: someone is already signed in on this browser.
  jar = [{ name: "sb-ref-auth-token.0", value: "base64-x" }];
  sessionUser = { email: "creator@example.com" };
  out = await render({ token_hash: "abcdef123456", type: "recovery", next: "/reset-password", email: "attacker@evil.example" });
  check("A4: signed in → says who, and that continuing switches accounts", /data-testid="auth-continue-signed-in"/.test(out.html ?? "") && /You(&#x27;|')re signed in as creator@example\.com\. Continuing will switch this browser to the account this link belongs to\./.test(out.html ?? ""));
  check("A4: the name comes from the Auth server (one getUser), never from the URL", getUserCalls === 1 && !(out.html ?? "").includes("attacker@evil.example"));
  sessionUser = null;
  out = await render({ token_hash: "abcdef123456", type: "recovery" });
  check("a stale cookie with no session → no notice", !/auth-continue-signed-in/.test(out.html ?? ""));
  getUserHangs = true;
  const started = Date.now();
  out = await render({ token_hash: "abcdef123456", type: "recovery" });
  check("a hanging Auth server does not hold the page (bounded), notice left out", Date.now() - started < 4000 && !/auth-continue-signed-in/.test(out.html ?? "") && /Continue to reset my password/.test(out.html ?? ""));
  getUserHangs = false;
  jar = [{ name: "theme", value: "dark" }, { name: "sb-ref-auth-token-code-verifier", value: "v" }];
  const builtBefore = clientsBuilt;
  out = await render({ token_hash: "abcdef123456", type: "recovery" });
  check("other cookies (theme, a PKCE verifier) are not a session", clientsBuilt === builtBefore);
  jar = [];

  // A2 / A3: the verify route sent the request back here, token unspent.
  out = await render({ token_hash: "abcdef123456", type: "recovery", next: "/reset-password", retry: "origin" });
  check("retry=origin: a fixed sentence above the same form", /data-testid="auth-continue-notice"/.test(out.html ?? "") && /only accept this step from this page/.test(out.html ?? "") && /name="token_hash" value="abcdef123456"/.test(out.html ?? ""));
  out = await render({ token_hash: "abcdef123456", type: "recovery", retry: "busy" });
  check("retry=busy: the link is still good, try again in a few minutes; never 'used' or 'expired'", /still good/.test(out.html ?? "") && /few minutes/.test(out.html ?? "") && !/already used|has expired/.test(out.html ?? ""));
  out = await render({ token_hash: "abcdef123456", type: "recovery", retry: "<b>x</b>" });
  check("an unknown retry flag shows nothing (never echoed)", !/auth-continue-notice/.test(out.html ?? "") && !(out.html ?? "").includes("<b>x</b>"));

  out = await render({ token_hash: "abcdef123456", type: "invite" });
  check("invite: default next is /set-password", /name="next" value="\/set-password"/.test(out.html ?? "") && /Accept your invitation/.test(out.html ?? ""));
  out = await render({ token_hash: "abcdef123456", type: "email_change", next: "https://evil.example/x" });
  check("an off-site next is replaced by the type's default", /name="next" value="\/dashboard"/.test(out.html ?? ""));
  out = await render({ token_hash: "abcdef123456", type: "email", next: "/pending" });
  check("confirmation: the e-mail wording", /Confirm your e-mail/.test(out.html ?? ""));

  out = await render({ token_hash: "<script>", type: "recovery" });
  check("malformed token → the sign-in page's typed explanation", out.redirect === "/login?error=auth_link&type=recovery&reason=malformed");
  out = await render({ token_hash: "abcdef123456", type: "admin" });
  check("unknown type → the sign-in page", out.redirect === "/login?error=auth_link&reason=malformed");
  out = await render({});
  check("no params → the sign-in page", out.redirect === "/login?error=auth_link&reason=malformed");
  out = await render({ code: "pkce-code", next: "/reset-password" });
  check("a legacy ?code= pointed here → the callback route (same browser)", out.redirect === "/auth/callback?code=pkce-code&next=%2Freset-password");

  // INFO: Supabase's own error redirect of a legacy link.
  out = await render({ error: "access_denied", error_code: "otp_expired", error_description: "Email link is invalid or has expired", type: "recovery" });
  check("a legacy ?error=…&error_code=otp_expired → the expired copy, not 'incomplete'", out.redirect === "/login?error=auth_link&type=recovery&reason=expired");

  check("the landing page never verified anything", verifyCalls === 0);
  console.log(`auth confirm landing page: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
