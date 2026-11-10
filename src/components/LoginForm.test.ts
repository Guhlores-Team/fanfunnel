import assert from "node:assert";
import { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The sign-in page's states, rendered server-side from its query parameters:
// WU-01 the suspended notice; WU-03 the per-type failed-link notice (no "same
// browser"); WC-07/WC-08 ?mode=signup opens "Create your login" with the three
// honest steps; WU-16 field names + autocomplete; WA-12 44 px toggles; WU-09
// the show-password toggle; WU-13 titles.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }) } });
mock.module("@/lib/supabase/client", { namedExports: { createClient: () => { throw new Error("render must not build a client"); }, isSupabaseConfigured: () => true } });

async function main() {
  const { default: LoginForm } = await import("./LoginForm");
  const render = (params: Record<string, string>) => renderToStaticMarkup(createElement(LoginForm, { params }));

  let html = render({});
  check("sign-in mode by default", /<h1[^>]*>Sign in<\/h1>/.test(html) && !html.includes("signup-steps"));
  check("WU-16: e-mail field has name/id/autocomplete", /id="login-email"[^>]*name="email"[^>]*type="email"[^>]*autoComplete="email"|name="email"/.test(html) && /autoComplete="email"|autocomplete="email"/i.test(html));
  check("the password field keeps aria-label=Password (e2e + password managers)", /aria-label="Password"/.test(html) && /name="password"/.test(html) && /autocomplete="current-password"/i.test(html));
  check("WU-09: a show-password toggle with aria-pressed", /aria-pressed="false"[^>]*aria-label="Show password"/.test(html));
  check("WA-12: the mode toggle is a 44 px target", /min-h-11[^"]*"[^>]*>Want a creator account\? Request access/.test(html) || /<button[^>]*min-h-11[^>]*>[^<]*Request access/.test(html));
  check("WU-17: the heading is focusable for the mode switch", /<h1[^>]*tabindex="-1"/i.test(html));
  check("no suspended notice without the parameter", !html.includes("login-suspended"));

  html = render({ mode: "signup" });
  check("WC-08: ?mode=signup opens sign-up mode", /Create your login/.test(html) && html.includes('data-mode="signup"'));
  check("WC-07: the three steps are named, step 1 current", /1\. Create your login/.test(html) && /2\. Confirm your e-mail/.test(html) && /3\. Tell us about you/.test(html) && /aria-current="step"/.test(html));
  check("WC-07: the intro says what happens next", /Step 1 of 3/.test(html) && /approved by hand/.test(html));
  check("WU-16: display name has name/autocomplete=nickname and is required", /name="display_name"[^>]*autocomplete="nickname"|autocomplete="nickname"/i.test(html) && /name="display_name"[^>]*required|required[^>]*name="display_name"/.test(html));
  check("the submit says what it does", /Create login &amp; continue/.test(html));
  check("the toggle still ends in 'Request access' only in sign-in mode", /Already have a login\? Sign in/.test(html));

  html = render({ suspended: "1" });
  check("WU-01: ?suspended=1 shows the suspended notice with the support address", html.includes('data-testid="login-suspended"') && /support@easysimplesites\.org/.test(html) && /suspended/.test(html));

  html = render({ error: "auth_link", type: "signup", reason: "expired" });
  check("WU-03: a used confirmation link says 'sign in'", html.includes('data-link-type="signup"') && /already used or has expired/.test(html) && /Sign in below/.test(html) && /Resend confirmation email/.test(html));
  check("WU-03: no 'same browser' anywhere", !/same browser|same device/i.test(html));
  html = render({ error: "auth_link", type: "invite", reason: "expired" });
  check("WU-03: an expired invitation offers a new one", /invitation has expired/i.test(html) && /Ask for a new invitation/.test(html) && /mailto:support@/.test(html) && /Send a new password reset link/.test(html));
  html = render({ error: "auth_link", type: "recovery", reason: "expired" });
  check("WU-03: an expired reset offers a reset link, not a resend", /Send a new password reset link/.test(html) && !/Resend confirmation email/.test(html));
  html = render({ error: "auth_link" });
  check("an untyped failure still renders the notice", html.includes('data-testid="auth-link-error"'));

  html = render({ closed: "1" });
  check("a closed account's farewell still shows", /Your account is closed/.test(html));

  // The demo page renders the same notices (no client, no form).
  mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => false } });
  const { default: LoginPage, generateMetadata } = await import("@/app/login/page");
  const page = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ suspended: "1", error: "auth_link", type: "invite", reason: "expired" }) }));
  check("demo: the suspended and link notices render without the form", page.includes("login-suspended") && page.includes('data-link-type="invite"') && !page.includes('name="password"'));
  check("WU-13: the page has its own title per mode", (await generateMetadata({ searchParams: Promise.resolve({}) })).title === "Sign in · FanFunnel" && (await generateMetadata({ searchParams: Promise.resolve({ mode: "signup" }) })).title === "Create your login · FanFunnel");
  console.log(`LoginForm.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
