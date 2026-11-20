import { NextResponse } from "next/server";
import { deletePrizeTemplate } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Delete a saved prize preset.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "templates/prizes/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const result = await deletePrizeTemplate(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
