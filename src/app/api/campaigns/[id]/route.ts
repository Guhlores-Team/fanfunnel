import { NextResponse } from "next/server";
import { setCampaignPinnedWheel, renameCampaign, setCampaignActive, deleteCampaign } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody, statusForError as statusFor } from "@/lib/api/handler";
import { campaignPinError } from "@/lib/data/shared";
import { campaignActingSession } from "@/lib/data/campaigns";
import { demoActingCreator } from "@/lib/data/seatScope";
import { limitRoute } from "@/lib/api/limit";

// Rename a campaign, pin (or unpin) its default wheel, and/or archive or
// reactivate it (isActive). Every write is scoped to the signed-in creator,
// or (A28) to `creatorId`, a creator the caller's agency seat may manage:
// can_act_for(creatorId, 'manage') is checked before any read or write.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "campaigns/[id]:PATCH");
  if (rateLimited) return rateLimited;
  const { id } = await params;

  const body = await parseJsonBody<{ pinnedWheelId?: string | null; name?: string; isActive?: boolean; creatorId?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const hasActive = "isActive" in body;
  if (hasActive && typeof body.isActive !== "boolean") return badRequest();

  // Validate name up front (same rules as before) so a bad value is rejected
  // before any write is attempted.
  let name: string | undefined;
  if (typeof body.name === "string") {
    name = body.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  const hasPin = "pinnedWheelId" in body;
  if (hasPin && body.pinnedWheelId != null && typeof body.pinnedWheelId !== "string") return badRequest();
  const pinnedWheelId = body.pinnedWheelId ?? null;

  // Mock/in-memory path: no DB transactions exist here, so keep the original
  // per-field data-layer calls unchanged.
  if (!isSupabaseConfigured()) {
    // Demo mode has no agencies: naming a creator is refused even as a no-op.
    const refused = demoActingCreator(body.creatorId);
    if (refused) return errorResponse(refused.error);
    if (name !== undefined) {
      const result = await renameCampaign(id, name, body.creatorId);
      if ("error" in result) {
        return NextResponse.json(result, { status: statusFor(result.error) });
      }
    }
    if (hasPin) {
      const result = await setCampaignPinnedWheel(id, pinnedWheelId, body.creatorId);
      if ("error" in result) {
        return NextResponse.json(result, { status: statusFor(result.error) });
      }
    }
    if (hasActive) {
      const result = await setCampaignActive(id, body.isActive as boolean, body.creatorId);
      if ("error" in result) {
        return NextResponse.json(result, { status: statusFor(result.error) });
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Configured path: apply the rename and the pin together in a single atomic
  // UPDATE so a failure cannot leave the campaign half-updated (e.g. renamed
  // but with a stale pinned wheel, or vice versa).
  const acting = await campaignActingSession(body.creatorId);
  if ("error" in acting) return errorResponse(acting.error);
  const { sb } = acting;

  // The chosen game must be this creator's own playable game, so a campaign
  // can't be pointed at another creator's wheel id (or an archived/draft game
  // the resolver would silently skip).
  if (hasPin) {
    const pinError = await campaignPinError(sb, acting.creatorId, pinnedWheelId);
    if (pinError) return NextResponse.json({ error: pinError }, { status: statusFor(pinError) });
  }

  const patch: { name?: string; pinned_wheel_id?: string | null; is_active?: boolean } = {};
  if (name !== undefined) patch.name = name;
  if (hasPin) patch.pinned_wheel_id = pinnedWheelId;
  if (hasActive) patch.is_active = body.isActive as boolean;

  // Nothing to change — preserve the original no-op success response.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { data: updated, error } = await sb
    .from("campaigns")
    .update(patch)
    .eq("id", id)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "db_error" }, { status: 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// Delete a campaign (grants keep their history; their campaign link is cleared).
// A28: `?creatorId=<id>` deletes one of a creator the caller's seat may manage.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "campaigns/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const creatorId = new URL(req.url).searchParams.get("creatorId");
  if (creatorId !== null && creatorId.length > 64) return badRequest();
  const result = await deleteCampaign(id, creatorId ?? undefined);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
