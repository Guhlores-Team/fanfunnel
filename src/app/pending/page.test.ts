import assert from "node:assert";
import { mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// T7: /pending offers "Delete my request and account" to an applicant whose
// request is pending or declined, and to nobody else. An approved creator (or
// an admin) is redirected to the dashboard and never gets the shortcut; a
// signed-out visitor is sent to login; demo mode has no gate at all.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

let configured = true;
let user: { id: string; email: string } | null = { id: "u1", email: "applicant@example.com" };
let status = "pending";
// b6 C9 / WC-07: the sign-up name (profiles.display_name) pre-fills the request.
let displayName: string | null = "Sunny";
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: displayName } }) }) }) }),
    }),
    createServiceClient: () => { throw new Error("/pending must not use the service role"); },
  },
});
mock.module("@/lib/data", {
  namedExports: {
    getMyApprovalStatus: async () => status,
    // The stored request and the admin's reason (C21/C7) are not under test here.
    getMyCreatorApplication: async () => null,
    getMyRejectionReason: async () => null,
  },
});

const CONTROL = "Delete my request and account";

async function render(): Promise<{ html?: string; redirect?: string }> {
  const { default: PendingPage } = await import("./page");
  try {
    const el = await PendingPage();
    return { html: renderToStaticMarkup(el ?? createElement("div")) };
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] };
    throw e;
  }
}

async function main() {
  const { pendingSelfDeleteAllowed } = await import("@/lib/account/pendingSelfDelete");
  check("pending may self-delete", pendingSelfDeleteAllowed("pending"));
  check("rejected may self-delete", pendingSelfDeleteAllowed("rejected"));
  check("approved may NOT use the shortcut", !pendingSelfDeleteAllowed("approved"));
  check("no profile row may NOT", !pendingSelfDeleteAllowed("none") && !pendingSelfDeleteAllowed(undefined) && !pendingSelfDeleteAllowed("admin"));

  status = "pending";
  let out = await render();
  check("pending applicant: the control is offered", out.html?.includes(CONTROL));
  check("the sign-up name pre-fills the request (b6 C9)", /value="Sunny"/.test(out.html ?? ""));
  check("…and the page says it is step 3 of 3 (WC-07)", /Step 3 of 3/.test(out.html ?? ""));
  displayName = "applicant@example.com";
  out = await render();
  check("an e-mail-shaped legacy name is treated as blank", !/value="applicant@example.com"/.test(out.html ?? ""));
  displayName = "Sunny";
  check("…and it goes through the existing close confirmations", out.html?.includes("DELETE MY ACCOUNT") && out.html?.includes("Current password"));

  status = "rejected";
  out = await render();
  check("rejected applicant: the control is offered", out.html?.includes(CONTROL) && out.html?.includes("declined request"));

  status = "approved";
  out = await render();
  check("approved creator: redirected to the dashboard, no shortcut", out.redirect === "/dashboard" && !out.html);

  status = "none";
  out = await render();
  check("no profile row: the page renders without the control", out.html !== undefined && !out.html.includes(CONTROL));

  user = null;
  status = "pending";
  out = await render();
  check("signed out: sent to login", out.redirect === "/login?next=/pending");

  configured = false;
  user = { id: "u1", email: "applicant@example.com" };
  out = await render();
  check("demo mode: no gate, straight to the dashboard", out.redirect === "/dashboard");

  console.log(`pending page.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
