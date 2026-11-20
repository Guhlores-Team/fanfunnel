import assert from "node:assert/strict";
import { mock } from "node:test";

// PR-07 / PR-15 (demo store): the three CSV exports are attachments with
// formula-safe cells and bounded inputs; "Send test" delivers a marked
// sample payload for the creator's own webhook only.
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => false, createClient: async () => { throw new Error("demo"); }, createServiceClient: () => { throw new Error("demo"); } } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null, limitRoute: async () => null } });
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const m = await import("@/lib/data/mock");
  const fans = await import("./fans/export/route");
  const wins = await import("./redemptions/export/route");
  const daily = await import("./metrics/export/route");
  const test = await import("./webhooks/[id]/test/route");
  const { webhookTestPayload } = await import("@/lib/data/webhooks");

  m.mockCreatePass('=HYPERLINK("http://evil")', 2);
  let res = await fans.GET(new Request("http://localhost/api/fans/export"));
  // Response.text() strips the BOM; the bytes carry it for Excel.
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  check("the file starts with a UTF-8 BOM", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  let body = await res.text();
  check("fans export is a CSV attachment", res.status === 200 && /text\/csv/.test(res.headers.get("content-type") ?? "") && /attachment; filename="fanfunnel-fans-\d{4}-\d{2}-\d{2}\.csv"/.test(res.headers.get("content-disposition") ?? ""));
  check("fans export has the header row and a formula-safe fan name", body.startsWith('"Fan","Spins left"') && body.includes('"\'=HYPERLINK(""http://evil"")"') && !/\r\n"=HYPERLINK/.test(body));

  res = await wins.GET(new Request("http://localhost/api/redemptions/export?status=bogus"));
  check("an unknown status is a 400", res.status === 400);
  res = await wins.GET(new Request("http://localhost/api/redemptions/export?status=pending"));
  body = await res.text();
  const lines = body.trim().split("\r\n");
  check("the queue export is a CSV with the header and only pending rows", res.status === 200 && lines[0] === '"Fan","Prize","Rarity","Status","Won at","Due date","Notes","Game","Win id"' && lines.slice(1).every((l) => l.includes('"pending"')));
  res = await wins.GET(new Request("http://localhost/api/redemptions/export"));
  check("without a status every win is exported", res.status === 200 && (await res.text()).split("\r\n").length >= lines.length);

  res = await daily.GET(new Request("http://localhost/api/metrics/export?days=14"));
  body = await res.text();
  const dayLines = body.trim().split("\r\n");
  check("the daily export has one row per day", res.status === 200 && dayLines[0] === '"Date (UTC)","Spins","Tips recorded (USD)"' && dayLines.length === 15 && /^"\d{4}-\d{2}-\d{2}","\d+","\d+\.\d{2}"$/.test(dayLines[1]));
  res = await daily.GET(new Request("http://localhost/api/metrics/export?days=9999"));
  check("days is clamped to 90", res.status === 200 && (await res.text()).trim().split("\r\n").length === 91);

  const payload = webhookTestPayload("all", new Date("2026-11-10T00:00:00Z"));
  check("a test payload is marked and shaped like a win", payload.event === "prize_pending" && payload.test === true && typeof payload.win === "object");
  const hook = m.mockCreateWebhook("https://example.com/hook", "all");
  assert.ok("id" in hook, "the demo webhook was created");
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  res = await test.POST(new Request("http://localhost/api/webhooks/x/test", { method: "POST" }), params(hook.id));
  const out = (await res.json()) as { ok?: boolean; status?: number; signed?: boolean; event?: string };
  check("demo: a test delivery answers delivered + signed without leaving the machine", res.status === 200 && out.ok === true && out.status === 200 && out.signed === true && out.event === "prize_pending");
  res = await test.POST(new Request("http://localhost/api/webhooks/x/test", { method: "POST" }), params("wh-nope"));
  check("an unknown webhook is a 404", res.status === 404);
  console.log(`exports + webhook test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
