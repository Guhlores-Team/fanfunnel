import assert from "node:assert";
import { mock } from "node:test";

// POST /api/admin/invite. Owner decision: a taken email is a conflict, so the
// route answers 409 `{ error: "email_taken" }` (it used to be a 400). The admin
// gate is the real requireAdminRoute -> checkAdmin -> is_admin() path, driven
// by a fake cookie client, so the negative cases prove a signed-out caller or a
// normal creator never reaches account creation.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let signedIn = true;
let isAdmin = true;
let nextResult: { ok: true } | { error: string } = { ok: true };
const creates: unknown[][] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "user-1" } : null }, error: null }) },
      rpc: async (name: string) => {
        if (name !== "is_admin") throw new Error(`unexpected rpc ${name}`);
        return { data: isAdmin, error: null };
      },
      from: () => {
        throw new Error("is_admin() answered; the profiles fallback must not run");
      },
    }),
    createServiceClient: () => {
      throw new Error("the route must not build a service client itself");
    },
  },
});

mock.module("@/lib/data", {
  namedExports: {
    createCreatorAccount: async (...args: unknown[]) => {
      creates.push(args);
      return nextResult;
    },
  },
});

async function main() {
  const { POST } = await import("./route");
  const { inviteErrorMessage } = await import("@/components/admin/adminErrors");

  async function invite(body: unknown) {
    const res = await POST(
      new Request("http://localhost/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  const VALID = { email: "new@example.com", password: "abc12345", displayName: "New" };

  // --- the change: email_taken -> 409, same JSON shape ------------------------
  nextResult = { error: "email_taken" };
  {
    const r = await invite(VALID);
    check("email_taken → 409", r.status === 409);
    check("body is exactly { error: 'email_taken' }", JSON.stringify(r.data) === JSON.stringify({ error: "email_taken" }));
    check(
      "the admin console still shows the taken-email copy",
      inviteErrorMessage(r.data.error) === "An account with that email already exists."
    );
  }

  // --- every other code keeps its status --------------------------------------
  for (const code of ["invalid_email", "weak_password", "create_failed"]) {
    nextResult = { error: code };
    const r = await invite(VALID);
    check(`${code} → 400`, r.status === 400 && r.data.error === code);
  }
  nextResult = { error: "unauthorized" };
  {
    const r = await invite(VALID);
    check("data-layer unauthorized → 401", r.status === 401 && r.data.error === "unauthorized");
  }

  // --- success is unchanged ---------------------------------------------------
  nextResult = { ok: true };
  {
    const r = await invite(VALID);
    check("created → 200 { ok: true }", r.status === 200 && r.data.ok === true);
  }

  // --- negative: only an active admin reaches createCreatorAccount -------------
  creates.length = 0;
  isAdmin = false;
  {
    const r = await invite(VALID);
    check("normal creator → 403 forbidden", r.status === 403 && r.data.error === "forbidden");
  }
  signedIn = false;
  {
    const r = await invite(VALID);
    check("signed out → 401 unauthorized", r.status === 401 && r.data.error === "unauthorized");
  }
  check("non-admins never reached createCreatorAccount", creates.length === 0);

  console.log(`api/admin/invite route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
