import assert from "node:assert";
import { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

// WU-02 / WA-05: GET /auth/confirm renders a landing page whose form POSTs the
// token to /auth/confirm/verify. The page itself never touches Supabase, so a
// mail scanner that fetches the link spends nothing.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let supabaseTouched = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => { supabaseTouched++; return true; },
    createClient: async () => { supabaseTouched++; throw new Error("the landing page must not build a client"); },
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

  check("the landing page never touched Supabase", supabaseTouched === 0);
  console.log(`auth confirm landing page: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
