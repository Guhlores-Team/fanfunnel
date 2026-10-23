import { NextResponse } from "next/server";
import { deleteDmTemplate } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// Permanently delete one of the creator's saved DM templates.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteDmTemplate(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
