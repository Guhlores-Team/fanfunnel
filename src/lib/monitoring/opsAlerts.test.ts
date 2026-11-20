import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";

// OPS-05, N7, OPS-16: failures that used to be only a console line reach
// Admin › Errors (and the alert path) with a fixed, token-free message.
const captured: { message: string; route?: string | null }[] = [];
mock.module("@/lib/monitoring/capture", { namedExports: { captureAfterResponse: (input: { message: string; route?: string | null }) => { captured.push(input); } } });
let insertError: { message: string } | null = { message: "permission denied for fan@example.com" };
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({}),
    createServiceClient: () => ({ from: () => ({ insert: async () => ({ error: insertError }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), update: () => ({ eq: () => ({ eq: async () => ({}) }) }) }) }),
  },
});
let pushStatus = 500;
mock.module("web-push", { defaultExport: { sendNotification: async () => { throw Object.assign(new Error("push service said no to https://fcm.googleapis.com/fcm/send/SECRET"), { statusCode: pushStatus }); } } });
mock.module("@/lib/push/keys", { namedExports: { vapidKeys: () => ({ publicKey: "p", privateKey: "k", subject: "mailto:a@b.c" }) } });

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const SECRETS = /@|SECRET|token|https?:/i;

async function main() {
  const ops = await import("./opsAlerts");
  const local: string[] = [];
  const cap = (i: { message: string }) => { local.push(i.message); };

  for (const kind of ["approval", "agency_invite", "application_alert"] as const) {
    ops.reportAccountMail(kind, "sent", cap);
    ops.reportAccountMail(kind, "skipped", cap);
    check(`${kind}: sent/skipped are not errors`, local.length === 0);
    ops.reportAccountMail(kind, "failed", cap);
    check(`${kind}: a failed send is captured with a fixed message`, local.pop() === ops.ACCOUNT_MAIL_FAILED[kind] && !SECRETS.test(ops.ACCOUNT_MAIL_FAILED[kind]));
  }
  check("audit message keeps a code action", ops.auditNotWrittenMessage("account.role_change").endsWith("(account.role_change)"));
  check("audit message never echoes free text", ops.auditNotWrittenMessage("x@y.z <script>") .endsWith("(unknown action)"));
  let allowed = true;
  ops.reportPushFailure(cap, () => allowed);
  allowed = false;
  ops.reportPushFailure(cap, () => allowed);
  check("push failure captured once while throttled", local.length === 1 && local[0] === ops.PUSH_FAILED);

  // Wiring: the real call sites.
  captured.length = 0;
  const { recordAudit } = await import("@/lib/data/audit");
  await recordAudit({ actorId: null, action: "account.suspend" });
  check("OPS-16: a failed audit insert is captured", captured.length === 1 && captured[0].message === ops.auditNotWrittenMessage("account.suspend") && !SECRETS.test(captured[0].message));
  insertError = null;
  await recordAudit({ actorId: null, action: "account.suspend" });
  check("a written audit row captures nothing", captured.length === 1);

  captured.length = 0;
  const { deliverPush } = await import("@/lib/push/send");
  const target = { id: "d1", endpoint: "https://fcm.googleapis.com/fcm/send/SECRET", p256dh: "x", auth: "y" };
  const payload = { title: "t", body: "b", tag: "tag", url: "/dashboard" } as Parameters<typeof deliverPush>[1];
  check("N7: a 500 is a failure", (await deliverPush(target, payload)) === "failed");
  check("N7: and is captured without the endpoint", captured.length === 1 && captured[0].message === ops.PUSH_FAILED && !SECRETS.test(captured[0].message));
  pushStatus = 410;
  check("a 410 is a prune", (await deliverPush(target, payload)) === "gone");
  check("a prune is not captured", captured.length === 1);

  const admin = readFileSync("src/lib/data/admin.ts", "utf8");
  for (const kind of ["approval", "application_alert"]) {
    check(`OPS-05: the ${kind} send reports its result`, new RegExp(`runAfterResponse\\(async \\(\\) => reportAccountMail\\("${kind}", await send`).test(admin));
  }
  // B2 decides whether the agency invite is sent at all; a refused send still reports.
  check("OPS-05: the agency_invite send reports its result", /await deliverAgencyInviteEmail\([^)]*\);\s*if \(outcome === "failed"\) reportAccountMail\("agency_invite", "failed"\)/.test(admin));
  check("OPS-05: no account mail result is discarded", !/runAfterResponse\(\(\) => (send(Approval|AgencyInvite|Application)|deliverAgencyInviteEmail)/.test(admin));
  console.log(`opsAlerts: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
