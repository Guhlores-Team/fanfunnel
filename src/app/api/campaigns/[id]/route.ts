import { NextResponse } from "next/server";
import { setCampaignPinnedWheel, renameCampaign, deleteCampaign } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { campaignPinError } from "@/lib/data/shared";

const statusFor = (e: string) =>
  e === "unauthorized" ? 401 : e === "not_found" ? 404 : 400;

// Rename a campaign and/or pin (or unpin) its default wheel.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await parseJsonBody<{ pinnedWheelId?: string | null; name?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

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
    if (name !== undefined) {
      const result = await renameCampaign(id, name);
      if ("error" in result) {
        return NextResponse.json(result, { status: statusFor(result.error) });
      }
    }
    if (hasPin) {
      const result = await setCampaignPinnedWheel(id, pinnedWheelId);
      if ("error" in result) {
        return NextResponse.json(result, { status: statusFor(result.error) });
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Configured path: apply the rename and the pin together in a single atomic
  // UPDATE so a failure cannot leave the campaign half-updated (e.g. renamed
  // but with a stale pinned wheel, or vice versa).
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The chosen game must be this creator's own playable game, so a campaign
  // can't be pointed at another creator's wheel id (or an archived/draft/bingo
  // game the resolver would silently skip).
  if (hasPin) {
    const pinError = await campaignPinError(sb, user.id, pinnedWheelId);
    if (pinError) return NextResponse.json({ error: pinError }, { status: statusFor(pinError) });
  }

  const patch: { name?: string; pinned_wheel_id?: string | null } = {};
  if (name !== undefined) patch.name = name;
  if (hasPin) patch.pinned_wheel_id = pinnedWheelId;

  // Nothing to change — preserve the original no-op success response.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { data: updated, error } = await sb
    .from("campaigns")
    .update(patch)
    .eq("id", id)
    .eq("creator_id", user.id)
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
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteCampaign(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
