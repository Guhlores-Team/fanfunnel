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
let nextResult: { ok: true; id?: string } | { error: string } = { ok: true };
const creates: unknown[][] = [];
const audits: Record<string, unknown>[] = [];
// The session's two-factor level (0054: admin power needs aal2).
let aal: "aal1" | "aal2" = "aal2";
const token = () => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: signedIn ? { id: "user-1" } : null }, error: null }),
        getSession: async () => ({ data: { session: { access_token: token() } } }),
      },
      rpc: async (name: string) => {
        if (name !== "is_admin") throw new Error(`unexpected rpc ${name}`);
        // 0054's is_admin() is false on an aal1 session.
        return { data: isAdmin && aal === "aal2", error: null };
      },
      from: (table: string) => {
        // Only an aal1 session reads its own row (to say which 2FA step).
        if (aal !== "aal1" || table !== "profiles") {
          throw new Error("is_admin() answered; the profiles fallback must not run");
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { role: "admin", is_active: true }, error: null }),
            }),
          }),
        };
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
    recordAudit: async (entry: Record<string, unknown>) => {
      audits.push(entry);
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

  check("failed creates are not logged as activity", audits.length === 0);

  // --- success is unchanged ---------------------------------------------------
  nextResult = { ok: true, id: "11111111-1111-4111-8111-111111111111" };
  {
    const r = await invite(VALID);
    check("created → 200 { ok: true }", r.status === 200 && r.data.ok === true);
    check("the new account's id is not echoed to the client", !("id" in r.data));
    check(
      "the create is logged with actor + target ids only",
      audits.length === 1 &&
        audits[0].action === "account.create" &&
        audits[0].actorId === "user-1" &&
        audits[0].targetId === "11111111-1111-4111-8111-111111111111" &&
        !JSON.stringify(audits[0]).includes("new@example.com")
    );
  }

  // --- negative: an admin on an aal1 (password-only) session is refused -------
  creates.length = 0;
  aal = "aal1";
  {
    const r = await invite(VALID);
    check(
      "aal1 admin → 403 mfa_required (enrol step)",
      r.status === 403 && r.data.error === "mfa_required" && r.data.step === "enrol"
    );
  }
  check("an aal1 admin never reached createCreatorAccount", creates.length === 0);
  aal = "aal2";

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
