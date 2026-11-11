import { NextResponse } from "next/server";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { setActiveWheelBrandColor } from "@/lib/data";
import { revalidateMyPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// Set the brand color of the creator's active wheel — the public /c/[slug] page
// derives its brand color from that wheel, so this drives the Settings → Public
// profile brand-color control. Validates a #rgb / #rrggbb hex.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "account/brand-color:PUT");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ color?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const color = typeof body.color === "string" ? body.color.trim() : "";
  if (!HEX.test(color)) return NextResponse.json({ error: "bad_color" }, { status: 400 });
  // PA-01: any valid hex is accepted. A very dark one stays visible on the fan
  // page because its buttons and focus rings paint --brand-ui (lifted to 3:1).

  const result = await setActiveWheelBrandColor(color);
  if ("error" in result) {
    const status =
      result.error === "unauthorized" ? 401 : result.error === "no_wheel" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  await revalidateMyPublicPage();
  return NextResponse.json({ ok: true, color });
}
