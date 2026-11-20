import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE: /api/account/email starts a Supabase email change. The
// confirmation links must come back to THIS deployment's /auth/callback, not
// the project's Site URL (on the test project that is localhost:3000, so a
// Preview's confirm link landed on a dead page). Negative cases: signed-out →
// 401 with no update; wrong current password → 403 with no update.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let user: { id: string; email: string } | null = { id: "u1", email: "old@example.com" };
let passwordOk = true;
const updates: { attrs: unknown; opts: unknown }[] = [];

const client = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    updateUser: async (attrs: unknown, opts?: unknown) => {
      updates.push({ attrs, opts });
      return { data: {}, error: null };
    },
  },
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the email route must never use the service role");
    },
  },
});
// The step-up password check runs on a throwaway supabase-js client; answer its
// token request here instead of reaching the network.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/auth/v1/token")) throw new Error(`unexpected fetch ${url}`);
  return passwordOk
    ? Response.json({
        access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "bearer",
        user: { id: "u1", aud: "authenticated", email: "old@example.com" },
      })
    : Response.json({ error: "invalid_grant", error_description: "Invalid login credentials" }, { status: 400 });
}) as typeof fetch;
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

async function main() {
  const { POST } = await import("./route");

  const ORIGIN = "https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app";
  const req = (body: unknown) =>
    new Request(`${ORIGIN}/api/account/email`, { method: "POST", body: JSON.stringify(body) });

  // Happy path: the confirm link returns to this deployment's callback.
  let res = await POST(req({ email: "new@example.com", currentPassword: "pw" }));
  check("change accepted", res.status === 200);
  check("one update", updates.length === 1);
  const opts = updates[0].opts as { emailRedirectTo?: string } | undefined;
  check(
    "confirm link returns to this origin's /auth/callback",
    opts?.emailRedirectTo === `${ORIGIN}/auth/callback?next=/dashboard`,
  );

  // Negative: signed out.
  updates.length = 0;
  user = null;
  res = await POST(req({ email: "new@example.com", currentPassword: "pw" }));
  check("signed out → 401", res.status === 401);
  check("signed out → no update", updates.length === 0);

  // Negative: wrong current password.
  user = { id: "u1", email: "old@example.com" };
  passwordOk = false;
  res = await POST(req({ email: "new@example.com", currentPassword: "nope" }));
  check("wrong password → 403", res.status === 403);
  check("wrong password → no update", updates.length === 0);

  console.log(`✅ account email route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
