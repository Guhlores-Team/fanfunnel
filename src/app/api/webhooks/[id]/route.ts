import { NextResponse } from "next/server";
import { deleteWebhook } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Delete one of the creator's registered webhooks.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "webhooks/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const result = await deleteWebhook(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
