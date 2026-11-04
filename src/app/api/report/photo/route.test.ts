import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase } from "@/lib/data/fakeSupabase";

// A31: a visitor reports a photo on a public /c/<slug> page without a spin
// link. Negative tests: the stored report carries no fan, no token and nothing
// from the request but the page, photo and note (never an IP, never a reason
// the caller chose); another creator's photo, an unknown page and bad input
// are refused with nothing written; the per-visitor and per-page limits hold.
const CREATOR = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const PHOTO = "c0000000-0000-4000-8000-000000000003";
const FOREIGN_PHOTO = "d0000000-0000-4000-8000-000000000004";
const db = new FakeSupabase(CREATOR);
let useSupabase = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createServiceClient: () => db.client(),
    createClient: async () => { throw new Error("a public report never uses a session"); },
  },
});
const alerts: unknown[] = [];
mock.module("@/lib/reports/alert", { namedExports: { alertUrgentReport: async (r: unknown) => { alerts.push(r); } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (fn: () => unknown) => { void fn(); } } });

let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };

async function main() {
  for (const t of ["profiles", "creator_media", "creator_reports"]) db.tables[t] = [];
  db.seed("profiles", { id: CREATOR, public_slug: "bella" });
  db.seed("profiles", { id: OTHER, public_slug: "other" });
  db.seed("creator_media", { id: PHOTO, creator_id: CREATOR });
  db.seed("creator_media", { id: FOREIGN_PHOTO, creator_id: OTHER });
  const { POST } = await import("./route");
  const { PHOTO_REPORTS_PER_IP, PHOTO_REPORTS_PER_PAGE } = await import("@/lib/data/publicReports");
  const { PHOTO_REPORT_REASON } = await import("@/lib/creatorTheme/config");
  let ip = 0;
  const post = (body: unknown, from = `198.51.100.${++ip}`) =>
    POST(new Request("http://localhost/api/report/photo", { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": from }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const reports = () => db.rows("creator_reports");

  let res = await post({ slug: "bella", mediaId: PHOTO, note: "Not safe for work", reason: "Other", token: "tok-1", fanId: "fan-1" }, "203.0.113.9");
  check("a visitor can report a photo: 200", res.status === 200);
  const body = await res.json();
  check("the response says only ok", JSON.stringify(body) === '{"ok":true}');
  check("one report stored", reports().length === 1);
  const row = reports()[0];
  check("the report is against the page's creator", row.creator_id === CREATOR);
  check("the reason is fixed server-side (a sent reason is ignored)", row.reason === PHOTO_REPORT_REASON);
  check("no fan and no token are stored (a sent token is ignored)", row.fan_id === null && row.token === null);
  check("the detail names the page and photo, with the note", String(row.detail).includes("/c/bella") && String(row.detail).includes(PHOTO) && String(row.detail).includes("Not safe for work"));
  check("nothing identifying the visitor is stored", !JSON.stringify(row).includes("203.0.113.9"));
  check("the urgent alert carries reason and time only", alerts.length === 1 && Object.keys(alerts[0] as object).sort().join(",") === "at,reason");

  // Refusals write nothing.
  const before = reports().length;
  res = await post({ slug: "bella", mediaId: FOREIGN_PHOTO });
  check("another creator's photo on this page is 404", res.status === 404);
  res = await post({ slug: "nobody", mediaId: PHOTO });
  check("an unknown page is 404", res.status === 404);
  for (const [label, bad] of [
    ["not JSON", "nope"],
    ["no photo", { slug: "bella" }],
    ["a non-string photo id", { slug: "bella", mediaId: { $ne: null } }],
    ["a slug with odd characters", { slug: "../bella", mediaId: PHOTO }],
    ["an oversized note", { slug: "bella", mediaId: PHOTO, note: "x".repeat(501) }],
  ] as const) {
    res = await post(bad);
    check(`${label} is 400`, res.status === 400);
  }
  check("no refused request stored a report", reports().length === before);

  // Per-visitor limit.
  let last = 200;
  for (let i = 0; i < PHOTO_REPORTS_PER_IP + 1; i++) last = (await post({ slug: "bella", mediaId: PHOTO }, "192.0.2.50")).status;
  check(`report ${PHOTO_REPORTS_PER_IP + 1} from one visitor in 10 minutes is 429`, last === 429);

  // Junk can't use up a page's budget: refused requests from many visitors
  // (an unknown photo, another creator's photo) leave genuine reports working.
  db.seed("profiles", { id: "e1000000-0000-4000-8000-000000000007", public_slug: "junked" });
  db.seed("creator_media", { id: "f1000000-0000-4000-8000-000000000008", creator_id: "e1000000-0000-4000-8000-000000000007" });
  const junk: number[] = [];
  for (let i = 0; i < PHOTO_REPORTS_PER_PAGE + 5; i++) {
    junk.push((await post({ slug: "junked", mediaId: i % 2 ? FOREIGN_PHOTO : "f1000000-0000-4000-8000-0000000000ff" }, `10.8.${i}.1`)).status);
  }
  check("junk reports on a page are refused (404)", junk.every((s) => s === 404));
  res = await post({ slug: "junked", mediaId: "f1000000-0000-4000-8000-000000000008" }, "10.8.250.1");
  check("after a flood of junk, a genuine report on that page still goes through", res.status === 200);

  // Per-page limit: many visitors cannot flood one creator's queue.
  db.seed("profiles", { id: "e0000000-0000-4000-8000-000000000005", public_slug: "flooded" });
  db.seed("creator_media", { id: "f0000000-0000-4000-8000-000000000006", creator_id: "e0000000-0000-4000-8000-000000000005" });
  const statuses: number[] = [];
  for (let i = 0; i < PHOTO_REPORTS_PER_PAGE + 1; i++) statuses.push((await post({ slug: "flooded", mediaId: "f0000000-0000-4000-8000-000000000006" }, `10.9.${i}.1`)).status);
  check(`report ${PHOTO_REPORTS_PER_PAGE + 1} on one page in an hour is 429`, statuses.at(-1) === 429 && statuses.slice(0, -1).every((s) => s === 200));

  // Demo parity: same store as fan reports, no fan/token.
  useSupabase = false;
  const { mockReportStore } = await import("@/lib/data/mockReports");
  const { mockAddMedia } = await import("@/lib/data/mockTheme");
  res = await post({ slug: "demo", mediaId: "no-such-photo" });
  check("demo: an unknown photo is 404", res.status === 404 && mockReportStore().length === 0);
  const added = mockAddMedia({ webp: Buffer.alloc(1), caption: null, width: 1, height: 1 });
  assert.ok(!("error" in added));
  res = await post({ slug: "demo", mediaId: added.id });
  const demoRow = mockReportStore()[0];
  check("demo: the report lands in the shared queue with no fan or token", res.status === 200 && mockReportStore().length === 1 && demoRow.fanId === null && demoRow.token === null && demoRow.reason === PHOTO_REPORT_REASON);

  console.log(`public photo report: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
