import { NextResponse } from "next/server";
import { createCampaign, listCampaigns } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A creator's campaigns: named groupings of links they can compare against
// each other. Creator-scoped; newest first.
export async function GET() {
  const campaigns = await listCampaigns();
  return NextResponse.json({ campaigns });
}

export async function POST(req: Request) {
  const body = await parseJsonBody<{ name?: string; pinnedWheelId?: string | null }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const name = String(body.name ?? "").trim();
  if (!name || name.length > 120) {
    return badRequest();
  }

  const result = await createCampaign(name, body.pinnedWheelId ?? null);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
