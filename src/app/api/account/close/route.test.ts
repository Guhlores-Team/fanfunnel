import assert from "node:assert";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { FakeStorageWork } from "@/lib/storage/fakeWork";

// AUTH-SENSITIVE: POST /api/account/close permanently deletes the caller's
// account. Unit-tested end to end here instead of e2e (closing the demo
// account would break the run). Negative cases, each of which must delete
// NOTHING: demo mode, signed out, wrong or missing confirm phrase, a two-factor
// user on a password-only (aal1) session, a wrong password, the last admin, a
// body that names someone else's id, a creator who still owes fans prizes
// (T4), a suspended account (refused up front), and (S1) any refused close of
// an agency owner, which must leave no "agency dissolved" notice and no
// org.dissolve entry. Then the success path: only the caller's
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
const ORG = "33333333-3333-4333-8333-333333333333";
const SEAT = "44444444-4444-4444-8444-444444444444";
const MANAGED = "55555555-5555-4555-8555-555555555555";
const tok = (aal: string) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;

let configured = true;
let user: { id: string; email: string; factors?: { status: string }[] } | null = { id: ME, email: "me@example.com" };
let aal = "aal1";
let passwordOk = true;
let reserveAnswer = "ok";
let deleteFails = false;
let signedOut = 0;
let sessionProfileReads = 0;
const rpcCalls: { fn: string; args: unknown }[] = [];
const deletedUsers: string[] = [];
const audits: Record<string, unknown>[] = [];
const storage = new FakeStorage();
storage.add("avatars", `${ME}/current.png`, `${ME}/replaced.png`, `${OTHER}/keep.png`);
storage.add("creator-media", `${ME}/photo.webp`, `${OTHER}/keep.webp`);
const svcTables = new FakeTables({
  profiles: [{ id: ME, role: "creator", is_active: true }],
  fan_passes: [
    { id: "p1", creator_id: ME, token: "linkAAAA1111" },
    { id: "p2", creator_id: ME, token: "linkBBBB2222" },
    { id: "p3", creator_id: OTHER, token: "otherCCCC333" },
  ],
  link_tombstones: [],
  redemptions: [],
});
const work = new FakeStorageWork(svcTables, {
  reserve: () => reserveAnswer,
  authExists: (id) => !deletedUsers.includes(id),
  onAudit: (entry) => { audits.push(entry); },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => ({
      // The session reads its own profile row (profiles_select).
      from: (table: string) => {
        if (table !== "profiles") throw new Error(`unexpected session read of ${table}`);
        sessionProfileReads++;
        return svcTables.from(table);
      },
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
      from: work.from,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "creator_storage_account" && args.p_operation === "begin") rpcCalls.push({ fn, args });
        return work.rpc(fn, args);
      },
      auth: {
        admin: {
          deleteUser: async (id: string) => {
            if (deleteFails) return { error: { message: "boom", status: 400 } };
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

  // S1: the caller owns an agency with one seat and one managed creator. A
  // close the database refuses must announce nothing: no "agency dissolved"
  // notice to anyone and no org.dissolve activity entry.
  svcTables.tables.orgs = [{ id: ORG, name: "Northside", owner_id: ME }];
  svcTables.tables.org_members = [{ org_id: ORG, profile_id: ME }, { org_id: ORG, profile_id: SEAT }];
  svcTables.rows("profiles").push({ id: SEAT, role: "creator", is_active: true }, { id: MANAGED, role: "creator", is_active: true, org_id: ORG });
  const announced = () => svcTables.rows("creator_notices").length + svcTables.rows("admin_audit_log").filter((r) => r.action === "org.dissolve").length;

  for (const refusal of ["last_admin", "reports_open", "suspended"]) {
    reserveAnswer = refusal;
    res = await close(GOOD);
    check(`${refusal} → refused as ${refusal}`, res.status === (refusal === "suspended" ? 403 : 409) && (await res.json()).error === refusal);
    check(`${refusal}: nothing is deleted`, deletedUsers.length === 0 && svcTables.rows("link_tombstones").length === 0);
    check(`${refusal}: no agency notice and no org.dissolve entry for a close that didn't happen`, announced() === 0);
  }
  reserveAnswer = "ok";
  rpcCalls.length = 0;

  // A suspended session is refused up front, from its own row: before the
  // password is tried, before the service role is touched.
  svcTables.rows("profiles")[0].is_active = false;
  pwAttempts.length = 0;
  const statementsBefore = svcTables.statements.length;
  res = await close(GOOD);
  check("a suspended account → 403 suspended", res.status === 403 && (await res.json()).error === "suspended");
  check("…before the password is tried", pwAttempts.length === 0);
  check("…nothing reserved, deleted or announced", nothingDeleted() && announced() === 0);
  check("…and the only writes are none at all", svcTables.statements.slice(statementsBefore).every((st) => st.op === "select"));
  svcTables.rows("profiles")[0].is_active = true;
  check("the standing came from the session's own profile row", sessionProfileReads > 0);

  // T4: a creator who still owes fans prizes cannot close (pending or in progress).
  for (const status of ["pending", "in_progress"]) {
    svcTables.tables.redemptions = [
      { id: "r-owed", creator_id: ME, status },
      { id: "r-done", creator_id: ME, status: "fulfilled" },
    ];
    res = await close(GOOD);
    const body = await res.json();
    check(`a ${status} prize → 409 prizes_owed`, res.status === 409 && body.error === "prizes_owed" && body.owed === 1);
    check(`…nothing deleted while a ${status} prize is owed`, nothingDeleted());
  }
  // Only the caller's own owed prizes count; delivered/cancelled ones never block.
  svcTables.tables.redemptions = [
    { id: "r-other", creator_id: OTHER, status: "pending" },
    { id: "r-done", creator_id: ME, status: "fulfilled" },
    { id: "r-cancel", creator_id: ME, status: "cancelled" },
  ];
  svcTables.failWhen = (statement) => statement.table === "redemptions" ? "read failed" : null;
  res = await close(GOOD);
  check("a failed owed-prize read fails closed (500), deleting nothing", res.status === 500 && (await res.json()).error === "db_error" && nothingDeleted());
  svcTables.failWhen = null;

  storage.removeFailures = 3;
  res = await close(GOOD);
  check("storage failure → 500, never false success", res.status === 500 && (await res.json()).error === "storage_cleanup_failed");
  check("storage failure preserves auth/DB retry paths", deletedUsers.length === 0 && svcTables.rows("fan_passes").length === 3);
  check("storage failure records no success audit or signout", audits.length === 0 && signedOut === 0);
  check("a failed close announces no dissolution either", announced() === 0);
  storage.removeFailures = 0;
  rpcCalls.length = 0;

  // A forged id in the body is ignored: only the session's own id is used.
  res = await close({ ...GOOD, id: OTHER, userId: OTHER });
  check("success → 200 ok", res.status === 200 && (await res.json()).ok === true);
  check("no-store", /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("atomically reserved/quiesced the caller's own id", rpcCalls.length === 1 && rpcCalls[0].fn === "creator_storage_account" && (rpcCalls[0].args as { p_owner: string }).p_owner === ME);
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
  // The agency really is dissolved now: its seat and its managed creator are
  // told (never the owner), and the activity log says so once.
  const told = svcTables.rows("creator_notices");
  check("the seat and the managed creator each get one agency_dissolved notice", told.length === 2 && told.every((n) => n.kind === "agency_dissolved" && (n.details as { org_name?: string }).org_name === "Northside") && told.some((n) => n.creator_id === SEAT) && told.some((n) => n.creator_id === MANAGED));
  check("the owner is never sent the notice", !told.some((n) => n.creator_id === ME));
  const dissolved = svcTables.rows("admin_audit_log").filter((r) => r.action === "org.dissolve");
  check("one org.dissolve activity entry, by self_close", dissolved.length === 1 && dissolved[0].target_id === ORG && (dissolved[0].details as { by?: string }).by === "self_close");

  // A failed delete restores an admin's role (the reservation demoted it).
  deletedUsers.length = 0;
  svcTables.rows("profiles")[0].role = "admin";
  svcTables.rows("profiles")[0].is_active = true;
  svcTables.tables.link_tombstones = [];
  svcTables.tables.creator_storage_deletions = [];
  svcTables.tables.creator_storage_objects = [];
  deleteFails = true;
  res = await close(GOOD);
  check("delete failure → 500 delete_failed", res.status === 500 && (await res.json()).error === "delete_failed");
  const restore = svcTables.statements.find((s) => s.table === "profiles" && s.op === "update" && (s.payload as { role?: string }).role === "admin");
  check("…and the admin role is restored", !!restore && (restore.payload as { role?: string }).role === "admin" && restore.filters.some((f) => f.value === ME));
  check("…and the original active state is restored", svcTables.rows("profiles")[0].is_active === true);
  check("…and no tombstones are written", svcTables.rows("link_tombstones").length === 0);
  check("…and no activity entry for a close that didn't happen", audits.length === 1);

  // A close already under way (accepted earlier, the account parked inactive
  // while its files go) is let through to finish; only a suspension with no
  // deletion in flight is refused up front.
  deleteFails = false;
  svcTables.rows("profiles")[0].is_active = false;
  svcTables.tables.creator_storage_deletions = [{ owner_id: ME, id: "job-1", state: "pending", link_hashes: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt_id: "attempt-1", was_role: "creator", was_active: true, lease_id: null }];
  res = await close(GOOD);
  const resumed = await res.json();
  check("a close already under way is not refused as suspended", res.status !== 403 && resumed.error !== "suspended" && (res.status === 200 || res.status === 202));
  svcTables.tables.creator_storage_deletions = [{ owner_id: ME, id: "job-2", state: "paused", link_hashes: [], created_at: new Date().toISOString() }];
  svcTables.rows("profiles")[0].is_active = false;
  res = await close(GOOD);
  check("a paused (failed) deletion does not excuse a suspended account", res.status === 403 && (await res.json()).error === "suspended");

  console.log(`account close route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
