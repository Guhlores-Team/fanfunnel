import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER, MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { badRequest, errorResponse } from "@/lib/api/handler";

// Reject prize fields the data layer forwards without sanitizing. rarity drives
// the odds defaults, and imageUrl is rendered (and must not be a non-http(s)
// target). Color is intentionally not constrained here — it's freeform and the
// wheel renderer already guards invalid values safely.
function prizesValid(prizes: WheelConfig["prizes"]): boolean {
  if (prizes.length > MAX_WHEEL_PRIZES) return false;
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
        (typeof p.imageUrl === "string" && isValidHttpUrl(p.imageUrl))),
  );
}

// Validate that a string is a well-formed http(s) URL. A weak regex can be
// bypassed or admit malformed URLs, so parse with the URL constructor and
// require an explicit http:/https: protocol.
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
    return badRequest();
  }
  if (!config || !Array.isArray(config.prizes) || !prizesValid(config.prizes)) {
    return badRequest();
  }

  const result = await saveWheel(config);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
