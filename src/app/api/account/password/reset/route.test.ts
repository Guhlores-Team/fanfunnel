import assert from "node:assert";
import { mock } from "node:test";

// WU-06 / WU-07 / WG-16: POST /api/account/password/reset sets the password
// for /reset-password and /set-password.
//   - a session a recovery/invite link opened recently may set it outright;
//   - any other session must give the current password (checked on a
//     throwaway client, never the live cookies) — and a wrong one is refused;
//   - a two-factor account at aal1 gets `mfa_required` before anything else;
//   - the empty body is a probe that sets nothing;
//   - after a change every other session is signed out (scope "others").
// Negative: signed out → 401, no update.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

let user: { id: string; email: string; factors?: { status: string }[] } | null = { id: "u1", email: "me@example.com" };
let claims: Record<string, unknown> = {};
let passwordOk = true;
let updateError: { code?: string; message: string } | null = null;
const updates: unknown[] = [];
const signOuts: unknown[] = [];
const token = () => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const client = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: user ? { access_token: token() } : null }, error: null }),
    updateUser: async (attrs: unknown) => {
      updates.push(attrs);
      return { data: {}, error: updateError };
    },
    signOut: async (opts: unknown) => {
      signOuts.push(opts);
      return { error: null };
    },
  },
};
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the reset route must never use the service role");
    },
  },
});
let verifierCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/auth/v1/token")) throw new Error(`unexpected fetch ${url}`);
  verifierCalls++;
  return passwordOk
    ? Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "bearer", user: { id: "u1", aud: "authenticated", email: "me@example.com" } })
    : Response.json({ error: "invalid_grant", error_description: "Invalid login credentials" }, { status: 400 });
}) as typeof fetch;
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

const now = Math.floor(Date.now() / 1000);
const recent = { amr: [{ method: "recovery", timestamp: now - 120 }], aal: "aal1" };

async function main() {
  const { POST } = await import("./route");
  const call = async (body: unknown) => {
    const res = await POST(new Request("https://app.example/api/account/password/reset", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // Fresh recovery session: probe says ok, then the password is set.
  claims = recent;
  let r = await call({});
  check("probe on a fresh recovery session → ok, requires none", r.status === 200 && r.body.requires === "none" && r.body.byLink === true);
  check("a probe sets nothing", updates.length === 0);
  r = await call({ newPassword: "Str0ngpassword" });
  check("recovery session sets the password", r.status === 200 && updates.length === 1);
  check("…without the current password or the verifier", verifierCalls === 0);
  check("…and signs out every other session (WG-16)", signOuts.length === 1 && (signOuts[0] as { scope?: string }).scope === "others" && r.body.othersSignedOut === true);
  r = await call({ newPassword: "short" });
  check("the shared password rule applies", r.status === 400 && r.body.error === "weak_password");
  r = await call({ newPassword: "no-digits-here" });
  check("…letter and digit", r.status === 400 && r.body.error === "weak_password");

  // Invite sessions count too.
  claims = { amr: [{ method: "invite", timestamp: now - 600 }] };
  r = await call({});
  check("a fresh invite session may set a password", r.status === 200 && r.body.requires === "none");

  // An ordinary signed-in session (WU-06): current password required.
  updates.length = 0;
  claims = { amr: [{ method: "password", timestamp: now - 60 }], aal: "aal1" };
  r = await call({});
  check("probe on a password session → current password required", r.status === 403 && r.body.error === "current_password_required" && r.body.requires === "current_password");
  r = await call({ newPassword: "Str0ngpassword" });
  check("…and a new password alone is refused", r.status === 403 && r.body.error === "current_password_required" && updates.length === 0);
  passwordOk = false;
  r = await call({ newPassword: "Str0ngpassword", currentPassword: "wrong" });
  check("a wrong current password is refused", r.status === 403 && r.body.error === "wrong_password" && updates.length === 0 && verifierCalls === 1);
  passwordOk = true;
  r = await call({ newPassword: "Str0ngpassword", currentPassword: "right" });
  check("the right current password sets it", r.status === 200 && updates.length === 1);

  // A stale recovery session is an ordinary session.
  claims = { amr: [{ method: "recovery", timestamp: now - 3 * 3600 }] };
  r = await call({});
  check("a recovery session older than the limit needs the current password", r.status === 403 && r.body.error === "current_password_required");

  // Two-factor (WU-07): aal1 → challenge first, on the probe already.
  updates.length = 0;
  user = { id: "u1", email: "me@example.com", factors: [{ status: "verified" }] };
  claims = { ...recent, aal: "aal1" };
  r = await call({});
  check("enrolled account at aal1 → mfa_required on the probe", r.status === 403 && r.body.error === "mfa_required" && r.body.step === "challenge");
  r = await call({ newPassword: "Str0ngpassword" });
  check("…and on the update, with nothing written", r.status === 403 && r.body.error === "mfa_required" && updates.length === 0);
  claims = { amr: [{ method: "totp", timestamp: now - 5 }, { method: "recovery", timestamp: now - 120 }], aal: "aal2" };
  r = await call({ newPassword: "Str0ngpassword" });
  check("after the code (aal2) the recovery session sets it", r.status === 200 && updates.length === 1);
  updateError = { code: "insufficient_aal", message: "AAL2 session is required to perform this action" };
  r = await call({ newPassword: "Str0ngpassword" });
  check("a provider insufficient_aal maps to mfa_required, not raw text", r.status === 403 && r.body.error === "mfa_required" && JSON.stringify(r.body).indexOf("AAL2") === -1);
  updateError = { code: "same_password", message: "New password should be different from the old password." };
  r = await call({ newPassword: "Str0ngpassword" });
  check("same_password is a stable code", r.status === 400 && r.body.error === "same_password");
  updateError = null;

  // Signed out.
  user = null;
  r = await call({ newPassword: "Str0ngpassword" });
  check("signed out → 401", r.status === 401);

  console.log(`password reset route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
