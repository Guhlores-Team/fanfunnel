import { issueCreatorActorContext } from "@/lib/auth/creatorActorContext";
import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { initializeCanaryForAdmin, readCanary } from "@/lib/operations/canary";
import { readHealthSummary, reportOperationalFailure, runOperationalChecks } from "@/lib/operations/runtime";
import { readCappedText } from "@/lib/monitoring/report";
import { rateLimitOr429 } from "@/lib/api/limit";
import { recordAudit } from "@/lib/data/audit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { hasSharedRateLimitStore } from "@/lib/rateLimit";

const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: NO_STORE_HEADERS });
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) admin.response.headers.set("Cache-Control", "no-store");
  if (!admin.ok) return admin.response;
  if (!isSupabaseConfigured()) return json({ demo: true, canary: { status: "demo" }, summary: null });
  const limited = await rateLimitOr429(`system-health:read:${admin.userId}`, 20, 60_000);
  if (limited) { limited.headers.set("Cache-Control", "no-store"); return limited; }
  let svc: ReturnType<typeof createServiceClient>;
  try { svc = createServiceClient(); }
  catch { return json({ demo: false, canary: { status: "unavailable" }, summary: null }, 503); }
  const [canary, summary] = await Promise.all([readCanary(svc), readHealthSummary(svc)]);
  return json({ demo: false, canary, summary, rateLimitStore: hasSharedRateLimitStore() ? "shared" : "per_instance" });
}
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) admin.response.headers.set("Cache-Control", "no-store");
  if (!admin.ok) return admin.response;
  const raw = await readCappedText(req, 1024);
  if (raw === "too_large") return json({ error: "bad_request" }, 400);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request" }, 400);
  const value = body as Record<string, unknown>;
  if (!Object.keys(value).every(key => ["action", "keysBackedUp"].includes(key)) || !["run-checks", "initialize-canary"].includes(String(value.action))) return json({ error: "bad_request" }, 400);
  if (!isSupabaseConfigured()) return json({ error: "connected_database_required", demo: true }, 409);
  const limited = await rateLimitOr429(`system-health:write:${admin.userId}`, 3, 60_000);
  if (limited) { limited.headers.set("Cache-Control", "no-store"); return limited; }
  if (value.action === "run-checks") {
    const health = await runOperationalChecks("manual");
    return json(health, health.ok ? 200 : 503);
  }
  if (value.keysBackedUp !== true || !admin.userId) return json({ error: "key_backup_confirmation_required" }, 400);
  let svc: ReturnType<typeof createServiceClient>;
  try { svc = createServiceClient(); }
  catch { return json({ ok: false, canary: { status: "unavailable" }, outcome: "unavailable" }, 503); }
  const result = await initializeCanaryForAdmin(svc, admin.userId, async () => issueCreatorActorContext(await createClient(), admin.userId, "system_health"));
  if (result.outcome === "initialized" && result.status === "healthy") {
    await recordAudit({ actorId: admin.userId, action: "system.canary.initialize", details: { inventoryRows: result.inventoryRows ?? 0 } });
  }
  if (result.status !== "healthy") await reportOperationalFailure(result);
  const status = result.status === "healthy" ? 200 : result.outcome === "forbidden" ? 403 : result.status === "unavailable" ? 503 : 409;
  return json({ ok: result.status === "healthy", canary: { status: result.status }, outcome: result.outcome }, status);
}
