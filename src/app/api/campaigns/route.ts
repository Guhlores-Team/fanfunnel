import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { createCampaign, listActingCampaigns, listCampaigns } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// A creator's campaigns: named groupings of links they can compare against
// each other. Creator-scoped; newest first.
// A28: `?creatorId=<id>` lists the campaigns (and the games, for the picker)
// of a creator the caller's agency seat may manage; POST takes `creatorId` in
// the body to create one for them. Both are refused (403) without 'manage'.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "campaigns:GET");
  if (rateLimited) return rateLimited;
  const creatorId = new URL(req.url).searchParams.get("creatorId");
  if (creatorId !== null && creatorId.length > 64) return badRequest();
  return completeReadResponse(async () => {
    if (creatorId === null) {
      const campaigns = await listCampaigns();
      return NextResponse.json({ campaigns });
    }
    const result = await listActingCampaigns(creatorId);
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}

export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "campaigns:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ name?: string; pinnedWheelId?: string | null; creatorId?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const name = String(body.name ?? "").trim();
  if (!name || name.length > 120) {
    return badRequest();
  }

  // Optional: the game this campaign plays. Ownership and playability are
  // checked in createCampaign (campaignPinError); null follows the live game.
  if (body.pinnedWheelId != null && typeof body.pinnedWheelId !== "string") return badRequest();
  const result = await createCampaign(name, body.pinnedWheelId ?? null, body.creatorId);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
