import { NextResponse } from "next/server";
import { listWheelTemplates, createWheelTemplate } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER, MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Full prize validation, mirroring the wheel save route (src/app/api/wheel
// /route.ts): rarity drives the odds defaults and imageUrl is rendered, so a
// malformed rarity/weight/imageUrl must be rejected here rather than stored on
// the template and later producing failed/missing prize inserts when a wheel is
// created from it.
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
        (typeof p.imageUrl === "string" && /^https?:\/\//i.test(p.imageUrl))),
  );
}

// The creator's saved wheel presets.
export async function GET() {
  const templates = await listWheelTemplates();
  return NextResponse.json({ templates });
}

// Save a wheel preset, sourced from an existing wheel or a provided config.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    name?: string;
    fromWheelId?: string;
    config?: WheelConfig;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const name = String(body.name ?? "").trim();
  if (!name || (!body.fromWheelId && !body.config)) {
    return badRequest();
  }
  // If a raw config is supplied (not sourced from an existing wheel), validate
  // its shape so a malformed payload returns 400 rather than throwing a TypeError.
  if (body.config && !body.fromWheelId) {
    const c = body.config;
    if (
      typeof c.title !== "string" ||
      !Array.isArray(c.prizes) ||
      !prizesValid(c.prizes)
    ) {
      return badRequest("bad_config");
    }
  }

  try {
    const template = await createWheelTemplate({
      name,
      fromWheelId: body.fromWheelId,
      config: body.config,
    });
    return NextResponse.json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    return errorResponse(message);
  }
}
