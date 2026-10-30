/**
 * NEGATIVE TEST (AGENTS.md rule 7, two-factor for admins): every admin API
 * route refuses an admin whose session hasn't done two-factor (aal1), and a
 * normal creator, before any admin data or action is reached. It discovers the
 * routes under src/app/api/admin, so a new admin route is covered
 * automatically. The one-time bootstrap (/api/admin/claim) is exempt, as in
 * adminGuard.test.ts. Also: an aal2 admin passes and can read the activity log.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const tok = (aal: string) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
type Who = "aal1-admin" | "aal1-admin-with-factor" | "creator" | "aal2-admin";
let who: Who = "aal1-admin";
let reached: string[] = [];

const isAdminRow = () => who !== "creator";
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              factors: who === "aal1-admin-with-factor" || who === "aal2-admin" ? [{ status: "verified" }] : [],
            },
          },
        }),
        getSession: async () => ({ data: { session: { access_token: tok(who === "aal2-admin" ? "aal2" : "aal1") } } }),
      },
      // 0054: is_admin() is true only for an active admin on aal2.
      rpc: async (fn: string) => {
        assert.equal(fn, "is_admin");
        return { data: who === "aal2-admin", error: null };
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { role: isAdminRow() ? "admin" : "creator", is_active: true },
              error: null,
            }),
          }),
        }),
      }),
    }),
    createServiceClient: () => {
      reached.push("service-role");
      throw new Error("a refused caller must never reach the service role");
    },
  },
});
const reach = (name: string) => async () => {
  reached.push(name);
  return name === "listAuditLog" ? [{ id: "e1", action: "account.create" }] : { ok: true };
};
mock.module("@/lib/data", {
  namedExports: {
    getAdminOverview: reach("getAdminOverview"),
    updateAccount: reach("updateAccount"),
    recordAudit: reach("recordAudit"),
    listCreatorApplications: reach("listCreatorApplications"),
    decideCreatorApplication: reach("decideCreatorApplication"),
    createCreatorAccount: reach("createCreatorAccount"),
    listAuditLog: reach("listAuditLog"),
    claimAdmin: reach("claimAdmin"),
  },
});

const SRC = join(import.meta.dirname, "../..");
const ADMIN_API = join(SRC, "app/api/admin");
const BOOTSTRAP = "app/api/admin/claim/route.ts";
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

let passed = 0;
async function main() {
  const routes = walk(ADMIN_API).filter((p) => relative(SRC, p).split("\\").join("/") !== BOOTSTRAP);
  assert.ok(routes.length >= 7, `expected the admin routes, found ${routes.length}`);
  const VALID = JSON.stringify({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "x@example.com",
    password: "abc12345",
    profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    decision: "approved",
    role: "creator",
  });

  for (const file of routes) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, (r: Request) => Promise<Response>>;
    const name = relative(SRC, file);
    for (const method of ["GET", "POST"] as const) {
      const handler = mod[method];
      if (!handler) continue;
      for (const w of ["aal1-admin", "aal1-admin-with-factor", "creator"] as Who[]) {
        who = w;
        reached = [];
        const res = await handler(new Request("http://localhost/x", { method, body: method === "POST" ? VALID : undefined }));
        const body = (await res.json()) as { error?: string; step?: string };
        if (w === "creator") {
          assert.equal(res.status, 403, `${method} ${name} as a creator: ${res.status}`);
          assert.equal(body.error, "forbidden", `${method} ${name} as a creator`);
        } else {
          assert.equal(res.status, 403, `${method} ${name} as an ${w}: ${res.status}`);
          assert.equal(body.error, "mfa_required", `${method} ${name} as an ${w}`);
          assert.equal(body.step, w === "aal1-admin" ? "enrol" : "challenge", `${method} ${name} step`);
        }
        assert.deepEqual(reached, [], `${method} ${name} as ${w} reached ${reached.join(", ")}`);
        passed++;
      }
    }
  }

  // The positive control: an active admin on aal2 gets through the guard.
  who = "aal2-admin";
  reached = [];
  const { GET } = await import("../../app/api/admin/audit/route");
  const res = await GET();
  assert.equal(res.status, 200);
  assert.ok(reached.includes("listAuditLog"));
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  passed++;

  console.log(`adminMfa.test: ${passed} checks passed across ${routes.length} admin routes`);
}

main().catch((e) => {
  console.error("  ✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
