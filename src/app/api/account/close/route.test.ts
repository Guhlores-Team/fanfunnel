import assert from "node:assert";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";

// AUTH-SENSITIVE: POST /api/account/close permanently deletes the caller's
// account. Unit-tested end to end here instead of e2e (closing the demo
// account would break the run). Negative cases, each of which must delete
// NOTHING: demo mode, signed out, wrong or missing confirm phrase, a two-factor
// user on a password-only (aal1) session, a wrong password, the last admin, a
// body that names someone else's id. Then the success path: only the caller's
// own id is reserved and deleted, every fan link is tombstoned (hash only), an
// activity entry is recorded, the browser is signed out; and a failed delete
// restores an admin's role.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const tok = (aal: string) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;

let configured = true;
let user: { id: string; email: string; factors?: { status: string }[] } | null = { id: ME, email: "me@example.com" };
let aal = "aal1";
let passwordOk = true;
let reserveAnswer = "ok";
let deleteFails = false;
let signedOut = 0;
const rpcCalls: { fn: string; args: unknown }[] = [];
const deletedUsers: string[] = [];
const audits: Record<string, unknown>[] = [];
const storage = new FakeStorage();
storage.add("avatars", `${ME}/current.png`, `${ME}/replaced.png`, `${OTHER}/keep.png`);
storage.add("creator-media", `${ME}/photo.webp`, `${OTHER}/keep.webp`);
const svcTables = new FakeTables({
  profiles: [{ id: ME, role: "creator" }],
  fan_passes: [
    { id: "p1", creator_id: ME, token: "linkAAAA1111" },
    { id: "p2", creator_id: ME, token: "linkBBBB2222" },
    { id: "p3", creator_id: OTHER, token: "otherCCCC333" },
  ],
  link_tombstones: [],
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user } }),
        getSession: async () => ({ data: { session: { access_token: tok(aal) } } }),
        signOut: async () => {
          signedOut++;
          return { error: null };
        },
      },
    }),
    createServiceClient: () => ({
      storage: storage.storage,
      from: (t: string) => svcTables.from(t),
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return { data: reserveAnswer, error: null };
      },
      auth: {
        admin: {
          deleteUser: async (id: string) => {
            if (deleteFails) return { error: { message: "boom" } };
            deletedUsers.push(id);
            return { error: null };
          },
        },
      },
    }),
  },
});
mock.module("@/lib/data", {
  namedExports: {
    recordAudit: async (e: Record<string, unknown>) => {
      audits.push(e);
    },
  },
});
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });
// The password step-up runs on a throwaway supabase-js client; answer its
// token request here instead of the network.
const pwAttempts: unknown[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/auth/v1/token")) throw new Error(`unexpected fetch ${url}`);
  pwAttempts.push(JSON.parse(String(init?.body ?? "{}")));
  return passwordOk
    ? Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "bearer", user: { id: ME, aud: "authenticated", email: "me@example.com" } })
    : Response.json({ error: "invalid_grant", error_description: "Invalid login credentials" }, { status: 400 });
}) as typeof fetch;
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

const nothingDeleted = () => deletedUsers.length === 0 && rpcCalls.length === 0 && svcTables.rows("link_tombstones").length === 0;

