import assert from "node:assert";
import { mock } from "node:test";
import type { AuditInput } from "@/lib/data/audit";

// Admin › Reports API (A1). The gate is the real requireAdminRoute →
// checkAdmin → is_admin() path driven by a fake cookie client: a signed-out
// caller, a normal creator and a password-only admin never reach the report
// list, the open count or a review (AGENTS.md rule 7).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let signedIn = true;
let isAdmin = false;
let aal: "aal1" | "aal2" = "aal2";
const lists: unknown[][] = [];
const reviews: unknown[][] = [];
let counts = 0;
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
      throw new Error("the admin reports routes must not use the service role");
    },
  },
});

const ID = "3f2b9c1e-7a4d-4e2f-9b1a-2c3d4e5f6a7b";
const GONE = "00000000-0000-4000-8000-00000000dead";

mock.module("@/lib/data/reports", {
  namedExports: {
    decodeReportCursor: (raw: string | null) => (raw === "2026-10-29T00:00:00.000Z|" + ID ? { createdAt: "x", id: ID } : null),
    listReports: async (...args: unknown[]) => {
      lists.push(args);
      return { reports: [{ id: ID, reason: "Other" }], openCount: 3, urgentOpenCount: 1, next: null };
    },
    countOpenReports: async () => {
      counts++;
      return 3;
    },
    reviewReport: async (...args: unknown[]) => {
      reviews.push(args);
      if (args[0] === GONE) return { error: "not_found" };
      return { ok: true, report: { id: args[0], status: args[1], urgent: true } };
    },
  },
});

async function main() {
  const { GET, POST } = await import("./route");
  const { GET: COUNT } = await import("./count/route");
  const get = async (qs = "") => {
    const res = await GET(new Request(`http://localhost/api/admin/reports${qs}`));
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const count = async () => {
    const res = await COUNT();
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const post = async (body: unknown) => {
    const res = await POST(
      new Request("http://localhost/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  // --- negative: signed out ---------------------------------------------------
  signedIn = false;
  check("signed out: list → 401", (await get()).status === 401);
  check("signed out: count → 401", (await count()).status === 401);
  check("signed out: resolve → 401", (await post({ id: ID, status: "resolved" })).status === 401);

  // --- negative: a normal (non-admin) creator ----------------------------------
  signedIn = true;
  isAdmin = false;
  {
    const r = await get();
    check("creator: list → 403 forbidden", r.status === 403 && r.data.error === "forbidden");
    check("creator: no report data in the body", !("reports" in r.data) && !("openCount" in r.data));
  }
  {
    const r = await count();
    check("creator: count → 403 and no number", r.status === 403 && !("openCount" in r.data));
  }
  check("creator: resolve → 403", (await post({ id: ID, status: "resolved" })).status === 403);
  check("creator: dismiss → 403", (await post({ id: ID, status: "dismissed" })).status === 403);
  check("creator: reopen → 403", (await post({ id: ID, status: "open" })).status === 403);
  check("non-admins never reached the data layer", lists.length === 0 && reviews.length === 0 && counts === 0);

  // A password-only admin session is refused too.
  isAdmin = true;
  aal = "aal1";
  check("password-only admin: list needs MFA", (await get()).data.error === "mfa_required");
  check("password-only admin: count needs MFA", (await count()).data.error === "mfa_required");
  check("password-only admin: resolve refused", (await post({ id: ID, status: "resolved" })).status === 403);
  check("refused callers never read, write or audit", lists.length === 0 && reviews.length === 0 && counts === 0 && audits.length === 0);
  aal = "aal2";

  // --- admin --------------------------------------------------------------------
  {
    const r = await get();
    check("admin: list → 200 with reports and counts", r.status === 200 && Array.isArray(r.data.reports) && r.data.openCount === 3);
    check("admin: defaults to open, every reason, first page", JSON.stringify(lists.at(-1)) === JSON.stringify([{ status: "open" }, null]));
  }
  await get("?status=all&reason=" + encodeURIComponent("Inappropriate photo"));
  check("admin: filters pass through", JSON.stringify(lists.at(-1)?.[0]) === JSON.stringify({ status: "all", reason: "Inappropriate photo" }));
  await get(`?status=resolved&before=${encodeURIComponent("2026-10-29T00:00:00.000Z|" + ID)}`);
  check("admin: the cursor passes through", lists.at(-1)?.[1] === "2026-10-29T00:00:00.000Z|" + ID);
  const listed = lists.length;
  check("admin: unknown status → 400", (await get("?status=reviewed")).status === 400);
  check("admin: unknown reason → 400", (await get("?reason=whatever")).status === 400);
  check("admin: bad cursor → 400", (await get("?before=nope")).status === 400);
  check("bad filters never reached the data layer", lists.length === listed);
  check("admin: count → 200", (await count()).data.openCount === 3);

  const r = await post({ id: ID, status: "resolved", note: "  Checked the photos; removed them.  " });
  check("admin: resolve → 200 with the stamped row", r.status === 200 && (r.data.report as { status?: string })?.status === "resolved");
  check("admin: the note is trimmed and the actor is the session's", JSON.stringify(reviews.at(-1)) === JSON.stringify([ID, "resolved", "Checked the photos; removed them.", "user-1"]));
  check(
    "admin: resolve records a PII-free activity entry (no note text)",
    JSON.stringify(audits.at(-1)) === JSON.stringify({ actorId: "user-1", action: "report.resolve", targetType: "report", targetId: ID, details: { urgent: true, withNote: true } }),
  );
  check("admin: dismiss without a note", (await post({ id: ID, status: "dismissed" })).status === 200 && reviews.at(-1)?.[2] === null);
  check("admin: dismiss is audited", audits.at(-1)?.action === "report.dismiss" && audits.at(-1)?.details?.withNote === false);
  check("admin: reopen", (await post({ id: ID, status: "open" })).status === 200 && audits.at(-1)?.action === "report.reopen");

  const before = reviews.length;
  const auditBefore = audits.length;
  check("admin: non-uuid id → 400", (await post({ id: "1; drop table", status: "resolved" })).status === 400);
  check("admin: unknown status → 400", (await post({ id: ID, status: "actioned" })).status === 400);
  check("admin: non-string note → 400", (await post({ id: ID, status: "resolved", note: 5 })).status === 400);
  check("admin: over-long note → 400", (await post({ id: ID, status: "resolved", note: "x".repeat(1001) })).data.error === "note_too_long");
  check("admin: malformed JSON → 400", (await post("{")).status === 400);
  check("bad input never reached the data layer", reviews.length === before);
  check("admin: unknown id → 404", (await post({ id: GONE, status: "resolved" })).status === 404);
  check("bad input and unknown reports are not audited", audits.length === auditBefore);

  console.log(`api/admin/reports route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
