import assert from "node:assert";
import { mock } from "node:test";

// GET /api/cron/retention: only Vercel Cron (Bearer CRON_SECRET) can trigger
// deletions. Negative cases: no secret configured (fails closed, 503), a short
// secret, a missing/wrong header → nothing runs. Positive: the RPC gets exactly
// the periods from src/lib/privacy/retention.ts and a summary is logged.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const rpcCalls: { fn: string; args: Record<string, number> }[] = [];
const audits: Record<string, unknown>[] = [];
let deleted: Record<string, number | null> = { admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, app_errors: null };

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({
      rpc: async (fn: string, args: Record<string, number>) => {
        rpcCalls.push({ fn, args });
        return { data: deleted, error: null };
      },
    }),
  },
});
mock.module("@/lib/data", {
  namedExports: { recordAudit: async (e: Record<string, unknown>) => void audits.push(e) },
});

async function main() {
  const { GET } = await import("./route");
  const { RETENTION_DAYS } = await import("@/lib/privacy/retention");
  const call = (auth?: string) =>
    GET(new Request("http://localhost/api/cron/retention", { headers: auth ? { authorization: auth } : {} }));
  const SECRET = "s3cret-s3cret-s3cret-0123456789";

  delete process.env.CRON_SECRET;
  let res = await call(`Bearer ${SECRET}`);
  check("no CRON_SECRET → 503, nothing runs", res.status === 503 && rpcCalls.length === 0);

  process.env.CRON_SECRET = "short";
  res = await call("Bearer short");
  check("a too-short secret is refused", res.status === 503 && rpcCalls.length === 0);

  process.env.CRON_SECRET = SECRET;
  for (const h of [undefined, SECRET, `Bearer ${SECRET}x`, `bearer ${SECRET}`, "Bearer "]) {
    res = await call(h);
    check(`header ${JSON.stringify(h)?.slice(0, 20)} → 401`, res.status === 401);
  }
  check("nothing ran without the right header", rpcCalls.length === 0);

  res = await call(`Bearer ${SECRET}`);
  check("right header → 200", res.status === 200 && /no-store/.test(res.headers.get("cache-control") ?? ""));
  check(
    "the RPC gets the documented periods",
    rpcCalls.length === 1 && rpcCalls[0].fn === "run_retention_cleanup" &&
      rpcCalls[0].args.p_audit_days === RETENTION_DAYS.adminAuditLog &&
      rpcCalls[0].args.p_notice_days === RETENTION_DAYS.creatorNotices &&
      rpcCalls[0].args.p_tombstone_days === RETENTION_DAYS.linkTombstones &&
      rpcCalls[0].args.p_app_error_days === RETENTION_DAYS.resolvedAppErrors &&
      rpcCalls[0].args.p_closed_invite_days === RETENTION_DAYS.closedAgencyInvites
  );
  check("a run that deleted nothing logs nothing", audits.length === 0);

  deleted = { push_log: 2, admin_audit_log: 3, creator_notices: 0, link_tombstones: 2, org_invites: 4, app_errors: null };
  res = await call(`Bearer ${SECRET}`);
  check("a run that deleted rows is logged with counts", audits.length === 1 && audits[0].action === "retention.cleanup" && (audits[0].details as { adminAuditLog?: number }).adminAuditLog === 3);
  check("push delivery log deletions are counted", (audits[0].details as { pushLog?: number }).pushLog === 2);
  check("closed agency invites are counted", (audits[0].details as { closedAgencyInvites?: number }).closedAgencyInvites === 4);
  check("app_errors before 0053 is reported as skipped (null)", (audits[0].details as { appErrors?: unknown }).appErrors === null);

  deleted = { push_log: 1, admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, org_invites: 0, app_errors: 0 };
  const priorAudits = audits.length;
  res = await call(`Bearer ${SECRET}`);
  check("push-only cleanup still produces its audit entry", res.status === 200 && audits.length === priorAudits + 1 && (audits.at(-1)?.details as { pushLog?: number }).pushLog === 1);

  console.log(`retention cron route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
