import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";

// Reject prize fields the data layer forwards without sanitizing. rarity drives
// the odds defaults, and imageUrl is rendered (and must not be a non-http(s)
// target). Color is intentionally not constrained here — it's freeform and the
// wheel renderer already guards invalid values safely.
function prizesValid(prizes: WheelConfig["prizes"]): boolean {
  if (prizes.length > 24) return false;
  return prizes.every(
    (p) =>
      p != null &&
      typeof p.label === "string" &&
      p.label.length <= 120 &&
      RARITY_ORDER.includes(p.rarity) &&
      Number.isFinite(p.weight) &&
      p.weight >= 0 &&
      p.weight <= 1e6 &&
      (p.imageUrl == null ||
        (typeof p.imageUrl === "string" && /^https?:\/\//i.test(p.imageUrl))),
  );
}

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
  if (!config || !Array.isArray(config.prizes) || !prizesValid(config.prizes)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await saveWheel(config);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
