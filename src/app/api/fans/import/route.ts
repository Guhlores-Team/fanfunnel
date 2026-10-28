import { NextResponse } from "next/server";
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { mockImportFans } from "@/lib/data/mock";
import { isUuid } from "@/lib/data/shared";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { IMPORT_MAX_ROWS, importRequestHash, normalizeImportRows, type ImportBatchResult, type ImportSlot } from "@/lib/imports/batch";

const ROW_ERRORS = new Set(["missing_name", "invalid_spins", "spins_too_large", "invalid_amount", "amount_too_large", "no_wheel", "campaign_not_found", "invalid_pack", "blocked", "on_break", "gone"]);
type ServiceRpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
function receipt(value: unknown, batchId: string, count: number): value is Extract<ImportBatchResult, { status: "imported" }> {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== "imported" || !("replayed" in value) || typeof value.replayed !== "boolean" || !("batchId" in value) || value.batchId !== batchId || !("items" in value) || !Array.isArray(value.items) || value.items.length !== count) return false;
  const ordinals = new Set<number>();
  for (const item of value.items) {
    if (!item || typeof item !== "object" || !Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= count || ordinals.has(item.ordinal)) return false;
    ordinals.add(item.ordinal);
    if (item.error !== undefined ? !ROW_ERRORS.has(item.error) : typeof item.token !== "string" || typeof item.fanId !== "string" || typeof item.passId !== "string" || typeof item.grantId !== "string") return false;
  }
  return true;
}
async function transact(batchId: string, creatorId: string, actorId: string, rows: ImportSlot[], requestHash: string): Promise<unknown> {
  const service = createServiceClient() as unknown as ServiceRpc;
  const args = { p_batch: batchId, p_creator: creatorId, p_request_hash: requestHash, p_rows: rows, p_actor: actorId };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await service.rpc("import_fans_durable", args);
      if (!error) return data;
      // A known statement failure already rolls its entire transaction back.
      // An ambiguous transport failure is retried with exactly the same key.
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code && !error.code.startsWith("PGRST")) return null;
    } catch { /* Preserve intent; never mint a replacement batch or compensate. */ }
  }
  return null;
}

/** Atomic, durable import of the valid subset, preserving ordered row errors. */
export async function POST(req: Request) {
  const configured = isSupabaseConfigured();
  const session = configured ? await createClient() : null;
  const userResult = session ? await session.auth.getUser() : null;
  const user = userResult?.data.user;
  if (session && (userResult?.error || !user)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await rateLimitOr429("fan-import:" + (user?.id ?? clientIp(req)), 5, 60 * 1000);
  if (limited) return limited;
  const body = await parseJsonBody<{ rows?: unknown; batchId?: unknown; creatorId?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body)) return badRequest();
  if (!Array.isArray(body.rows) || body.rows.length === 0) return badRequest();
  if (body.rows.length > IMPORT_MAX_ROWS) return badRequest("too_many_rows");
  if (body.batchId === undefined) return badRequest("upgrade_required");
  if (typeof body.batchId !== "string" || !isUuid(body.batchId) || body.batchId !== body.batchId.toLowerCase()) return badRequest();
  if (body.creatorId !== undefined && (typeof body.creatorId !== "string" || !isUuid(body.creatorId))) return badRequest();
  const batchId = body.batchId;
  const creatorId = typeof body.creatorId === "string" ? body.creatorId : user?.id;
  if (session && creatorId) {
    const { data: permitted, error } = await session.rpc("can_act_for", { target_creator: creatorId, perm: "grant" });
    if (error || permitted !== true) return NextResponse.json({ error: "forbidden", batchId }, { status: 403 });
  }
  const slots = normalizeImportRows(body.rows);
  const requestHash = await importRequestHash(slots);
  let result: unknown;
  try { result = configured && creatorId ? await transact(batchId, creatorId, user!.id, slots, requestHash) : await mockImportFans(batchId, requestHash, slots); }
  catch { result = null; }
  if (result && typeof result === "object" && "status" in result && result.status === "conflict") return NextResponse.json({ error: "conflict", batchId }, { status: 409 });
  if (result && typeof result === "object" && "status" in result && result.status === "unavailable") return NextResponse.json({ error: "forbidden", batchId }, { status: 403 });
  if (!receipt(result, batchId, slots.length)) return NextResponse.json({ error: "import_pending", batchId }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const byOrdinal = new Map(result.items.map(item => [item.ordinal, item]));
  const results = slots.map((slot, ordinal) => {
    const item = byOrdinal.get(ordinal)!;
    return item.error ? { name: slot.name, error: item.error } : { name: slot.name, token: item.token };
  });
  const failed = results.filter(item => "error" in item).length;
  return NextResponse.json({ batchId, replayed: result.replayed === true, created: results.length - failed, failed, results }, { headers: { "Cache-Control": "no-store" } });
}