async function main() {
  const { POST } = await import("./route");
  const close = (body: unknown) =>
    POST(new Request("http://localhost/api/account/close", { method: "POST", body: JSON.stringify(body) }));
  const GOOD = { currentPassword: "right-pw-1", confirm: "DELETE MY ACCOUNT" };

  configured = false;
  let res = await close(GOOD);
  check("demo mode → 400 demo_mode", res.status === 400 && (await res.json()).error === "demo_mode");
  configured = true;

  user = null;
  res = await close(GOOD);
  check("signed out → 401", res.status === 401);
  user = { id: ME, email: "me@example.com" };

  for (const confirm of [undefined, "", "delete my account", "DELETE MY ACCOUNT NOW", "DELETE"]) {
    res = await close({ ...GOOD, confirm });
    check(`confirm ${JSON.stringify(confirm)} → 400 confirm_mismatch`, res.status === 400 && (await res.json()).error === "confirm_mismatch");
  }
  check("no password was even checked for a bad phrase", pwAttempts.length === 0);

  user = { id: ME, email: "me@example.com", factors: [{ status: "verified" }] };
  aal = "aal1";
  res = await close(GOOD);
  check("2FA user on an aal1 session → 403 mfa_required", res.status === 403 && (await res.json()).error === "mfa_required");
  check("…before the password is tried", pwAttempts.length === 0);
  aal = "aal2";

  passwordOk = false;
  res = await close({ ...GOOD, currentPassword: "wrong" });
  check("wrong password → 403 wrong_password", res.status === 403 && (await res.json()).error === "wrong_password");
  res = await close({ confirm: GOOD.confirm });
  check("missing password → 403 wrong_password", res.status === 403);
  check("the step-up checked the caller's own email", (pwAttempts[0] as { email?: string }).email === "me@example.com");
  passwordOk = true;
  check("nothing deleted after any refusal", nothingDeleted());

  reserveAnswer = "last_admin";
  res = await close(GOOD);
  check("last admin → 409 last_admin", res.status === 409 && (await res.json()).error === "last_admin");
  check("the last admin is not deleted", deletedUsers.length === 0 && svcTables.rows("link_tombstones").length === 0);
  reserveAnswer = "ok";
  rpcCalls.length = 0;

  storage.removeFailures = 3;
  res = await close(GOOD);
  check("storage failure → 500, never false success", res.status === 500 && (await res.json()).error === "storage_cleanup_failed");
  check("storage failure preserves auth/DB retry paths", deletedUsers.length === 0 && svcTables.rows("fan_passes").length === 3);
  check("storage failure records no success audit or signout", audits.length === 0 && signedOut === 0);
  storage.removeFailures = 0;
  rpcCalls.length = 0;

  // A forged id in the body is ignored: only the session's own id is used.
  res = await close({ ...GOOD, id: OTHER, userId: OTHER });
  check("success → 200 ok", res.status === 200 && (await res.json()).ok === true);
  check("no-store", /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("reserved the caller's own id", rpcCalls.length === 1 && rpcCalls[0].fn === "reserve_self_account_deletion" && (rpcCalls[0].args as { p_user: string }).p_user === ME);
  check("deleted the caller's own auth user only", deletedUsers.length === 1 && deletedUsers[0] === ME);
  check("removed current and replaced photos from both buckets", storage.objects.get("avatars")!.size === 1 && storage.objects.get("creator-media")!.size === 1);
  check("other creators' photos survive closure", storage.objects.get("avatars")!.has(`${OTHER}/keep.png`) && storage.objects.get("creator-media")!.has(`${OTHER}/keep.webp`));
  const hashes = svcTables.rows("link_tombstones").map((r) => r.token_hash);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  check("both of the creator's links tombstoned as creator_closed", hashes.length === 2 && hashes.includes(sha("linkAAAA1111")) && hashes.includes(sha("linkBBBB2222")) && svcTables.rows("link_tombstones").every((r) => r.reason === "creator_closed"));
  check("another creator's link is not tombstoned", !hashes.includes(sha("otherCCCC333")));
  check("no raw token stored", !JSON.stringify(svcTables.rows("link_tombstones")).includes("link"));
  check("activity entry: self_close by and for the caller, no email", audits.length === 1 && audits[0].action === "account.self_close" && audits[0].actorId === ME && audits[0].targetId === ME && !JSON.stringify(audits[0]).includes("@"));
  check("the browser session is signed out", signedOut === 1);

  // A failed delete restores an admin's role (the reservation demoted it).
  deletedUsers.length = 0;
  svcTables.rows("profiles")[0].role = "admin";
  svcTables.tables.link_tombstones = [];
  deleteFails = true;
  res = await close(GOOD);
  check("delete failure → 500 delete_failed", res.status === 500 && (await res.json()).error === "delete_failed");
  const restore = svcTables.statements.find((s) => s.table === "profiles" && s.op === "update");
  check("…and the admin role is restored", !!restore && (restore.payload as { role?: string }).role === "admin" && restore.filters.some((f) => f.value === ME));
  check("…and no tombstones are written", svcTables.rows("link_tombstones").length === 0);
  check("…and no activity entry for a close that didn't happen", audits.length === 1);

  console.log(`account close route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
