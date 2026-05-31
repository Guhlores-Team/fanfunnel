import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";

// Read the signed-in creator's wheel configuration.
export async function GET() {
  const wheel = await getWheel();
  if (!wheel) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ wheel });
}

// Save the creator's wheel (title, branding, prizes).
export async function PUT(req: Request) {
  let config: WheelConfig;
  try {
    const body = await req.json();
    config = body.wheel ?? body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!config || !Array.isArray(config.prizes)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await saveWheel(config);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
