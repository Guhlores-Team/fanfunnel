import { NextResponse } from "next/server";
import { deleteDmTemplate } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Permanently delete one of the creator's saved DM templates.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "dm-templates/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const result = await deleteDmTemplate(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
