import assert from "node:assert";
import { mock } from "node:test";

// Admin › Reports data layer (A1), both paths.
//   - demo: a fan's report lands in the shared store with its creator and fan
//     context, urgent reasons are flagged, filters and the keyset cursor reach
//     every report, and resolve / dismiss / reopen follow the 0064 stamping
//     rules (note kept on review, cleared on reopen, actor from the server);
//   - Supabase: reads and reviews run on the caller's session client (RLS is
//     the second gate), never the service role, and a review only ever sends
//     status + note (who/when are stamped by the database).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Call = { table: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
let useSupabase = false;
let sessionClients = 0;
const REPORT_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  reason: "Inappropriate photo",
  detail: "private words",
  status: "resolved",
  created_at: "2026-10-29T10:00:00.000Z",
  resolved_at: "2026-10-29T11:00:00.000Z",
  resolution_note: "removed",
  token: "abcdefghijklmnop",
  creator_id: "c1",
  fan_id: "f1",
  creator: { display_name: "Bella", email: "bella@example.com", public_slug: "bella" },
  fan: { display_name: "Sam", handle: null },
};
function recorder() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const head = call.ops.some(([op, a]) => op === "select" && (a[1] as { head?: boolean } | undefined)?.head);
              const res = head ? { data: null, count: 2, error: null } : { data: [REPORT_ROW], count: null, error: null };
              return (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok);
            }
            if (prop === "maybeSingle") {
              return () => {
                call.ops.push(["maybeSingle", []]);
                return Promise.resolve({ data: REPORT_ROW, error: null });
              };
            }
            return (...args: unknown[]) => {
              call.ops.push([prop, args]);
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
}
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => {
      sessionClients++;
      return recorder();
    },
    createServiceClient: () => {
      if (useSupabase) throw new Error("Admin › Reports must not use the service role");
      return recorder();
    },
  },
});

async function main() {
  const data = await import("./index");
  const reports = await import("./reports");
  const m = await import("./mock");
  const { resetMockReports } = await import("./mockReports");

  // --- demo path ---------------------------------------------------------------
  resetMockReports();
  const fan = m.mockCreatePass("Report Fan", 1);
  m.mockAckFan(fan.token);
  check("demo: a fan can report", "ok" in (await data.reportCreator(fan.token, "Inappropriate photo", "the gallery photo")));
  await new Promise((r) => setTimeout(r, 5)); // distinct created_at, so "newest first" is deterministic
  check("demo: another report", "ok" in (await data.reportCreator(fan.token, "Not delivering won prizes")));
  check("demo: an unknown link can't report", "error" in (await data.reportCreator("no-such-token", "Other")));

  const open = await reports.listReports({ status: "open" });
  assert.ok(!("error" in open));
  check("demo: both open reports are listed, newest first", open.reports.length === 2 && open.reports[0].reason === "Not delivering won prizes");
  check("demo: open counts", open.openCount === 2 && open.urgentOpenCount === 1);
  const photo = open.reports.find((r) => r.reason === "Inappropriate photo")!;
  check("demo: a photo report is urgent", photo.urgent === true);
  check("demo: a delivery report is not urgent", open.reports[0].urgent === false);
  check("demo: the reported creator is named", photo.creator.id === "acc-you" && photo.creator.name.length > 0);
  check("demo: the reporting fan is named", photo.fan?.name === "Report Fan");
  check("demo: only a link hint, never the link", photo.linkHint === `…${fan.token.slice(-4)}` && !JSON.stringify(photo).includes(fan.token));
  check("demo: the fan's words are there for the admin", photo.detail === "the gallery photo");

  const byReason = await reports.listReports({ status: "all", reason: "Inappropriate photo" });
  check("demo: reason filter", !("error" in byReason) && byReason.reports.length === 1 && byReason.reports[0].id === photo.id);

  const first = await reports.listReports({ status: "open" }, null, 1);
  assert.ok(!("error" in first));
  check("demo: a short page offers a cursor", first.reports.length === 1 && first.next !== null);
  const second = await reports.listReports({ status: "open" }, first.next, 1);
  assert.ok(!("error" in second));
  check("demo: the cursor reaches the next report", second.reports.length === 1 && second.reports[0].id !== first.reports[0].id && second.next === null);

  const resolved = await reports.reviewReport(photo.id, "resolved", "Removed the photos.", "admin-1");
  check("demo: resolve", "ok" in resolved && resolved.report.status === "resolved" && resolved.report.resolutionNote === "Removed the photos." && !!resolved.report.resolvedAt);
  const afterResolve = await reports.listReports({ status: "open" });
  check("demo: a resolved report leaves the open list and the counts", !("error" in afterResolve) && afterResolve.reports.length === 1 && afterResolve.openCount === 1 && afterResolve.urgentOpenCount === 0);
  check("demo: open count for the badge", (await reports.countOpenReports()) === 1);
  const reopened = await reports.reviewReport(photo.id, "open", "ignored", "admin-1");
  check("demo: reopen clears the review", "ok" in reopened && reopened.report.status === "open" && reopened.report.resolvedAt === null && reopened.report.resolutionNote === null);
  const dismissed = await reports.reviewReport(photo.id, "dismissed", null, "admin-1");
  check("demo: dismiss", "ok" in dismissed && dismissed.report.status === "dismissed");
  check("demo: an unknown report is not_found", "error" in (await reports.reviewReport("22222222-2222-4222-8222-222222222222", "resolved", null, null)));

  // --- Supabase path -------------------------------------------------------------
  useSupabase = true;
  calls.length = 0;
  const page = await reports.listReports({ status: "resolved", reason: "Inappropriate photo" });
  assert.ok(!("error" in page));
  check("supabase: reads on the session client", sessionClients > 0);
  const listCall = calls.find((c) => c.table === "creator_reports" && c.ops.some(([op]) => op === "order"));
  check("supabase: status and reason filters", !!listCall?.ops.some(([op, a]) => op === "eq" && a[0] === "status" && a[1] === "resolved") && !!listCall?.ops.some(([op, a]) => op === "eq" && a[0] === "reason" && a[1] === "Inappropriate photo"));
  check("supabase: maps the joined context", page.reports[0].creator.name === "Bella" && page.reports[0].creator.publicSlug === "bella" && page.reports[0].fan?.name === "Sam");
  check("supabase: only a link hint", page.reports[0].linkHint === "…mnop" && !JSON.stringify(page).includes("abcdefghijklmnop"));
  check("supabase: exact counts", page.openCount === 2 && page.urgentOpenCount === 2);

  calls.length = 0;
  const reviewed = await reports.reviewReport(REPORT_ROW.id, "resolved", "removed", "spoofed-actor");
  check("supabase: review succeeds", "ok" in reviewed);
  const upd = calls.find((c) => c.ops.some(([op]) => op === "update"));
  const patch = upd?.ops.find(([op]) => op === "update")?.[1][0] as Record<string, unknown>;
  check("supabase: a review sends only status and note", JSON.stringify(Object.keys(patch ?? {}).sort()) === '["resolution_note","status"]');
  check("supabase: who/when are left to the database", !("resolved_by" in (patch ?? {})) && !("resolved_at" in (patch ?? {})));

  calls.length = 0;
  await reports.reviewReport(REPORT_ROW.id, "open", "dropped", null);
  const reopenPatch = calls.find((c) => c.ops.some(([op]) => op === "update"))?.ops.find(([op]) => op === "update")?.[1][0] as Record<string, unknown>;
  check("supabase: reopen clears the note", reopenPatch?.resolution_note === null && reopenPatch?.status === "open");

  console.log(`reports.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
