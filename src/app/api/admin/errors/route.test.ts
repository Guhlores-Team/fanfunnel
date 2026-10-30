import assert from "node:assert";
import { mock } from "node:test";
import type { AuditInput } from "@/lib/data/audit";

// Admin › Errors API. The gate is the real requireAdminRoute → checkAdmin →
// is_admin() path driven by a fake cookie client: a signed-out caller and a
// normal creator never reach the list or the resolve (AGENTS.md rule 7).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let signedIn = true;
let isAdmin = false;
let aal: "aal1" | "aal2" = "aal2";
const lists: unknown[] = [];
const resolves: unknown[][] = [];
const audits: AuditInput[] = [];

mock.module("@/lib/data/audit", {
  namedExports: { recordAudit: async (entry: AuditInput) => { audits.push(entry); } },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: signedIn ? { id: "user-1" } : null }, error: null }),
        getSession: async () => ({ data: { session: signedIn ? { access_token: `header.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.signature` } : null } }),
      },
      rpc: async (name: string) => {
        if (name !== "is_admin") throw new Error(`unexpected rpc ${name}`);
        return { data: isAdmin, error: null };
      },
      from: () => {
        throw new Error("is_admin() answered; the profiles fallback must not run");
      },
    }),
    createServiceClient: () => {
      throw new Error("the admin errors route must not use the service role");
    },
  },
});

mock.module("@/lib/data/appErrors", {
  namedExports: {
    listAppErrors: async (filter: unknown) => {
      lists.push(filter);
      return [{ id: "e1", message: "boom" }];
    },
    resolveAppError: async (...args: unknown[]) => {
      resolves.push(args);
      return args[0] === "00000000-0000-4000-8000-00000000dead" ? { error: "not_found" } : { ok: true };
    },
  },
});

const ID = "3f2b9c1e-7a4d-4e2f-9b1a-2c3d4e5f6a7b";

async function main() {
  const { GET, POST } = await import("./route");
  const get = async (qs = "") => {
    const res = await GET(new Request(`http://localhost/api/admin/errors${qs}`));
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const post = async (body: unknown) => {
    const res = await POST(
      new Request("http://localhost/api/admin/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  // --- negative: signed out --------------------------------------------------------
  signedIn = false;
  check("signed out: GET → 401", (await get()).status === 401);
  check("signed out: resolve → 401", (await post({ id: ID, resolved: true })).status === 401);

  // --- negative: a normal (non-admin) creator ----------------------------------------
  signedIn = true;
  isAdmin = false;
  {
    const r = await get();
    check("creator: GET → 403 forbidden", r.status === 403 && r.data.error === "forbidden");
    check("creator: no error data in the body", !("errors" in r.data));
  }
  check("creator: resolve → 403", (await post({ id: ID, resolved: true })).status === 403);
  check("creator: reopen → 403", (await post({ id: ID, resolved: false })).status === 403);
  check("non-admins never reached the data layer", lists.length === 0 && resolves.length === 0);

  // A password-only session must not reach error data or record an action,
  // even if a pre-0054 database still answers true to is_admin().
  isAdmin = true;
  aal = "aal1";
  const needsMfa = await get();
  check("password-only admin: GET requires MFA", needsMfa.status === 403 && needsMfa.data.error === "mfa_required");
  check("password-only admin: resolve refused", (await post({ id: ID, resolved: true })).status === 403);
  check("password-only admin: reopen refused", (await post({ id: ID, resolved: false })).status === 403);
  check("refused callers never read, write or audit", lists.length === 0 && resolves.length === 0 && audits.length === 0);
  aal = "aal2";

  // --- admin ----------------------------------------------------------------------------
  isAdmin = true;
  {
    const r = await get();
    check("admin: GET → 200 with errors", r.status === 200 && Array.isArray(r.data.errors));
    check("admin: defaults to open, all environments", JSON.stringify(lists.at(-1)) === '{"status":"open"}');
  }
  await get("?status=resolved&env=preview");
  check("admin: filters pass through", JSON.stringify(lists.at(-1)) === '{"status":"resolved","environment":"preview"}');
  check("admin: unknown status → 400", (await get("?status=all")).status === 400);
  check("admin: unknown env → 400", (await get("?env=staging")).status === 400);

  check("admin: resolve → 200", (await post({ id: ID, resolved: true })).status === 200);
  check("admin: resolve called with (id, true)", JSON.stringify(resolves.at(-1)) === JSON.stringify([ID, true]));
  check("admin: resolve records a PII-free activity entry", JSON.stringify(audits.at(-1)) === JSON.stringify({ actorId: "user-1", action: "error.resolve", targetType: "error", targetId: ID, details: { resolved: true } }));
  check("admin: resolved defaults to true", (await post({ id: ID })).status === 200 && resolves.at(-1)?.[1] === true);
  check("admin: reopen → 200", (await post({ id: ID, resolved: false })).status === 200 && resolves.at(-1)?.[1] === false);
  check("admin: reopen records the action", audits.at(-1)?.action === "error.reopen" && audits.at(-1)?.details?.resolved === false);
  const before = resolves.length;
  const auditBefore = audits.length;
  check("admin: non-uuid id → 400", (await post({ id: "1; drop table" })).status === 400);
  check("admin: non-boolean resolved → 400", (await post({ id: ID, resolved: "yes" })).status === 400);
  check("admin: malformed JSON → 400", (await post("{")).status === 400);
  check("bad input never reached the data layer", resolves.length === before);
  check("admin: unknown id → 404", (await post({ id: "00000000-0000-4000-8000-00000000dead" })).status === 404);
  check("bad input and unknown errors do not create audit entries", audits.length === auditBefore);

  console.log(`api/admin/errors route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
