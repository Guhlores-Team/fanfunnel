import { NextResponse } from "next/server";
import { listWheelTemplates, createWheelTemplate } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";

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
