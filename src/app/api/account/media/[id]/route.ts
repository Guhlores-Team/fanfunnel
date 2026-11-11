import { NextResponse } from "next/server";
import { deleteMyMedia, setMyMediaCaption } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { revalidateMyThemedPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// One photo in the signed-in creator's hub: change its caption, or delete it.
// Session client + RLS: another creator's photo id is simply "not found".
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rateLimited = await limitRoute(req, "account/media/[id]:PATCH");
  if (rateLimited) return rateLimited;
  const { id } = await ctx.params;
  const body = await parseJsonBody<{ caption?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await setMyMediaCaption(id, body.caption);
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyThemedPublicPage();
  return NextResponse.json(result);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rateLimited = await limitRoute(req, "account/media/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await ctx.params;
  const result = await deleteMyMedia(id);
  if ("error" in result && result.error === "storage_cleanup_failed") return NextResponse.json({ error: result.error }, { status: 500 });
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyThemedPublicPage();
  return NextResponse.json(result);
}
