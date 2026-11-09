import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { rateLimitOr429 } from "@/lib/api/limit";
import { readCappedText } from "@/lib/monitoring/report";
import { recordAudit } from "@/lib/data/audit";
import { lookupWin, parseWinReference } from "@/lib/data/adminLookup";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// OPS-04: Admin › "Look up a win". POST {query: "<verify link or share id>"}
// → a read-only view of that win for support. Admins on a two-factor session
// only (requireAdminRoute: is_admin() + aal2); every lookup, found or not, is
// audited as admin.lookup. POST, not GET, so the reference stays out of URLs
// and logs, and the proxy's same-origin check applies.
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: NO_STORE_HEADERS });

export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) {
    admin.response.headers.set("Cache-Control", "no-store");
    return admin.response;
  }
  const limited = await rateLimitOr429(`admin-lookup:${admin.userId ?? "demo"}`, 30, 60_000);
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  const raw = await readCappedText(req, 1024);
  if (raw === "too_large") return json({ error: "bad_request" }, 400);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "query")) return json({ error: "bad_request" }, 400);
  const shareId = parseWinReference((body as { query?: unknown }).query);
  if (!shareId) return json({ error: "invalid_reference" }, 400);
  const result = await lookupWin(shareId);
  if (result === "error") return json({ error: "lookup_failed" }, 503);
  await recordAudit({
    actorId: admin.userId,
    action: "admin.lookup",
    targetType: result?.spinId ? "spin" : null,
    targetId: result?.spinId ?? null,
    details: { found: !!result },
  });
  if (!result) return json({ error: "not_found" }, 404);
  return json({ win: result.win });
}
