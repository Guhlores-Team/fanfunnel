import { NextResponse } from "next/server";
import { listWheelTemplates, createWheelTemplate } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

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
    if (typeof c.title !== "string" || !Array.isArray(c.prizes)) {
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
