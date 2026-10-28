import { NextResponse } from "next/server";
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { mockReconcileCreatorRequest } from "@/lib/data/mock";
import { isUuid } from "@/lib/data/shared";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { rateLimitOr429 } from "@/lib/api/limit";
import { isCreatorRequestKind, readCreatorRequestResult, type CreatorRequestKind } from "@/lib/creatorRequests";

type Context = { params: Promise<{ id: string }> };
const CHECKS_PER_MINUTE = 30;
type ReconcileRpc = { rpc(name: "reconcile_creator_request", args: { p_request: string; p_creator: string | null; p_actor: string; p_kind: CreatorRequestKind; p_cancel: boolean; p_authorized: boolean }): PromiseLike<{ data: unknown; error: unknown }> };
async function reconcile(id: string, kind: CreatorRequestKind, creatorId: string | undefined, cancel: boolean) {
  if (!isSupabaseConfigured()) {
    const result = readCreatorRequestResult(await mockReconcileCreatorRequest(id, kind, cancel), id, kind);
    return result ? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "request_pending" }, { status: 503 });
  }
  const session = await createClient();
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await rateLimitOr429("creator-request:" + user.id, CHECKS_PER_MINUTE, 60_000);
  if (limited) return limited;
  // Only the original actor's metadata can infer a target after a reload. No
  // hash, fan details, token or economic payload is read here.
  if (!creatorId) {
    const { data: ownRequest, error } = await session.from("creator_request_journal").select("creator_id").eq("id", id).eq("actor_id", user.id).maybeSingle();
    if (error) return NextResponse.json({ error: "request_pending" }, { status: 503 });
    creatorId = ownRequest?.creator_id ?? undefined;
  }
  let authorized = false;
  if (creatorId) {
    const { data: permitted, error } = await session.rpc("can_act_for", { target_creator: creatorId, perm: "grant" });
    authorized = !error && permitted === true;
  }
  // Unknown context never becomes an assumed own-account operation. The actor
  // fence can safely cancel that actor's UUID across scopes; a prior actor may
  // receive a bare outcome after permission loss, never a business receipt.
  const service = createServiceClient() as unknown as ReconcileRpc;
  const { data, error } = await service.rpc("reconcile_creator_request", { p_request: id, p_creator: creatorId ?? null, p_actor: user.id, p_kind: kind, p_cancel: cancel, p_authorized: authorized });
  const result = !error ? readCreatorRequestResult(data, id, kind) : null;
  if (!result) return NextResponse.json({ error: "request_pending" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
export async function GET(req: Request, { params }: Context) {
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const kind = query.get("kind"), creatorId = query.get("creatorId") ?? undefined;
  if (!isUuid(id) || !isCreatorRequestKind(kind) || (creatorId !== undefined && !isUuid(creatorId))) return badRequest();
  try { return await reconcile(id, kind, creatorId, false); }
  catch { return NextResponse.json({ error: "request_pending" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export async function POST(req: Request, { params }: Context) {
  const { id } = await params;
  const body = await parseJsonBody<{ kind?: unknown; creatorId?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body) || !isUuid(id) || !isCreatorRequestKind(body.kind) || (body.creatorId !== undefined && (typeof body.creatorId !== "string" || !isUuid(body.creatorId)))) return badRequest();
  try { return await reconcile(id, body.kind, typeof body.creatorId === "string" ? body.creatorId : undefined, true); }
  catch { return NextResponse.json({ error: "request_pending" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
