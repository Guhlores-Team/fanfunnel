/**
 * AUTH-SENSITIVE (AGENTS.md rules 1/2/7), batch 6 attack audit B1: an
 * applicant can write their own creator_applications row straight through
 * PostgREST (any e-mail, `status`, dates). Negative test: a forged row that
 * claims another address and `status='approved'` neither shows that address
 * in Admin › Requests or the bell, nor grants anything: the status shown and
 * the approval gate both come from `profiles` (admin-only UPDATE), the
 * address from the auth user (service role).
 */
import assert from "node:assert";
import { mock } from "node:test";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const APPLICANT = "aaaaaaaa-0000-4000-8000-0000000000b1";
const ADMIN = "dddddddd-0000-4000-8000-0000000000ad";
type Op = { name: string; args: unknown[] };
type Call = { client: "session" | "service"; table: string; ops: Op[] };
const calls: Call[] = [];
let profileState: "pending" | "approved" | "rejected" | null = "pending";
let profileUpdated = false;
let sessionUser: { id: string } = { id: ADMIN };
let admin = true;

const forgedRow = {
  id: "app-1",
  profile_id: APPLICANT,
  email: "famous.creator@example.com",
  display_name: "Famous Creator",
  socials: "x".repeat(5000),
  audience_size: "1M",
  note: "n".repeat(200_000),
  status: "approved",
  decided_at: "2020-01-02T00:00:00Z",
  created_at: "2020-01-01T00:00:00Z",
};

function builder(client: Call["client"], table: string) {
  const call: Call = { client, table, ops: [] };
  calls.push(call);
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown) => {
          const upd = call.ops.find((o) => o.name === "update");
          let out: { data: unknown; error: unknown } = { data: null, error: null };
          if (table === "creator_applications" && !upd) {
            const filtersPending = call.ops.some((o) => o.name === "eq" && o.args[0] === "status");
            out = { data: filtersPending ? [] : [forgedRow], error: null };
          } else if (table === "profiles" && upd) {
            const guarded = call.ops.some((o) => o.name === "neq" && o.args[0] === "approval_status" && o.args[1] === profileState);
            if (!guarded && profileState) {
              profileState = (upd.args[0] as { approval_status: typeof profileState }).approval_status;
              profileUpdated = true;
              out = { data: { id: APPLICANT }, error: null };
            }
          } else if (table === "profiles") {
            const row = profileState ? { id: APPLICANT, approval_status: profileState, role: "creator", created_at: "2026-11-01T00:00:00Z" } : null;
            const many = call.ops.some((o) => o.name === "in");
            out = { data: many ? (row ? [row] : []) : row, error: null };
          }
          return Promise.resolve(out).then(res);
        };
      }
      return (...args: unknown[]) => { call.ops.push({ name: String(prop), args }); return proxy; };
    },
  });
  return proxy;
}
const session = () => ({
  from: (t: string) => builder("session", t),
  rpc: async () => ({ data: admin, error: null }),
  auth: { getUser: async () => ({ data: { user: sessionUser }, error: null }) },
});
const service = () => ({
  from: (t: string) => builder("service", t),
  auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: id === APPLICANT ? "real.applicant@example.com" : null } }, error: null }) } },
});
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => session(), createServiceClient: () => service() } });
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => admin, checkAdmin: async () => ({ status: admin ? "admin" : "not_admin", userId: ADMIN }) } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: () => {} } });

async function main() {
  const data = await import("@/lib/data/admin");

  // --- Admin › Requests -------------------------------------------------------
  const list = await data.listCreatorApplications();
  const shown = JSON.stringify(list);
  check("the forged request is listed once", list.length === 1);
  check("the forged address is never shown", !shown.includes("famous.creator@example.com"));
  check("the sign-in address of the auth user is shown instead", list[0].email === "real.applicant@example.com");
  check("the address came from the service-role auth lookup", !calls.some((c) => c.table === "creator_applications" && c.ops.some((o) => o.name === "select" && String(o.args[0]).includes("email"))));
  check("status comes from profiles: still 'pending', not the row's 'approved'", list[0].status === "pending");
  check("a backdated request is clamped to the account's creation", list[0].createdAt === "2026-11-01T00:00:00.000Z");
  check("an oversized note/socials is clipped for display", (list[0].note ?? "").length === 1000 && (list[0].socials ?? "").length === 600);

  // --- the bell: waiting = profiles.approval_status ----------------------------
  // loadPendingApplications is internal; assert its query shape on the source.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../data/notifications.ts", import.meta.url), "utf8");
  check("the bell filters on profiles.approval_status, not the row's status", src.includes('.eq("profiles.approval_status", "pending")') && !/creator_applications"\)[\s\S]{0,200}\.eq\("status", "pending"\)/.test(src));

  // --- the forged 'approved' grants nothing -----------------------------------
  sessionUser = { id: APPLICANT };
  admin = false;
  check("the applicant's gate still reads pending (profiles, not the row)", (await data.getMyApprovalStatus()) === "pending");
  calls.length = 0;
  const self = await data.decideCreatorApplication(APPLICANT, "approved");
  check("the applicant cannot approve their own request", "error" in self && self.error === "unauthorized" && !profileUpdated);
  check("…and nothing was written", !calls.some((c) => c.ops.some((o) => o.name === "update")));

  // --- the approval path follows the profile ---------------------------------
  sessionUser = { id: ADMIN };
  admin = true;
  profileState = null;
  calls.length = 0;
  const missing = await data.decideCreatorApplication(APPLICANT, "approved");
  check("approving a request with no profile is refused, nothing written", "error" in missing && !calls.some((c) => c.ops.some((o) => o.name === "update")));
  profileState = "approved";
  calls.length = 0;
  const again = await data.decideCreatorApplication(APPLICANT, "approved");
  check("an already-approved profile is a no-op (no writes, no second notice)", "ok" in again && !calls.some((c) => c.ops.some((o) => o.name === "update")));
  profileState = "pending";
  profileUpdated = false;
  calls.length = 0;
  const ok = await data.decideCreatorApplication(APPLICANT, "approved");
  check("a pending profile is approved by an admin", "ok" in ok && profileUpdated && (profileState as string) === "approved");
  const order = calls.filter((c) => c.ops.some((o) => o.name === "update")).map((c) => c.table);
  check("the profile flips first; the request row is only marked afterwards", order[0] === "profiles" && order.includes("creator_applications"));

  console.log(`accessRequestForgery.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
