import assert from "node:assert/strict";

// OPS-04: Activity log filter and "Load older" paging (demo store; the guard,
// isActiveAdmin and RLS refusals are covered by adminMfa.test.ts / audit.test.ts).
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
async function main() {
  const { recordAudit } = await import("@/lib/data/audit");
  const { GET, AUDIT_PAGE } = await import("./route");
  for (let i = 0; i < AUDIT_PAGE + 10; i++) await recordAudit({ actorId: null, action: i % 3 === 0 ? "account.suspend" : "error.resolve" });
  await recordAudit({ actorId: null, action: "account.mfa_reset" });
  const get = async (q = "") => { const r = await GET(new Request(`http://localhost/api/admin/audit${q}`)); return { status: r.status, cache: r.headers.get("cache-control") ?? "", body: await r.json() as { entries: { action: string; createdAt: string; id: string }[]; more: boolean } } };

  const first = await get();
  check("first page is one page, newest first, with more", first.status === 200 && first.body.entries.length === AUDIT_PAGE && first.body.more === true && first.body.entries[0].action === "account.mfa_reset" && /no-store/.test(first.cache));
  const last = first.body.entries[first.body.entries.length - 1];
  const second = await get(`?before=${encodeURIComponent(last.createdAt)}`);
  const seen = new Set(first.body.entries.map((e) => e.id));
  check("Load older continues without overlap", second.body.entries.length === 11 && second.body.more === false && second.body.entries.every((e) => !seen.has(e.id) && e.createdAt < last.createdAt));
  const byCode = await get("?action=suspend");
  check("filter by code text", byCode.body.entries.length === 20 && byCode.body.entries.every((e) => e.action === "account.suspend"));
  const byLabel = await get(`?action=${encodeURIComponent("two-factor")}`);
  check("filter by readable label", byLabel.body.entries.length === 1 && byLabel.body.entries[0].action === "account.mfa_reset");
  check("no match is an empty page", (await get("?action=nothing-like-this")).body.entries.length === 0);
  for (const bad of ["?action=%25%27%3B--", "?action=" + "a".repeat(41), "?before=yesterday", "?before=2026-11-09T10:00:00Z%27"]) {
    check(`bad ${bad.slice(0, 24)} → 400`, (await get(bad)).status === 400);
  }
  console.log(`admin audit route: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
