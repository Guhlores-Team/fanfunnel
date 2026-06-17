import { NextResponse } from "next/server";
import { setActiveWheelBrandColor } from "@/lib/data";

// Set the brand color of the creator's active wheel — the public /c/[slug] page
// derives its brand color from that wheel, so this drives the Settings → Public
// profile brand-color control. Validates a #rgb / #rrggbb hex.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function PUT(req: Request) {
  let body: { color?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const color = typeof body.color === "string" ? body.color.trim() : "";
  if (!HEX.test(color)) return NextResponse.json({ error: "bad_color" }, { status: 400 });

  const result = await setActiveWheelBrandColor(color);
  if ("error" in result) {
    const status =
      result.error === "unauthorized" ? 401 : result.error === "no_wheel" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, color });
}
