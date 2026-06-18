import { NextResponse } from "next/server";
import { listWheelTemplates, createWheelTemplate } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";

// Full prize validation, mirroring the wheel save route (src/app/api/wheel
// /route.ts): rarity drives the odds defaults and imageUrl is rendered, so a
// malformed rarity/weight/imageUrl must be rejected here rather than stored on
// the template and later producing failed/missing prize inserts when a wheel is
// created from it.
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

// The creator's saved wheel presets.
export async function GET() {
  const templates = await listWheelTemplates();
  return NextResponse.json({ templates });
}

// Save a wheel preset, sourced from an existing wheel or a provided config.
export async function POST(req: Request) {
  let body: { name?: string; fromWheelId?: string; config?: WheelConfig };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name || (!body.fromWheelId && !body.config)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
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
      return NextResponse.json({ error: "bad_config" }, { status: 400 });
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
    const status =
      message === "unauthorized" ? 401 : message === "no_source" ? 400 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
