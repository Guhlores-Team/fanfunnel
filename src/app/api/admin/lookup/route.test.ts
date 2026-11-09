import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";

// OPS-04 NEGATIVE + shape: only an active admin on two-factor may look up a
// win; a creator gets 403 and nothing is read or audited; the answer never
// carries a fan token, fan id or name, a reward code or seeds.
type Guard = "admin" | "creator" | "anonymous" | "mfa";
let guard: Guard = "creator", reads = 0, row: Record<string, unknown> | null = null;
const audits: Record<string, unknown>[] = [];
const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const FAN_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "fanTokenSECRETabcdefghijklmnop0123";
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => {
  if (guard === "admin") return { ok: true, userId: ADMIN };
  if (guard === "anonymous") return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (guard === "mfa") return { ok: false, response: NextResponse.json({ error: "mfa_required", step: "challenge" }, { status: 403 }) };
  return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
} } });
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({}),
  createServiceClient: () => ({ from: (table: string) => ({ select: () => ({ eq: () => {
    reads++;
    if (table === "profiles") return { maybeSingle: async () => ({ data: { display_name: "Creator Title", is_active: true, approval_status: "approved", email: "creator@example.com" }, error: null }) };
    return { abortSignal: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
  } }) }) }),
} });
mock.module("@/lib/data/audit", { namedExports: { recordAudit: async (e: Record<string, unknown>) => { audits.push(e); } } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
async function main() {
  const { POST } = await import("./route");
  const { parseWinReference } = await import("@/lib/data/adminLookup");
  const post = (body: unknown) => POST(new Request("http://localhost/api/admin/lookup", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

  for (const g of ["creator", "anonymous", "mfa"] as Guard[]) {
    guard = g;
    const res = await post({ query: "https://fanfunnel.vercel.app/verify/abc123def456abc123" });
    check(`${g}: refused (${res.status})`, res.status === (g === "anonymous" ? 401 : 403));
    check(`${g}: refusal is not cached`, /no-store/.test(res.headers.get("cache-control") ?? ""));
  }
  check("NEGATIVE: a creator reads nothing and writes no audit row", reads === 0 && audits.length === 0);

  guard = "admin";
  for (const bad of ["{", [], {}, { query: "x", extra: 1 }, { query: "" }, { query: "../../etc" }, { query: "a".repeat(70) }]) {
    const res = await post(bad);
    check(`bad input ${JSON.stringify(bad).slice(0, 20)} → 400`, res.status === 400);
  }
  check("bad input reads and audits nothing", reads === 0 && audits.length === 0);

  row = {
    id: "22222222-2222-4222-8222-222222222222", share_id: "abc123def456abc123", created_at: "2026-11-08T20:00:00.000Z",
    prize_label: "Signed photo", prize_rarity: "rare", game_kind: "wheel", kind: "play", creator_id: "33333333-3333-4333-8333-333333333333",
    fan_id: FAN_ID, fan_name: "Fan Name", token: TOKEN, server_seed: "seedSECRET", reward_code: "CODE-SECRET",
    redemption: [{ status: "pending", created_at: "2026-11-08T20:00:01.000Z", fulfilled_at: null }],
  };
  let res = await post({ query: "https://fanfunnel.vercel.app/verify/abc123def456abc123?x=1" });
  const text = await res.text();
  const body = JSON.parse(text);
  check("admin: found", res.status === 200 && body.win.prize === "Signed photo" && body.win.rarity === "rare" && body.win.creator.title === "Creator Title" && body.win.creator.status === "approved");
  check("admin: redemption status and timestamps", body.win.redemption.status === "pending" && body.win.redemption.createdAt === "2026-11-08T20:00:01.000Z" && body.win.redemption.fulfilledAt === null);
  check("admin: the fan still has their data", body.win.fanDeleted === false);
  check("NEGATIVE: no fan token, fan id, name, seed, code or creator e-mail in the answer", ![TOKEN, FAN_ID, "Fan Name", "seedSECRET", "CODE-SECRET", "creator@example.com", "fan_id", "token"].some((s) => text.includes(s)));
  check("admin: response is not cached", /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("audited as admin.lookup with the spin", audits.length === 1 && audits[0].action === "admin.lookup" && audits[0].actorId === ADMIN && audits[0].targetType === "spin" && audits[0].targetId === row.id && (audits[0].details as { found: boolean }).found === true);

  row = { ...row, fan_id: null, redemption: { status: "fulfilled", created_at: "2026-11-08T20:00:01.000Z", fulfilled_at: "2026-11-09T09:00:00.000Z" } };
  body.win = (await (await post({ query: "abc123def456abc123" })).json()).win;
  check("a deleted fan is reported, delivery time shown", body.win.fanDeleted === true && body.win.redemption.status === "fulfilled" && body.win.redemption.fulfilledAt === "2026-11-09T09:00:00.000Z");

  row = null;
  res = await post({ query: "/share/zzzzzzzzzzzz" });
  check("unknown → 404, still audited as not found", res.status === 404 && audits.length === 3 && (audits[2].details as { found: boolean }).found === false && audits[2].targetId === null);

  check("parse: verify link", parseWinReference("https://x.test/verify/abc_DEF-123") === "abc_DEF-123");
  check("parse: share link with slash", parseWinReference("https://x.test/share/abc123/") === "abc123");
  check("parse: bare id", parseWinReference("  abc123  ") === "abc123");
  check("parse: junk", parseWinReference("https://x.test/spin/" + TOKEN + "/x") === null && parseWinReference(42) === null && parseWinReference("a b") === null);
  console.log(`admin lookup route: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
