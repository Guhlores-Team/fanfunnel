import assert from "node:assert";
import { mock } from "node:test";

// /auth/callback: PKCE code → session → same-origin `next`; the secure email
// change's first link (message, no code) → `next`; anything else → login error.
// `next` can never leave the origin.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let exchangeOk = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { exchangeCodeForSession: async () => ({ error: exchangeOk ? null : { message: "bad" } }) },
    }),
  },
});

async function main() {
  const { GET } = await import("./route");
  const O = "https://app.example";
  const go = async (qs: string) => (await GET(new Request(`${O}/auth/callback${qs}`))).headers.get("location");

  check("code → next", (await go("?code=c&next=/reset-password")) === `${O}/reset-password`);
  check("code, no next → dashboard", (await go("?code=c")) === `${O}/dashboard`);
  check("absolute next is ignored", (await go("?code=c&next=https://evil.example")) === `${O}/dashboard`);
  check(
    "email-change first step (message, no code) → next",
    (await go("?message=Confirmation+link+accepted&next=/dashboard")) === `${O}/dashboard`,
  );
  check("nothing → login error", (await go("")) === `${O}/login?error=auth_link`);
  exchangeOk = false;
  check("bad code → login error", (await go("?code=c")) === `${O}/login?error=auth_link`);

  console.log(`✅ auth callback: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
