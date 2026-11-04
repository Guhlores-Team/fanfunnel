import { NextResponse } from "next/server";
import { getMyTheme, setMyTheme } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { revalidateMyThemedPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// Settings › Public page › Look & feel (per-creator theming). Session client
// only: the signed-in creator reads and sets THEIR OWN headline font and
// background. The body carries theme keys and nothing else; any id in it is
// ignored, and set_creator_theme (0058) writes auth.uid()'s row only and takes
// a background photo only from that creator's own media.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "account/theme:GET");
  if (rateLimited) return rateLimited;
  const result = await getMyTheme();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "account/theme:PUT");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object" || Array.isArray(body)) return badRequest();
  const result = await setMyTheme({ font: body.font, background: body.background, bgMediaId: body.bgMediaId });
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyThemedPublicPage();
  return NextResponse.json(result);
}
