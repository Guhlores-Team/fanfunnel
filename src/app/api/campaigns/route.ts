import { NextResponse } from "next/server";
import { createCampaign, listCampaigns } from "@/lib/data";

// A creator's campaigns: named groupings of links they can compare against
// each other. Creator-scoped; newest first.
export async function GET() {
  const campaigns = await listCampaigns();
  return NextResponse.json({ campaigns });
}

export async function POST(req: Request) {
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createCampaign(name);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
